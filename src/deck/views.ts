import type { Agent, Task } from "../state/types.js";
import type { DeckState, DeckNotification, DeckResult } from "./types.js";

const clip = (s: string, width: number): string => {
  const safeWidth = Math.max(0, width);
  if (safeWidth === 0) return "";
  if (s.length <= safeWidth) return s;
  if (safeWidth === 1) return "…";
  return `${s.slice(0, safeWidth - 1)}…`;
};

const stateIcon = (state: string): string =>
  ({
    provisioning: "…",
    starting: "↻",
    working: "▶",
    blocked: "!",
    failed: "×",
    succeeded: "✓",
    cancelled: "-",
    timed_out: "⌛",
    idle: "○",
    stopping: "↘",
    stopped: "■",
    orphaned: "?",
    replaced: "≠",
    draft: "·",
    queued: "…",
    assigned: "→",
    running: "▶",
    collecting: "…",
  })[state] ?? "·";

const pad = (s: string, n: number): string =>
  s.length >= n ? s : s + " ".repeat(n - s.length);

const fitLines = (lines: readonly string[], width: number): string[] =>
  lines.map((line) => clip(line, width));

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
    "State: ▶ working | ○ idle | ! blocked | × failed | ✓ succeeded | ? orphaned | ≠ replaced",
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
      lines.push(label);
      visit(agent.id, depth + 1);
    }
  };
  visit(undefined, 0);
  return fitLines(lines, width);
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
      `${stateIcon(task.state)} ${pad(task.state, 12)} ${pad(task.id, 27)} ${pad(task.title, 30)} ${assignee}${task.resultId ? ` result:${task.resultId}` : ""}`,
    );
  }
  if (tasks.length === 0) lines.push("No tasks match the current filter.");
  return fitLines(lines, width);
}

export function renderAgentInspector(
  agent: Agent | undefined,
  state: DeckState,
  width: number,
): string[] {
  if (!agent) return fitLines(["AGENT INSPECTOR", "No agent selected."], width);
  const run = agent.currentRunId
    ? state.runs.get(agent.currentRunId)
    : undefined;
  return fitLines(
    [
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
    ],
    width,
  );
}

export function renderTaskDetail(
  task: Task | undefined,
  state: DeckState,
  width: number,
): string[] {
  if (!task) return fitLines(["TASK DETAIL", "No task selected."], width);
  const run = task.currentRunId ? state.runs.get(task.currentRunId) : undefined;
  const result = task.resultId ? state.results.get(task.resultId) : undefined;
  return fitLines(
    [
      "TASK DETAIL",
      `ID: ${task.id}`,
      `State: ${stateIcon(task.state)} ${task.state}`,
      `Title: ${task.title}`,
      `Objective: ${task.objective}`,
      `Run: ${run?.id ?? "none"} (${run?.state ?? "none"})`,
      ...renderResultLines(result),
    ],
    width,
  );
}

export function renderResultDetail(
  result: DeckResult | undefined,
  width: number,
): string[] {
  return fitLines(["RESULT DETAIL", ...renderResultLines(result)], width);
}

function renderResultLines(result: DeckResult | undefined): string[] {
  if (!result) return ["Result: not available"];
  return [
    `Result: ${result.id}`,
    `Result status: ${result.status}`,
    `Summary: ${result.summary ?? "none"}`,
    `Evidence: ${result.evidence?.join(", ") ?? "none"}`,
    `Tests: ${result.tests?.join(", ") ?? "none"}`,
    `Artifacts: ${result.artifacts?.join(", ") ?? "none"}`,
    `Unresolved: ${result.unresolved?.join(", ") ?? "none"}`,
  ];
}

export function renderNotifications(
  notifications: readonly DeckNotification[],
  width: number,
): string[] {
  const lines = ["NOTIFICATIONS"];
  for (const item of notifications.slice(0, 8))
    lines.push(
      `${stateIcon(item.kind)} [${item.kind}] ${item.text} (event ${item.id}, seq ${item.seq})`,
    );
  return fitLines(lines, width);
}
