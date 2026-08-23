import { LIMITS } from "../shared/limits.js";
import {
  validateProviderProjection,
  type ProviderProjection,
} from "../shared/provider-projections.js";
import type { Agent, Run, Task, Workflow } from "../state/types.js";
import type {
  DeckEvent,
  DeckGroup,
  DeckNotification,
  DeckNotificationKind,
  DeckQuestion,
  DeckQuestionOption,
  DeckResult,
  DeckSnapshot,
  DeckState,
} from "./types.js";

const empty = (): DeckState => ({
  seq: 0,
  agents: new Map(),
  tasks: new Map(),
  runs: new Map(),
  workflows: new Map(),
  groups: new Map(),
  questions: new Map(),
  results: new Map(),
  providerProjections: new Map(),
});
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const array = <T>(value: unknown): T[] =>
  Array.isArray(value)
    ? (value as T[]).slice(0, LIMITS.maxCollectionItems)
    : [];
const displayArray = (value: unknown): string[] =>
  array<unknown>(value).flatMap((item) => {
    if (typeof item === "string") return [item];
    const record = asRecord(item);
    if (!record) return [];
    const parts = [
      idFrom(record.title),
      idFrom(record.description),
      idFrom(record.command),
      idFrom(record.path),
      idFrom(record.subject),
      idFrom(record.status),
      idFrom(record.evidence),
    ].filter((part): part is string => part !== undefined);
    return parts.length > 0 ? [parts.join(" — ")] : [];
  });
const stringArray = (value: unknown): string[] =>
  array<unknown>(value).filter(
    (item): item is string => typeof item === "string",
  );
const idFrom = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const cloneState = (state: DeckState): DeckState => ({
  seq: state.seq,
  agents: new Map([...state.agents].map(([id, value]) => [id, { ...value }])),
  tasks: new Map([...state.tasks].map(([id, value]) => [id, { ...value }])),
  runs: new Map([...state.runs].map(([id, value]) => [id, { ...value }])),
  workflows: new Map(
    [...state.workflows].map(([id, value]) => [
      id,
      { ...value, taskIds: [...value.taskIds] },
    ]),
  ),
  groups: new Map(
    [...state.groups].map(([id, value]) => [
      id,
      {
        ...value,
        ...(value.agentIds ? { agentIds: [...value.agentIds] } : {}),
        ...(value.taskIds ? { taskIds: [...value.taskIds] } : {}),
        ...(value.runIds ? { runIds: [...value.runIds] } : {}),
        ...(value.questionIds ? { questionIds: [...value.questionIds] } : {}),
        ...(value.resultIds ? { resultIds: [...value.resultIds] } : {}),
      },
    ]),
  ),
  questions: new Map(
    [...state.questions].map(([id, value]) => [
      id,
      {
        ...value,
        ...(value.options
          ? { options: value.options.map((option) => ({ ...option })) }
          : {}),
      },
    ]),
  ),
  results: new Map(
    [...state.results].map(([id, value]) => [
      id,
      {
        ...value,
        ...(value.evidence ? { evidence: [...value.evidence] } : {}),
        ...(value.findings ? { findings: [...value.findings] } : {}),
        ...(value.tests ? { tests: [...value.tests] } : {}),
        ...(value.artifacts ? { artifacts: [...value.artifacts] } : {}),
        ...(value.unresolved ? { unresolved: [...value.unresolved] } : {}),
      },
    ]),
  ),
  providerProjections: new Map(
    [...state.providerProjections].map(([id, value]) => [
      id,
      structuredClone(value),
    ]),
  ),
});

export class DeckStore {
  #state: DeckState = empty();
  #notifications: DeckNotification[] = [];
  #seenNotifications = new Set<string>();
  #listeners = new Set<(state: DeckState) => void>();

