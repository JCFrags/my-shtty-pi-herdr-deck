import type { Agent, Task } from "../state/types.js";
import type {
  DeckGroup,
  DeckNotification,
  DeckQuestion,
  DeckResult,
  DeckState,
} from "./types.js";

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
    closed: "■",
    orphaned: "?",
    replaced: "≠",
    draft: "·",
    queued: "…",
    assigned: "→",
    running: "▶",
    collecting: "…",
    open: "!",
    answered: "✓",
  })[state] ?? "·";

const pad = (s: string, n: number): string =>
  s.length >= n ? s : s + " ".repeat(n - s.length);
const fitLines = (lines: readonly string[], width: number): string[] =>
  lines.map((line) => clip(line, width));
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (...values: unknown[]): string | undefined =>
  values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

export interface DeckModelChoice {
  provider: string;
  id: string;
  name?: string;
}

function modelText(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  const item = record(value);
  const provider = text(item.provider);
  const id = text(item.id, item.modelId);
  return provider && id ? `${provider}/${id}` : id;
}

export function getAgentModelChoices(
  agent: Agent | undefined,
): DeckModelChoice[] {
  const item = record(agent);
  const raw = item.modelChoices ?? item.availableModels;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const choice = record(value);
    const provider = text(choice.provider);
    const id = text(choice.id, choice.modelId);
    const name = text(choice.name);
    return provider && id ? [{ provider, id, ...(name ? { name } : {}) }] : [];
  });
}

export function getAgentThinkingChoices(agent: Agent | undefined): string[] {
  const item = record(agent);
  const raw = item.allowedThinkingLevels ?? item.thinkingChoices;
  return Array.isArray(raw)
    ? raw.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : [];
}

function questionForAgent(
  agent: Agent,
  state: DeckState,
): DeckQuestion | undefined {
  return [...state.questions.values()].find(
    (question) =>
      question.agentId === agent.id &&
      !question.answered &&
      question.state !== "answered",
  );
}

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
    "State  name                 profile        placement                    model / thinking     task/status",
  ];
  const visited = new Set<string>();
  const visit = (parent: string | undefined, depth: number): void => {
    for (const agent of [...(children.get(parent) ?? [])].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      if (visited.has(agent.id)) continue;
      visited.add(agent.id);
      const marker = selectedId === agent.id ? ">" : " ";
      const meta = record(agent);
      const actual = record(meta.actualModel);
      const effective = record(meta.effectiveModel);
      const actualModel =
        modelText(actual ?? effective ?? meta.model) ?? "unavailable";
      const thinking =
        text(actual?.thinkingLevel, effective?.thinkingLevel) ?? "unavailable";
      const placement = `${agent.workspaceId ?? "-"}/${agent.tabId ?? "-"}/${agent.paneId ?? "-"}`;
      const task = agent.currentRunId ? `run:${agent.currentRunId}` : "no run";
      lines.push(
        `${marker}${"  ".repeat(depth)}${stateIcon(agent.state)} ${pad(agent.displayName ?? agent.herdrName ?? agent.id, 20)} ${pad(agent.profileId ?? "default", 14)} ${pad(clip(placement, 28), 28)} ${pad(clip(`${actualModel} / ${thinking}`, 20), 20)} ${task} ${agent.coarseStatus ?? agent.state}`,
      );
      visit(agent.id, depth + 1);
    }
  };
  visit(undefined, 0);
  for (const agent of agents.sort((a, b) => a.id.localeCompare(b.id)))
    if (!visited.has(agent.id)) {
      children.set(undefined, [agent]);
      visit(undefined, 0);
    }
  if (agents.length === 0) lines.push("No agents are visible.");
  return fitLines(lines, width);
}

