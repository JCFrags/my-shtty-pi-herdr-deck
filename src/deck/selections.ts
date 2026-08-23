import type { Agent, Task, Run } from "../state/types.js";
import type { DeckQuestion, DeckResult, DeckState } from "./types.js";

export function sortedById<T extends { id: string }>(items: Iterable<T>): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

export function effectiveSelection<T extends { id: string }>(
  items: Iterable<T>,
  selectedId?: string,
): T | undefined {
  const sorted = sortedById(items);
  return (
    (selectedId ? sorted.find((item) => item.id === selectedId) : undefined) ??
    sorted[0]
  );
}

export function effectiveOrderedSelection<T extends { id: string }>(
  items: readonly T[],
  selectedId?: string,
): T | undefined {
  return (
    (selectedId ? items.find((item) => item.id === selectedId) : undefined) ??
    items[0]
  );
}

export type AgentListFilter = "active" | "idle" | "history";

export interface AgentListPresentation {
  matching: Agent[];
  matchingCount: number;
  pageCount: number;
  safePage: number;
  visible: Agent[];
  selected?: Agent;
  selectedIndex: number;
}

export function selectAgentListPresentation(
  agents: Iterable<Agent>,
  filter: AgentListFilter,
  requestedPage: number,
  selectedId?: string,
  pageSize = 12,
): AgentListPresentation {
  const active = new Set([
    "provisioning",
    "starting",
    "working",
    "blocked",
    "stopping",
  ]);
  const matching = [...agents]
    .filter((agent) =>
      filter === "active"
        ? active.has(agent.state)
        : filter === "idle"
          ? agent.state === "idle"
          : !active.has(agent.state) && agent.state !== "idle",
    )
    .sort((a, b) => b.id.localeCompare(a.id));
  const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
  const safePage = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const visible = matching.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );
  const selected = effectiveOrderedSelection(visible, selectedId);
  return {
    matching,
    matchingCount: matching.length,
    pageCount,
    safePage,
    visible,
    ...(selected ? { selected } : {}),
    selectedIndex: selected
      ? matching.findIndex((agent) => agent.id === selected.id)
      : -1,
  };
}

export function moveAgentListSelection(
  presentation: AgentListPresentation,
  delta: number,
  pageSize = 12,
): { selectedId?: string; page: number } {
  if (presentation.matching.length === 0) return { page: 0 };
  const current =
    presentation.selectedIndex < 0 ? 0 : presentation.selectedIndex;
  const index = Math.max(
    0,
    Math.min(presentation.matching.length - 1, current + delta),
  );
  const selectedId = presentation.matching[index]!.id;
  return { selectedId, page: Math.floor(index / pageSize) };
}

export interface TaskRowPresentation {
  current: Task[];
  history: Task[];
  visibleCurrent: Task[];
  visibleHistory: Task[];
}

export function selectTaskRowPresentation(
  state: DeckState,
): TaskRowPresentation {
  const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
  const tasks = sortedById(state.tasks.values());
  const current = tasks.filter((task) => !terminal.has(task.state));
  const history = tasks.filter((task) => terminal.has(task.state));
  return {
    current,
    history,
    visibleCurrent: current.slice(0, 10),
    visibleHistory: history.slice(0, 8),
  };
}

export function taskRowDependency(task: Task, state: DeckState): unknown {
  const run = task.currentRunId ? state.runs.get(task.currentRunId) : undefined;
  return {
    id: task.id,
    state: task.state,
    title: task.title,
    assignedAgentId: task.assignedAgentId,
    resultId: task.resultId,
    runAgentId: run?.agentId,
  };
}

export interface TaskDetailRelation {
  run?: Run;
  result?: DeckResult;
  question?: DeckQuestion;
}

export function selectTaskDetailRelation(
  task: Task | undefined,
  state: DeckState,
): TaskDetailRelation {
  if (!task) return {};
  const run = task.currentRunId ? state.runs.get(task.currentRunId) : undefined;
  const result =
    (task.resultId ? state.results.get(task.resultId) : undefined) ??
    sortedById(state.results.values()).find(
      (item) => item.taskId === task.id || (run && item.runId === run.id),
    );
  const question = sortedById(state.questions.values()).find(
    (item) =>
      !item.answered &&
      item.state !== "answered" &&
      (item.taskId === task.id || (run && item.runId === run.id)),
  );
  return {
    ...(run ? { run } : {}),
    ...(result ? { result } : {}),
    ...(question ? { question } : {}),
  };
}

export interface AgentInspectorRelation {
  run?: Run;
  task?: Task;
  result?: DeckResult;
  question?: DeckQuestion;
}

export function selectAgentInspectorRelation(
  agent: Agent | undefined,
  state: DeckState,
): AgentInspectorRelation {
  if (!agent) return {};
  const run = agent.currentRunId
    ? state.runs.get(agent.currentRunId)
    : undefined;
  const task = run
    ? state.tasks.get(run.taskId)
    : sortedById(state.tasks.values()).find(
        (item) => item.assignedAgentId === agent.id,
      );
  const result = sortedById(state.results.values()).find(
    (item) => item.taskId === task?.id || item.runId === run?.id,
  );
  const question = sortedById(state.questions.values()).find(
    (item) =>
      !item.answered &&
      item.state !== "answered" &&
      (item.agentId === agent.id ||
        item.taskId === task?.id ||
        item.runId === run?.id),
  );
  return {
    ...(run ? { run } : {}),
    ...(task ? { task } : {}),
    ...(result ? { result } : {}),
    ...(question ? { question } : {}),
  };
}