  get state(): DeckState {
    return this.#state;
  }
  get notifications(): readonly DeckNotification[] {
    return this.#notifications;
  }
  onChange(listener: (state: DeckState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  replace(snapshot: DeckSnapshot): void {
    const next = empty();
    next.seq =
      Number.isSafeInteger(snapshot.seq) && snapshot.seq >= 0
        ? snapshot.seq
        : 0;
    for (const value of array<Agent>(snapshot.agents))
      if (idFrom(value.id)) next.agents.set(value.id, { ...value });
    for (const value of array<Task>(snapshot.tasks))
      if (idFrom(value.id)) next.tasks.set(value.id, { ...value });
    for (const value of array<Run>(snapshot.runs))
      if (idFrom(value.id)) next.runs.set(value.id, { ...value });
    for (const value of array<Workflow>(snapshot.workflows))
      if (idFrom(value.id))
        next.workflows.set(value.id, {
          ...value,
          taskIds: array<string>(value.taskIds),
        });
    for (const value of array<DeckGroup>(snapshot.groups))
      if (idFrom(value.id))
        next.groups.set(value.id, {
          ...value,
          ...(value.agentIds
            ? { agentIds: array<string>(value.agentIds) }
            : {}),
          ...(value.taskIds ? { taskIds: array<string>(value.taskIds) } : {}),
          ...(value.runIds ? { runIds: array<string>(value.runIds) } : {}),
          ...(value.questionIds
            ? { questionIds: array<string>(value.questionIds) }
            : {}),
          ...(value.resultIds
            ? { resultIds: array<string>(value.resultIds) }
            : {}),
        });
    for (const value of array<DeckQuestion>(snapshot.questions))
      if (idFrom(value.id))
        next.questions.set(value.id, {
          ...value,
          ...(value.options
            ? { options: value.options.map((option) => ({ ...option })) }
            : {}),
        });
    for (const value of array<DeckResult>(snapshot.results))
      if (idFrom(value.id))
        next.results.set(value.id, this.#normalizeResult(value));
    for (const value of array<ProviderProjection>(snapshot.providerProjections))
      try {
        next.providerProjections.set(
          value.ownerAgentId,
          validateProviderProjection(value),
        );
      } catch {
        // Ignore an invalid optional provider projection.
      }
    this.#state = next;
    this.#emit();
  }

  apply(event: DeckEvent): boolean {
    if (event.event === "presentation.projection.changed") {
      const data = asRecord(event.data) ?? {};
      const ownerAgentId = idFrom(data.ownerAgentId ?? event.refs?.agentId);
      if (!ownerAgentId) return false;
      const next = cloneState(this.#state);
      if (data.projection === null)
        next.providerProjections.delete(ownerAgentId);
      else {
        try {
          const projection = validateProviderProjection(data.projection);
          if (projection.ownerAgentId !== ownerAgentId) return false;
          const current = this.#state.providerProjections.get(ownerAgentId);
          if (current && JSON.stringify(current) === JSON.stringify(projection))
            return true;
          next.providerProjections.set(ownerAgentId, projection);
        } catch {
          return false;
        }
      }
      this.#state = next;
      this.#emit();
      return true;
    }
    if (!Number.isSafeInteger(event.seq) || event.seq <= this.#state.seq)
      return false;
    const next = cloneState(this.#state);
    const refs = event.refs ?? {};
    const data = asRecord(event.data) ?? {};
    const agentId = idFrom(refs.agentId) ?? idFrom(data.agentId);
    const taskId = idFrom(refs.taskId) ?? idFrom(data.taskId);
    const runId = idFrom(refs.runId) ?? idFrom(data.runId);
    const workflowId = idFrom(refs.workflowId) ?? idFrom(data.workflowId);
    const groupId = idFrom(refs.groupId) ?? idFrom(data.groupId);
    const entityId =
      agentId ?? taskId ?? runId ?? workflowId ?? groupId ?? idFrom(data.id);

    if (event.event === "task.created" && entityId)
      next.tasks.set(entityId, {
        id: entityId,
        title: String(data.title ?? entityId),
        objective: String(data.objective ?? ""),
        state: "queued",
        createdAt: String(data.createdAt ?? event.timestamp ?? ""),
      });
    else if (event.event === "task.collected" && taskId) {
      const item = next.tasks.get(taskId);
      if (item && typeof data.collectedAt === "string") {
        const updated = { ...item, resultCollectedAt: data.collectedAt };
        next.tasks.set(item.id, updated);
        if (updated.assignedAgentId) {
          const agent = next.agents.get(updated.assignedAgentId);
          if (
            agent &&
            (agent.lifecycleClass ?? "temporary") === "temporary" &&
            !agent.keepForReuse &&
            agent.state !== "blocked"
          )
            next.agents.set(agent.id, {
              ...agent,
              closeRecommendation: "close",
              closeReason:
                "The temporary task is complete and its result was collected.",
            });
        }
      }
    } else if (event.event === "task.state_changed" && taskId) {
      const item = next.tasks.get(taskId);
      if (item && typeof data.to === "string")
        next.tasks.set(item.id, { ...item, state: data.to as Task["state"] });
    } else if (event.event.startsWith("agent.") && agentId)
      this.#patchAgent(next, agentId, data, event.event);
    else if (event.event.startsWith("run.") && runId)
      this.#patchRun(next, runId, data);
    else if (event.event.startsWith("workflow.") && workflowId)
      this.#patchWorkflow(next, workflowId, data);
    else if (event.event.startsWith("group.") && groupId)
      this.#patchGroup(next, groupId, data);
    else if (event.event.includes("question") || event.event === "task.blocked")
      this.#question(next, event, data, taskId, runId, agentId);
    else if (event.event.includes("result"))
      this.#result(next, event, data, taskId, runId);

    next.seq = event.seq;
    const heartbeatStateChanged =
      event.event === "agent.heartbeat" && agentId
        ? this.#state.agents.get(agentId)?.state !==
          next.agents.get(agentId)?.state
        : false;
    this.#state = next;
    if (event.event === "agent.heartbeat" && !heartbeatStateChanged)
      return true;
    this.#notify(event, data);
    this.#emit();
    return true;
  }

  applyReplay(events: readonly DeckEvent[]): number {
    let count = 0;
    for (const event of [...events].sort((a, b) => a.seq - b.seq))
      if (this.apply(event)) count++;
    return count;
  }
  clearNotifications(): void {
    this.#notifications = [];
    this.#emit();
  }
  reset(): void {
    this.#state = empty();
    this.#notifications = [];
    this.#seenNotifications.clear();
    this.#emit();
  }

  #patchAgent(
    state: DeckState,
    id: string,
    data: Record<string, unknown>,
    event: string,
  ): void {
    const old = state.agents.get(id);
    if (!old) return;
    const stateValue =
      typeof data.state === "string"
        ? (data.state as Agent["state"])
        : event === "agent.blocked"
          ? "blocked"
          : old.state;
    state.agents.set(id, {
      ...old,
      ...(data as Partial<Agent>),
      state: stateValue,
    });
  }
  #patchRun(state: DeckState, id: string, data: Record<string, unknown>): void {
    const old = state.runs.get(id);
    if (old) state.runs.set(id, { ...old, ...(data as Partial<Run>) });
  }
  #patchWorkflow(
    state: DeckState,
    id: string,
    data: Record<string, unknown>,
  ): void {
    const old = state.workflows.get(id);
    if (old)
      state.workflows.set(id, {
        ...old,
        ...(data as Partial<Workflow>),
        ...(Array.isArray(data.taskIds)
          ? { taskIds: array<string>(data.taskIds) }
          : {}),
      });
  }
  #patchGroup(
    state: DeckState,
    id: string,
    data: Record<string, unknown>,
  ): void {
    const old = state.groups.get(id);
    const next = { ...(old ?? { id, state: "unknown" }), ...data } as DeckGroup;
    state.groups.set(id, {
      ...next,
      id,
      state: typeof data.state === "string" ? data.state : next.state,
      ...(Array.isArray(data.agentIds)
        ? { agentIds: stringArray(data.agentIds) }
        : {}),
      ...(Array.isArray(data.taskIds)
        ? { taskIds: stringArray(data.taskIds) }
        : {}),
      ...(Array.isArray(data.questionIds)
        ? { questionIds: stringArray(data.questionIds) }
        : {}),
      ...(Array.isArray(data.resultIds)
        ? { resultIds: stringArray(data.resultIds) }
        : {}),
    });
  }
  #question(
    state: DeckState,
    event: DeckEvent,
    data: Record<string, unknown>,
    taskId?: string,
    runId?: string,
    agentId?: string,
  ): void {
    const id = String(data.id ?? event.refs.questionId ?? event.id);
    const old = state.questions.get(id);
    const body = asRecord(data.payload) ?? {};
    const terminalState =
      event.event === "question.answered"
        ? "answered"
        : event.event === "question.timed_out"
          ? "timed_out"
          : event.event === "question.cancelled"
            ? "cancelled"
            : undefined;
    state.questions.set(id, {
      ...old,
      id,
      ...(taskId ? { taskId } : {}),
      ...(runId ? { runId } : {}),
      ...(agentId ? { agentId } : {}),
      prompt: String(
        data.prompt ??
          data.question ??
          body.prompt ??
          body.question ??
          old?.prompt ??
          "Blocked task requires attention.",
      ),
      ...(Array.isArray(data.options ?? body.options)
        ? { options: normalizeQuestionOptions(data.options ?? body.options) }
        : {}),
      ...(body.allowFreeform === true ? { allowFreeform: true } : {}),
      ...(terminalState
        ? { state: terminalState }
        : old?.state
          ? { state: old.state }
          : { state: "open" }),
      answered:
        data.answered === true ||
        terminalState === "answered" ||
        old?.answered === true,
      ...(typeof data.timeoutAt === "string"
        ? { timeoutAt: data.timeoutAt }
        : old?.timeoutAt
          ? { timeoutAt: old.timeoutAt }
          : {}),
    });
  }
  #normalizeResult(value: DeckResult): DeckResult {
    return {
      ...value,
      status:
        value.status === "failed" ||
        value.status === "missing" ||
        value.status === "pending"
          ? value.status
          : "accepted",
      ...(value.evidence ? { evidence: displayArray(value.evidence) } : {}),
      ...(value.findings ? { findings: displayArray(value.findings) } : {}),
      ...(value.tests ? { tests: displayArray(value.tests) } : {}),
      ...(value.artifacts ? { artifacts: displayArray(value.artifacts) } : {}),
      ...(value.unresolved
        ? { unresolved: displayArray(value.unresolved) }
        : {}),
    };
  }
  #result(
    state: DeckState,
    event: DeckEvent,
    data: Record<string, unknown>,
    taskId?: string,
    runId?: string,
  ): void {
    const id = String(data.id ?? event.refs.resultId ?? event.id);
    const old = state.results.get(id);
    const body = asRecord(data.payload) ?? {};
    state.results.set(
      id,
      this.#normalizeResult({
        ...old,
        id,
        ...(taskId ? { taskId } : {}),
        ...(runId ? { runId } : {}),
        status:
          data.status === "failed"
            ? "failed"
            : data.status === "missing"
              ? "missing"
              : data.status === "pending"
                ? "pending"
                : "accepted",
        ...(typeof (data.summary ?? body.summary) === "string"
          ? { summary: String(data.summary ?? body.summary) }
          : {}),
        ...(data.evidence !== undefined || body.evidence !== undefined
          ? { evidence: displayArray(data.evidence ?? body.evidence) }
          : {}),
        ...(data.findings !== undefined || body.findings !== undefined
          ? { findings: displayArray(data.findings ?? body.findings) }
          : {}),
        ...(data.tests !== undefined || body.tests !== undefined
          ? { tests: displayArray(data.tests ?? body.tests) }
          : {}),
        ...(data.artifacts !== undefined || body.artifacts !== undefined
          ? { artifacts: displayArray(data.artifacts ?? body.artifacts) }
          : {}),
        ...(data.unresolved !== undefined || body.unresolved !== undefined
          ? { unresolved: displayArray(data.unresolved ?? body.unresolved) }
          : {}),
      }),
    );
  }
  #notify(event: DeckEvent, data: Record<string, unknown>): void {
    let kind: DeckNotificationKind | undefined;
    if (event.event.includes("question") || event.event === "task.blocked")
      kind = "blocked";
    else if (event.event.includes("budget")) kind = "budget";
    else if (event.event.includes("timeout")) kind = "timeout";
    else if (event.event.includes("failed") || data.state === "failed")
      kind = "failure";
    else if (event.event.includes("result")) kind = "result";
    else if (event.event.includes("recover")) kind = "recovery";
    if (!kind || this.#seenNotifications.has(event.id)) return;
    this.#seenNotifications.add(event.id);
    const body = asRecord(data.payload) ?? {};
    this.#notifications.unshift({
      id: event.id,
      kind,
      seq: event.seq,
      text: String(
        data.message ??
          data.reason ??
          data.summary ??
          data.prompt ??
          body.message ??
          body.summary ??
          body.prompt ??
          event.event,
      ),
    });
    this.#notifications = this.#notifications.slice(0, 32);
    while (this.#seenNotifications.size > 64) {
      const first = this.#seenNotifications.values().next().value;
      if (first === undefined) break;
      this.#seenNotifications.delete(first);
    }
  }
  #emit(): void {
    for (const listener of this.#listeners) listener(this.#state);
  }
}

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function normalizeQuestionOptions(value: unknown): DeckQuestionOption[] {
  return array<unknown>(value).flatMap((item, index) => {
    if (typeof item === "string") return [{ id: item, label: item }];
    const option = asRecord(item);
    if (!option) return [];
    const id =
      idFrom(option.id) ?? idFrom(option.optionId) ?? String(index + 1);
    const label =
      idFrom(option.label) ?? idFrom(option.text) ?? idFrom(option.title) ?? id;
    return [{ id, label }];
  });
}