export function renderGroups(
  state: DeckState,
  width: number,
  selectedId?: string,
): string[] {
  const lines = [
    "GROUPS",
    "State  ID                         name                         agents tasks",
  ];
  for (const group of [...state.groups.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const marker = selectedId === group.id ? ">" : " ";
    lines.push(
      `${marker}${stateIcon(group.state)} ${pad(group.id, 27)} ${pad(group.name ?? group.title ?? "unnamed", 28)} ${(group.agentIds ?? []).length} ${(group.taskIds ?? []).length}`,
    );
  }
  if (state.groups.size === 0) lines.push("No groups are visible.");
  return fitLines(lines, width);
}

export function renderGroupDetail(
  group: DeckGroup | undefined,
  width: number,
): string[] {
  if (!group) return fitLines(["GROUP DETAIL", "No group selected."], width);
  return fitLines(
    [
      "GROUP DETAIL",
      `ID: ${group.id}`,
      `Name: ${group.name ?? group.title ?? "unavailable"}`,
      `State: ${stateIcon(group.state)} ${group.state}`,
      `Objective: ${group.objective ?? "unavailable"}`,
      `Parent agent: ${group.parentAgentId ?? "none"}`,
      `Agents: ${group.agentIds?.join(", ") || "none"}`,
      `Tasks: ${group.taskIds?.join(", ") || "none"}`,
      `Questions: ${group.questionIds?.join(", ") || "none"}`,
      `Results: ${group.resultIds?.join(", ") || "none"}`,
      `Blocked reason: ${group.blockedReason ?? "none"}`,
    ],
    width,
  );
}

export function renderTasks(
  state: DeckState,
  width: number,
  filter?: string,
  selectedId?: string,
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
    const assignee = task.assignedAgentId ?? run?.agentId ?? "unassigned";
    const marker = selectedId === task.id ? ">" : " ";
    lines.push(
      `${marker}${stateIcon(task.state)} ${pad(task.state, 12)} ${pad(task.id, 27)} ${pad(task.title, 30)} ${assignee}${task.resultId ? ` result:${task.resultId}` : ""}`,
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
  if (!agent) return fitLines(["AGENT DETAIL", "No agent selected."], width);
  const run = agent.currentRunId
    ? state.runs.get(agent.currentRunId)
    : undefined;
  const task = run
    ? state.tasks.get(run.taskId)
    : [...state.tasks.values()].find(
        (item) => item.assignedAgentId === agent.id,
      );
  const meta = record(agent);
  const requested = record(meta.requestedModel);
  const effective = record(meta.effectiveModel);
  const actual = record(meta.actualModel);
  const requestedModel =
    modelText(requested) ?? text(requested?.profileId) ?? "placement default";
  const effectiveModel = modelText(effective) ?? "unavailable";
  const actualModel = modelText(actual ?? meta.model) ?? "unavailable";
  const requestedThinking =
    text(
      requested?.thinkingLevel,
      effective?.thinkingLevel,
      meta.requestedThinking,
      meta.requestedThinkingLevel,
    ) ?? "unavailable";
  const actualThinking =
    text(actual?.thinkingLevel, meta.actualThinking, meta.thinkingLevel) ??
    "unavailable";
  const blocked =
    text(meta.blockedReason) ??
    questionForAgent(agent, state)?.prompt ??
    (agent.state === "blocked" ? "unavailable" : "none");
  return fitLines(
    [
      "AGENT DETAIL",
      `Identity: ${agent.id} (generation ${agent.generation})`,
      `State: ${stateIcon(agent.state)} ${agent.state}; detected: ${agent.coarseStatus ?? "unavailable"}`,
      `Profile: ${agent.profileId ?? "default"}`,
      `Placement: workspace ${agent.workspaceId ?? "unavailable"}; tab ${agent.tabId ?? "unavailable"}; pane ${agent.paneId ?? "unavailable"}`,
      `Terminal/session: ${agent.terminalId ?? "unavailable"} / ${agent.piSessionId ?? "unavailable"}`,
      `CWD/worktree: ${agent.cwd ?? "unavailable"} / ${agent.worktreeId ?? "unavailable"}`,
      `Requested model: ${requestedModel}`,
      `Effective model: ${effectiveModel}`,
      `Actual model: ${actualModel}`,
      `Thinking requested/actual: ${requestedThinking} / ${actualThinking}`,
      `Task: ${task?.id ?? run?.taskId ?? "none"} ${task ? `(${task.title}; ${task.state})` : ""}`,
      `Run: ${run?.id ?? agent.currentRunId ?? "none"} (${run?.state ?? "unavailable"})`,
      `Blocked reason: ${blocked}`,
      `Current tool: ${text(meta.currentTool, agent.detectedKind) ?? "unavailable"}`,
      "Actions: p prompt · a ask · i interrupt · s stop · x close · f focus · m model · t thinking",
      "Unavailable fields are not inferred.",
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
  const result = task.resultId
    ? state.results.get(task.resultId)
    : [...state.results.values()].find((item) => item.taskId === task.id);
  const question = [...state.questions.values()].find(
    (item) => item.taskId === task.id && !item.answered,
  );
  return fitLines(
    [
      "TASK DETAIL",
      `ID: ${task.id}`,
      `State: ${stateIcon(task.state)} ${task.state}`,
      `Title: ${task.title}`,
      `Objective: ${task.objective}`,
      `Assignee: ${task.assignedAgentId ?? run?.agentId ?? "unassigned"}`,
      `Run: ${run?.id ?? task.currentRunId ?? "none"} (${run?.state ?? "unavailable"})`,
      `Blocked reason: ${question?.prompt ?? (task.state === "blocked" ? "unavailable" : "none")}`,
      ...renderResultLines(result),
    ],
    width,
  );
}

export function renderQuestions(
  questions: readonly DeckQuestion[],
  width: number,
  selectedId?: string,
): string[] {
  const lines = [
    "QUESTIONS",
    "State  ID                         task/agent                    prompt",
  ];
  for (const question of [...questions].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const status = question.state ?? (question.answered ? "answered" : "open");
    const marker = selectedId === question.id ? ">" : " ";
    lines.push(
      `${marker}${stateIcon(status)} ${pad(question.id, 27)} ${pad(question.taskId ?? question.agentId ?? "unbound", 29)} ${question.prompt}`,
    );
  }
  if (questions.length === 0) lines.push("No questions are visible.");
  return fitLines(lines, width);
}

export function renderQuestionDetail(
  question: DeckQuestion | undefined,
  width: number,
): string[] {
  if (!question)
    return fitLines(["QUESTION DETAIL", "No question selected."], width);
  const status = question.state ?? (question.answered ? "answered" : "open");
  return fitLines(
    [
      "QUESTION DETAIL",
      `ID: ${question.id}`,
      `State: ${status}`,
      `Task/run/agent: ${question.taskId ?? "none"} / ${question.runId ?? "none"} / ${question.agentId ?? "none"}`,
      `Prompt: ${question.prompt}`,
      `Options: ${question.options?.map((option) => `${option.id}=${option.label}`).join(", ") || "free-form"}`,
      `Timeout: ${question.timeoutAt ?? "none"}`,
      question.answered ? "This question is terminal." : "Action: a answer",
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
    `Findings: ${result.findings?.join(", ") ?? "none"}`,
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
