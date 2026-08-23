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