function normalizeQuestion(value: unknown): DeckQuestion | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const id = idFrom(source.id);
  if (!id) return undefined;
  const payload = asRecord(source.payload) ?? {};
  const state = typeof source.state === "string" ? source.state : undefined;
  const question: DeckQuestion = {
    id,
    prompt: String(
      source.prompt ??
        payload.prompt ??
        payload.question ??
        "Question details are unavailable.",
    ),
    answered: source.answered === true || state === "answered",
  };
  for (const key of ["taskId", "runId", "agentId", "timeoutAt"] as const) {
    const field = idFrom(source[key]);
    if (field) question[key] = field;
  }
  if (
    state === "open" ||
    state === "answered" ||
    state === "cancelled" ||
    state === "timed_out"
  )
    question.state = state;
  const options = normalizeQuestionOptions(source.options ?? payload.options);
  if (options.length > 0) question.options = options;
  if (source.allowFreeform === true || payload.allowFreeform === true)
    question.allowFreeform = true;
  return question;
}

function normalizeResult(value: unknown): DeckResult | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const id = idFrom(source.id);
  if (!id) return undefined;
  const payload = asRecord(source.payload) ?? {};
  const rawStatus = source.status ?? payload.status;
  const result: DeckResult = {
    id,
    status:
      rawStatus === "failed"
        ? "failed"
        : rawStatus === "missing"
          ? "missing"
          : rawStatus === "pending"
            ? "pending"
            : "accepted",
  };
  for (const key of ["taskId", "runId"] as const) {
    const field = idFrom(source[key]);
    if (field) result[key] = field;
  }
  const summary = idFrom(source.summary) ?? idFrom(payload.summary);
  if (summary) result.summary = summary;
  for (const key of [
    "evidence",
    "findings",
    "tests",
    "artifacts",
    "unresolved",
  ] as const) {
    const items = displayArray(source[key] ?? payload[key]);
    if (items.length > 0) result[key] = items;
  }
  return result;
}

