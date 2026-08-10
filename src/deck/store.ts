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
  Array.isArray(value) ? (value as T[]) : [];

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
    next.seq = snapshot.seq;
    for (const value of snapshot.agents)
      next.agents.set(value.id, { ...value });
    for (const value of snapshot.tasks) next.tasks.set(value.id, { ...value });
    for (const value of snapshot.runs ?? [])
      next.runs.set(value.id, { ...value });
    for (const value of snapshot.workflows)
      next.workflows.set(value.id, { ...value, taskIds: [...value.taskIds] });
    for (const value of snapshot.questions ?? [])
      next.questions.set(value.id, {
        ...value,
        ...(value.options ? { options: [...value.options] } : {}),
      });
    for (const value of snapshot.results ?? [])
      next.results.set(value.id, { ...value });
    this.#state = next;
    this.#emit();
  }

  apply(event: DeckEvent): boolean {
    if (!Number.isSafeInteger(event.seq) || event.seq <= this.#state.seq)
      return false;
    const refs = event.refs;
    const data = asRecord(event.data) ?? {};
    const entityId =
      refs.agentId ??
      refs.taskId ??
      refs.runId ??
      refs.workflowId ??
      String(data.id ?? "");
    if (event.event === "task.created" && entityId)
      this.#state.tasks.set(entityId, {
        id: entityId,
        title: String(data.title ?? entityId),
        objective: String(data.objective ?? ""),
        state: "queued",
        createdAt: String(data.createdAt ?? event.timestamp ?? ""),
      });
    else if (event.event === "task.state_changed" && refs.taskId) {
      const item = this.#state.tasks.get(refs.taskId);
      if (item && typeof data.to === "string")
        this.#state.tasks.set(item.id, {
          ...item,
          state: data.to as Task["state"],
        });
    } else if (event.event.startsWith("agent.") && refs.agentId)
      this.#patchAgent(refs.agentId, data, event.event);
    else if (event.event.startsWith("run.") && refs.runId)
      this.#patchRun(refs.runId, data);
    else if (event.event.startsWith("workflow.") && refs.workflowId)
      this.#patchWorkflow(refs.workflowId, data);
    else if (event.event.includes("question") || event.event === "task.blocked")
      this.#question(event, data);
    else if (event.event.includes("result")) this.#result(event, data);
    this.#state.seq = event.seq;
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

  #patchAgent(id: string, data: Record<string, unknown>, event: string): void {
    const old = this.#state.agents.get(id);
    if (!old) return;
    const state =
      typeof data.state === "string"
        ? (data.state as Agent["state"])
        : event === "agent.blocked"
          ? "blocked"
          : old.state;
    this.#state.agents.set(id, { ...old, ...(data as Partial<Agent>), state });
  }
  #patchRun(id: string, data: Record<string, unknown>): void {
    const old = this.#state.runs.get(id);
    if (old) this.#state.runs.set(id, { ...old, ...(data as Partial<Run>) });
  }
  #patchWorkflow(id: string, data: Record<string, unknown>): void {
    const old = this.#state.workflows.get(id);
    if (old)
      this.#state.workflows.set(id, { ...old, ...(data as Partial<Workflow>) });
  }
  #question(event: DeckEvent, data: Record<string, unknown>): void {
    const id = String(data.id ?? event.refs.questionId ?? event.id);
    this.#state.questions.set(id, {
      id,
      ...(event.refs.taskId ? { taskId: event.refs.taskId } : {}),
      ...(event.refs.agentId ? { agentId: event.refs.agentId } : {}),
      prompt: String(
        data.prompt ?? data.question ?? "Blocked task requires attention.",
      ),
      options: array<string>(data.options),
      answered: data.answered === true,
      ...(typeof data.timeoutAt === "string"
        ? { timeoutAt: data.timeoutAt }
        : {}),
    });
  }
  #result(event: DeckEvent, data: Record<string, unknown>): void {
    const id = String(data.id ?? event.refs.resultId ?? event.id);
    this.#state.results.set(id, {
      id,
      ...(event.refs.taskId ? { taskId: event.refs.taskId } : {}),
      ...(event.refs.runId ? { runId: event.refs.runId } : {}),
      status:
        data.status === "failed"
          ? "failed"
          : data.status === "missing"
            ? "missing"
            : "accepted",
      ...(typeof data.summary === "string" ? { summary: data.summary } : {}),
      evidence: array<string>(data.evidence),
      tests: array<string>(data.tests),
      artifacts: array<string>(data.artifacts),
      unresolved: array<string>(data.unresolved),
    });
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
  }
  #emit(): void {
    for (const listener of this.#listeners) listener(this.#state);
  }
}

export function snapshotFromBroker(value: unknown): DeckSnapshot {
  const record = asRecord(value) ?? {};
  return {
    seq: Number(record.seq ?? 0),
    agents: array<Agent>(record.agents),
    tasks: array<Task>(record.tasks),
    runs: array<Run>(record.runs),
    workflows: array<Workflow>(record.workflows),
    questions: array<DeckQuestion>(record.questions),
    results: array<DeckResult>(record.results),
  };
}
