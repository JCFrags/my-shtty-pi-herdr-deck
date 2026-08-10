import type { Agent, Task } from "../state/types.js";
import type { DeckState, DeckNotification } from "./types.js";
const clip = (s: string, width: number): string =>
  width <= 0
    ? ""
    : s.length <= width
      ? s
      : width === 1
        ? "…"
        : `${s.slice(0, width - 1)}…`;
const stateIcon = (state: string): string =>
  (
    ({
      working: "▶",
      blocked: "!",
      failed: "×",
      succeeded: "✓",
      cancelled: "-",
      idle: "○",
      stopped: "■",
      orphaned: "?",
      replaced: "≠",
    }) as Record<string, string>
  )[state] ?? "·";
const pad = (s: string, n: number): string =>
  s.length >= n ? s : s + " ".repeat(n - s.length);
export function renderAgents(
  state: DeckState,
  width: number,
  selectedId?: string,
): string[] {
  const agents = [...state.agents.values()];
  const children = new Map<string | undefined, Agent[]>();
  for (const agent of agents)
    children.set(agent.parentAgentId, [
      ...(children.get(agent.parentAgentId) ?? []),
      agent,
    ]);
  const lines = [
    "AGENTS",
    "State symbols: ▶ working  ○ idle  ! blocked  × failed  ? orphaned  ≠ replaced",
  ];
  const visit = (parent: string | undefined, depth: number): void => {
    for (const agent of [...(children.get(parent) ?? [])].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const marker = selectedId === agent.id ? ">" : " ";
      const task = agent.currentRunId
        ? `run:${agent.currentRunId}`
        : "no active run";
      const label = `${marker}${"  ".repeat(depth)}${stateIcon(agent.state)} ${pad(agent.displayName ?? agent.herdrName ?? agent.id, 20)} ${pad(agent.profileId ?? "default", 14)} ${clip(task, 24)} ${agent.coarseStatus ?? agent.state}`;
      lines.push(clip(label, width));
      visit(agent.id, depth + 1);
    }
  };
  visit(undefined, 0);
  return lines;
}
export function renderTasks(
  state: DeckState,
  width: number,
  filter?: string,
): string[] {
  const tasks = [...state.tasks.values()].filter(
    (task) => !filter || task.state === filter,
  );
  const lines = [
    "TASKS",
    "State  ID                         title                         assignee/result",
  ];
  for (const task of tasks.sort((a, b) => a.id.localeCompare(b.id))) {
    const run = task.currentRunId
      ? state.runs.get(task.currentRunId)
      : undefined;
    const assignee = run?.agentId ?? "unassigned";
    lines.push(
      clip(
        `${stateIcon(task.state)} ${pad(task.state, 12)} ${pad(task.id, 27)} ${pad(task.title, 30)} ${assignee}${task.resultId ? ` result:${task.resultId}` : ""}`,
        width,
      ),
    );
  }
  if (tasks.length === 0) lines.push("No tasks match the current filter.");
  return lines;
}
export function renderAgentInspector(
  agent: Agent | undefined,
  state: DeckState,
  _width: number,
): string[] {
  if (!agent) return ["AGENT INSPECTOR", "No agent selected."];
  const run = agent.currentRunId
    ? state.runs.get(agent.currentRunId)
    : undefined;
  return [
    "AGENT INSPECTOR",
    `Identity: ${agent.id}`,
    `State: ${stateIcon(agent.state)} ${agent.state}`,
    `Profile: ${agent.profileId ?? "default"}`,
    `Pane: ${agent.paneId ?? "unavailable"}`,
    `Workspace: ${agent.workspaceId ?? "unavailable"}`,
    `Task/run: ${run?.taskId ?? "none"} / ${run?.id ?? "none"}`,
    `Generation: ${agent.generation}`,
    `Current tool: ${agent.detectedKind ?? "unavailable"}`,
    "Actions: focus · interrupt · restart · stop · close",
    "Unavailable fields are shown as unavailable, not inferred.",
  ];
}
export function renderTaskDetail(
  task: Task | undefined,
  state: DeckState,
  width: number,
): string[] {
  if (!task) return ["TASK DETAIL", "No task selected."];
  const run = task.currentRunId ? state.runs.get(task.currentRunId) : undefined;
  const result = task.resultId ? state.results.get(task.resultId) : undefined;
  return [
    "TASK DETAIL",
    `ID: ${task.id}`,
    `State: ${stateIcon(task.state)} ${task.state}`,
    `Title: ${clip(task.title, width - 7)}`,
    `Objective: ${clip(task.objective, width - 11)}`,
    `Run: ${run?.id ?? "none"} (${run?.state ?? "none"})`,
    `Result: ${result?.id ?? "not available"}`,
    `Evidence: ${result?.evidence?.join(", ") ?? "none"}`,
    `Tests: ${result?.tests?.join(", ") ?? "none"}`,
    `Artifacts: ${result?.artifacts?.join(", ") ?? "none"}`,
    `Unresolved: ${result?.unresolved?.join(", ") ?? "none"}`,
  ].map((line) => clip(line, width));
}
export function renderNotifications(
  notifications: readonly DeckNotification[],
  width: number,
): string[] {
  const lines = ["NOTIFICATIONS"];
  for (const item of notifications.slice(0, 8))
    lines.push(
      clip(
        `${stateIcon(item.kind)} [${item.kind}] ${item.text} (event ${item.id}, seq ${item.seq})`,
        width,
      ),
    );
  return lines;
}
