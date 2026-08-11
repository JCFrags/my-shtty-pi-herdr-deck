import { LIMITS } from "../shared/limits.js";
import type { Agent, Run, Task, Workflow } from "../state/types.js";
import type {
  DeckEvent,
  DeckNotification,
  DeckNotificationKind,
  DeckQuestion,
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
  questions: new Map(),
  results: new Map(),
});
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const array = <T>(value: unknown): T[] =>
  Array.isArray(value)
    ? (value as T[]).slice(0, LIMITS.maxCollectionItems)
    : [];
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
  questions: new Map(
    [...state.questions].map(([id, value]) => [
      id,
      { ...value, ...(value.options ? { options: [...value.options] } : {}) },
    ]),
  ),
  results: new Map(
    [...state.results].map(([id, value]) => [
      id,
      {
        ...value,
        ...(value.evidence ? { evidence: [...value.evidence] } : {}),
        ...(value.tests ? { tests: [...value.tests] } : {}),
        ...(value.artifacts ? { artifacts: [...value.artifacts] } : {}),
        ...(value.unresolved ? { unresolved: [...value.unresolved] } : {}),
      },
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
    for (const value of array<DeckQuestion>(snapshot.questions))
      if (idFrom(value.id))
        next.questions.set(value.id, {
          ...value,
          ...(value.options ? { options: array<string>(value.options) } : {}),
        });
    for (const value of array<DeckResult>(snapshot.results))
      if (idFrom(value.id))
        next.results.set(value.id, this.#normalizeResult(value));
    this.#state = next;
    this.#emit();
  }

  apply(event: DeckEvent): boolean {
    if (!Number.isSafeInteger(event.seq) || event.seq <= this.#state.seq)
      return false;
    const next = cloneState(this.#state);
    const refs = event.refs ?? {};
    const data = asRecord(event.data) ?? {};
    const agentId = idFrom(refs.agentId) ?? idFrom(data.agentId);
    const taskId = idFrom(refs.taskId) ?? idFrom(data.taskId);
    const runId = idFrom(refs.runId) ?? idFrom(data.runId);
    const workflowId = idFrom(refs.workflowId) ?? idFrom(data.workflowId);
    const entityId =
      agentId ?? taskId ?? runId ?? workflowId ?? idFrom(data.id);

    if (event.event === "task.created" && entityId)
      next.tasks.set(entityId, {
        id: entityId,
        title: String(data.title ?? entityId),
        objective: String(data.objective ?? ""),
        state: "queued",
        createdAt: String(data.createdAt ?? event.timestamp ?? ""),
      });
    else if (event.event === "task.state_changed" && taskId) {
      const item = next.tasks.get(taskId);
      if (item && typeof data.to === "string")
        next.tasks.set(item.id, { ...item, state: data.to as Task["state"] });
    } else if (event.event.startsWith("agent.") && agentId)
      this.#patchAgent(next, agentId, data, event.event);
    else if (event.event.startsWith("run.") && runId)
      this.#patchRun(next, runId, data);
    else if (event.event.startsWith("workflow.") && workflowId)
      this.#patchWorkflow(next, workflowId, data);
    else if (event.event.includes("question") || event.event === "task.blocked")
      this.#question(next, event, data, taskId, agentId);
    else if (event.event.includes("result"))
      this.#result(next, event, data, taskId, runId);

    next.seq = event.seq;
    this.#state = next;
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
  #question(
    state: DeckState,
    event: DeckEvent,
    data: Record<string, unknown>,
    taskId?: string,
    agentId?: string,
  ): void {
    const id = String(data.id ?? event.refs.questionId ?? event.id);
    const old = state.questions.get(id);
    state.questions.set(id, {
      ...old,
      id,
      ...(taskId ? { taskId } : {}),
      ...(agentId ? { agentId } : {}),
      prompt: String(
        data.prompt ??
          data.question ??
          old?.prompt ??
          "Blocked task requires attention.",
      ),
      ...(Array.isArray(data.options)
        ? { options: stringArray(data.options) }
        : {}),
      answered: data.answered === true || old?.answered === true,
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
      ...(value.evidence ? { evidence: stringArray(value.evidence) } : {}),
      ...(value.tests ? { tests: stringArray(value.tests) } : {}),
      ...(value.artifacts ? { artifacts: stringArray(value.artifacts) } : {}),
      ...(value.unresolved
        ? { unresolved: stringArray(value.unresolved) }
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
        ...(typeof data.summary === "string" ? { summary: data.summary } : {}),
        ...(data.evidence !== undefined
          ? { evidence: stringArray(data.evidence) }
          : {}),
        ...(data.tests !== undefined ? { tests: stringArray(data.tests) } : {}),
        ...(data.artifacts !== undefined
          ? { artifacts: stringArray(data.artifacts) }
          : {}),
        ...(data.unresolved !== undefined
          ? { unresolved: stringArray(data.unresolved) }
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
    this.#notifications.unshift({
      id: event.id,
      kind,
      seq: event.seq,
      text: String(data.message ?? data.summary ?? event.event),
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
    questions: array<DeckQuestion>(record.questions),
    results: array<DeckResult>(record.results),
  };
}