function normalizeGroup(value: unknown): DeckGroup | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const id = idFrom(source.id) ?? idFrom(source.groupId);
  if (!id) return undefined;
  const group: DeckGroup = {
    id,
    state: idFrom(source.state) ?? idFrom(source.status) ?? "unknown",
  };
  for (const key of [
    "name",
    "title",
    "parentAgentId",
    "objective",
    "blockedReason",
  ] as const) {
    const field = idFrom(source[key]);
    if (field) group[key] = field;
  }
  for (const key of [
    "agentIds",
    "taskIds",
    "questionIds",
    "resultIds",
  ] as const) {
    const items = stringArray(source[key]);
    if (items.length > 0) group[key] = items;
  }
  return group;
}

export function snapshotFromBroker(value: unknown): DeckSnapshot {
  const record = asRecord(value) ?? {};
  return {
    seq:
      Number.isSafeInteger(record.seq) && Number(record.seq) >= 0
        ? Number(record.seq)
        : 0,
    agents: array<Agent>(record.agents),
    tasks: array<Task>(record.tasks),
    runs: array<Run>(record.runs),
    workflows: array<Workflow>(record.workflows),
    groups: array<unknown>(record.groups).map(normalizeGroup).filter(present),
    questions: array<unknown>(record.questions)
      .map(normalizeQuestion)
      .filter(present),
    results: array<unknown>(record.results)
      .map(normalizeResult)
      .filter(present),
    providerProjections: array<unknown>(record.providerProjections).flatMap(
      (value) => {
        try {
          return [validateProviderProjection(value)];
        } catch {
          return [];
        }
      },
    ),
  };
}
