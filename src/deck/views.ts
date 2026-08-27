import type { Agent, Task } from "../state/types.js";
import type {
  DeckGroup,
  DeckNotification,
  DeckQuestion,
  DeckResult,
  DeckState,
} from "./types.js";
import { currentProviderProjection, selectAdoptedScope } from "./scope.js";
import {
  selectAgentInspectorRelation,
  selectAgentListPresentation,
  selectTaskDetailRelation,
  selectTaskRowPresentation,
} from "./selections.js";

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

function duration(milliseconds: unknown): string | undefined {
  if (
    typeof milliseconds !== "number" ||
    !Number.isFinite(milliseconds) ||
    milliseconds < 0
  )
    return undefined;
  const seconds = Math.floor(milliseconds / 1_000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function progressText(value: unknown): string {
  const progress = record(record(value).progress);
  const phase = text(progress.phase);
  const elapsed = duration(progress.elapsedMs);
  if (!phase || !elapsed) return "unavailable";
  const remaining = duration(progress.remainingMs);
  const overdue = duration(progress.overdueMs);
  const deadline = text(progress.deadlineAt);
  const deadlineKind = text(progress.deadlineKind);
  return [
    phase,
    `elapsed ${elapsed}`,
    ...(deadline
      ? [
          `${deadlineKind ?? "operation"} deadline ${deadline}`,
          overdue
            ? `overdue ${overdue}`
            : remaining
              ? `${remaining} remaining`
              : "deadline reached",
        ]
      : []),
  ].join("; ");
}

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

export { currentProviderProjection } from "./scope.js";

function currentScope(
  state: DeckState,
  targetPaneId?: string,
): { agents: Agent[]; tasks: Task[] } {
  const scoped = selectAdoptedScope(state, targetPaneId).state;
  return {
    agents: [...scoped.agents.values()],
    tasks: [...scoped.tasks.values()],
  };
}

export interface AgentPortfolioCounts {
  active: number;
  idleRetained: number;
  archivedCompleted: number;
}

export function agentPortfolioCounts(
  agents: Iterable<Agent>,
): AgentPortfolioCounts {
  let active = 0;
  let idleRetained = 0;
  let archivedCompleted = 0;
  for (const agent of agents) {
    if (
      ["provisioning", "starting", "working", "blocked", "stopping"].includes(
        agent.state,
      )
    )
      active++;
    else if (agent.state === "idle") idleRetained++;
    else archivedCompleted++;
  }
  return { active, idleRetained, archivedCompleted };
}

export function renderHome(
  state: DeckState,
  width: number,
  targetPaneId?: string,
): string[] {
  const { agents, tasks } = currentScope(state, targetPaneId);
  const provider = currentProviderProjection(state, targetPaneId);
  const activeAgents = agents.filter((agent) =>
    ["provisioning", "starting", "working", "blocked", "stopping"].includes(
      agent.state,
    ),
  );
  const blockedAgents = agents.filter((agent) => agent.state === "blocked");
  const workingAgents = agents.filter((agent) => agent.state === "working");
  const activeTasks = tasks.filter((task) =>
    ["queued", "assigned", "running", "blocked", "collecting"].includes(
      task.state,
    ),
  );
  const relevantQuestions = [...state.questions.values()].filter(
    (question) =>
      !question.answered &&
      question.state !== "answered" &&
      ((question.agentId &&
        agents.some((agent) => agent.id === question.agentId)) ||
        (question.taskId && tasks.some((task) => task.id === question.taskId))),
  );
  const relevantTaskIds = new Set(tasks.map((task) => task.id));
  const recentResults = [...state.results.values()]
    .filter((result) =>
      Boolean(result.taskId && relevantTaskIds.has(result.taskId)),
    )
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, 3);
  const portfolio = agentPortfolioCounts(agents);
  const lines = [
    "HOME · CURRENT SCOPE",
    agents.length > 0
      ? `Workers expected ${activeTasks.length} · working ${workingAgents.length} · blocked ${blockedAgents.length} · idle retained ${portfolio.idleRetained}`
      : "Current adopted Pi scope is unavailable.",
    provider
      ? `Providers · Signals ${provider.agentBoard.available ? `${provider.agentBoard.openCount} pending` : "unavailable"} · Todo ${provider.todo.available ? `${provider.todo.completed}/${provider.todo.total} done` : "unavailable"}`
      : "Providers unavailable · select an adopted Pi scope.",
    "",
    "NEXT ACTIONS · 1 Work  4 Inbox  5 More",
    blockedAgents.length > 0
      ? `! ${blockedAgents.length} blocked worker(s) need attention in Agents.`
      : "✓ No blocked workers.",
    relevantQuestions.length > 0
      ? `! ${relevantQuestions.length} orchestrator question(s) need an answer in Inbox.`
      : "✓ No blocking orchestrator questions.",
    "",
    "ACTIVE WORK",
    ...(activeAgents.length > 0
      ? activeAgents
          .slice(0, 3)
          .map(
            (agent) =>
              `${stateIcon(agent.state)} ${agent.displayName ?? agent.herdrName ?? agent.id} — ${agent.state}`,
          )
      : ["No active agents in the current scope."]),
    ...(activeTasks.length > 0
      ? activeTasks
          .slice(0, 4)
          .map(
            (task) => `${stateIcon(task.state)} ${task.title} — ${task.state}`,
          )
      : ["No current orchestrator tasks in this scope."]),
    "",
    "RECENT RESULTS",
    ...(recentResults.length > 0
      ? recentResults.map(
          (result) =>
            `${stateIcon(result.status)} ${result.summary ?? result.id} — ${result.status}`,
        )
      : ["No recent results in this scope."]),
  ];
  if (agents.length > 3)
    lines.splice(
      9,
      0,
      `Showing ${Math.min(activeAgents.length, 3)} active workers · open Agents for the full scoped list.`,
    );
  lines.push(
    "",
    `Scope totals · ${portfolio.active} active · ${portfolio.idleRetained} idle retained · ${portfolio.archivedCompleted} history · ${activeTasks.length} open tasks · ${recentResults.length} recent results.`,
  );
  return fitLines(lines, width);
}

export function renderFiles(
  width: number,
  state?: DeckState,
  targetPaneId?: string,
): string[] {
  const projection = state
    ? currentProviderProjection(state, targetPaneId)
    : undefined;
  const owner = projection?.ownerAgentId ?? "unavailable";
  return fitLines(
    [
      "FILES",
      projection
        ? `Provider: connected · owner ${owner}`
        : "Provider: connection status unavailable.",
      "Provider browser: tree navigation, selection, preview, and insertion.",
    ],
    width,
  );
}

export function renderTodoSummary(
  state: DeckState,
  width: number,
  targetPaneId?: string,
  selectedId?: string,
): string[] {
  const todo = currentProviderProjection(state, targetPaneId)?.todo;
  if (!todo?.available)
    return fitLines(
      ["PI TODO · Provider-owned projection", "Todo provider is unavailable."],
      width,
    );
  return fitLines(
    [
      "PI TODO · Provider-owned projection",
      `${todo.completed}/${todo.total} complete · plan size ${todo.planSize ?? todo.total}`,
      `Current useful task: ${todo.currentUsefulTask?.text ?? "none"}`,
      `Wait: ${todo.waitReason ?? "none"} · external waits: ${todo.externalWaits?.length ?? 0}`,
      `Counts by state: ${
        Object.entries(todo.countsByState ?? {})
          .map(([key, value]) => `${key}=${value}`)
          .join(", ") || "none"
      }`,
      ...(todo.items.length
        ? todo.items
            .slice(0, 8)
            .map(
              (item) =>
                `${selectedId === item.id ? ">" : " "}${item.status ? `[${item.status}] ` : ""}${item.text} · ${item.id}`,
            )
        : ["No Todo items are open."]),
    ],
    width,
  );
}

export function renderTodoDetail(
  state: DeckState,
  width: number,
  targetPaneId?: string,
  selectedId?: string,
): string[] {
  const item = currentProviderProjection(state, targetPaneId)?.todo.items.find(
    (entry) => entry.id === selectedId,
  );
  return fitLines(
    item
      ? [
          "PROVIDER TODO DETAIL",
          `ID: ${item.id}`,
          `Item: ${item.text}`,
          `Status: ${item.status ?? "open"}`,
          `Wait: ${item.waitReason ?? "none"}`,
          "Actions: start · done · clear external wait",
        ]
      : ["PROVIDER TODO DETAIL", "Select a provider Todo item."],
    width,
  );
}

export function currentBlockingQuestions(
  state: DeckState,
  targetPaneId?: string,
): DeckQuestion[] {
  const scope = currentScope(state, targetPaneId);
  const scopeAgentIds = new Set(scope.agents.map((agent) => agent.id));
  const scopeTaskIds = new Set(scope.tasks.map((task) => task.id));
  const hasScope =
    scope.agents.length > 0 ||
    Boolean(currentProviderProjection(state, targetPaneId));
  return [...state.questions.values()].filter(
    (question) =>
      !question.answered &&
      question.state !== "answered" &&
      (!hasScope ||
        Boolean(
          (question.agentId && scopeAgentIds.has(question.agentId)) ||
          (question.taskId && scopeTaskIds.has(question.taskId)),
        )),
  );
}

export function renderInbox(
  state: DeckState,
  width: number,
  selectedId?: string,
  targetPaneId?: string,
): string[] {
  const blocking = currentBlockingQuestions(state, targetPaneId);
  return fitLines(
    [
      "INBOX",
      "BLOCKING · Orchestrator questions",
      "These synchronous questions pause managed work. Pi uses ask_user_question for this path.",
      ...renderQuestions(blocking, width, selectedId),
    ],
    width,
  );
}

export type AgentViewFilter = "active" | "idle" | "history";

export function renderAgents(
  state: DeckState,
  width: number,
  selectedId?: string,
  filter: AgentViewFilter = "active",
  page = 0,
  pageSize = 12,
): string[] {
  const presentation = selectAgentListPresentation(
    state.agents.values(),
    filter,
    page,
    selectedId,
    pageSize,
  );
  const visible = presentation.matching;
  const pages = presentation.pageCount;
  const safePage = presentation.safePage;
  const shown = presentation.visible;
  selectedId = presentation.selected?.id;
  const lines = [
    `AGENTS · ${filter.toUpperCase()}`,
    "Scope only · Active workers, retained idle workers, or terminal history. Use tabs to change view.",
    `State: ▶ working · ! blocked · ○ idle · × failed · ✓ succeeded · page ${safePage + 1}/${pages} · ${visible.length} matching`,
    "",
  ];
  for (const agent of shown) {
    const marker = selectedId === agent.id ? ">" : " ";
    const meta = record(agent);
    const model =
      modelText(record(meta.actualModel)) ??
      modelText(record(meta.effectiveModel)) ??
      "model unavailable";
    const task = agent.currentRunId
      ? `run ${agent.currentRunId}`
      : "no current run";
    lines.push(
      `${marker}${stateIcon(agent.state)} ${clip(agent.displayName ?? agent.herdrName ?? agent.id, 24)} · ${agent.state} · ${clip(task, 25)}`,
    );
    lines.push(
      `   ${agent.lifecycleClass ?? "retained"}${agent.keepForReuse ? " · reusable" : ""} · ${clip(model, 30)}`,
    );
  }
  if (shown.length === 0)
    lines.push(
      filter === "active"
        ? "No active or blocked workers in this scope."
        : filter === "idle"
          ? "No retained idle workers in this scope."
          : "No terminal agent history in this scope.",
    );
  if (visible.length > pageSize)
    lines.push(
      "",
      `↕ Scroll with ↑/↓ · page ${safePage + 1}/${pages} · ${shown.length} shown of ${visible.length}`,
    );
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
  const filteredState = filter
    ? {
        ...state,
        tasks: new Map(
          [...state.tasks].filter(([, task]) => task.state === filter),
        ),
      }
    : state;
  const presentation = selectTaskRowPresentation(filteredState);
  const tasks = [...filteredState.tasks.values()];
  const lines = [
    "TASKS · CURRENT",
    "State  ID                         title                         assignee/result",
  ];
  const renderTask = (task: Task): void => {
    const run = task.currentRunId
      ? state.runs.get(task.currentRunId)
      : undefined;
    const assignee = task.assignedAgentId ?? run?.agentId ?? "unassigned";
    const marker = selectedId === task.id ? ">" : " ";
    lines.push(
      `${marker}${stateIcon(task.state)} ${pad(task.state, 12)} ${pad(task.id, 27)} ${pad(task.title, 30)} ${assignee}${task.resultId ? ` result:${task.resultId}` : ""}`,
    );
  };
  for (const task of presentation.visibleCurrent) renderTask(task);
  if (presentation.current.length > 10)
    lines.push(
      `↕ ${presentation.current.length - 10} more current tasks · use selection/navigation`,
    );
  if (presentation.history.length > 0) {
    lines.push("", "HISTORY · TERMINAL TASKS (retained)");
    for (const task of presentation.visibleHistory) renderTask(task);
    if (presentation.history.length > 8)
      lines.push(
        `↕ ${presentation.history.length - 8} more terminal tasks retained`,
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
  const relation = selectAgentInspectorRelation(agent, state);
  const { run, task } = relation;
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
    relation.question?.prompt ??
    (agent.state === "blocked" ? "unavailable" : "none");
  return fitLines(
    [
      "AGENT DETAIL",
      `Identity: ${agent.id} (generation ${agent.generation})`,
      `State: ${stateIcon(agent.state)} ${agent.state}; detected: ${agent.coarseStatus ?? "unavailable"}`,
      `Progress: ${progressText(agent)}`,
      `Profile: ${agent.profileId ?? "default"}`,
      `Lifecycle: ${agent.lifecycleClass ?? (agent.parentAgentId ? "temporary" : "retained")}; keep for reuse: ${agent.keepForReuse === true ? "yes" : "no"}`,
      `Close recommendation: ${agent.closeRecommendation ?? "keep"} — ${agent.closeReason ?? "No lifecycle reason was supplied."}`,
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
  const { run, result, question } = selectTaskDetailRelation(task, state);
  return fitLines(
    [
      "TASK DETAIL",
      `ID: ${task.id}`,
      `State: ${stateIcon(task.state)} ${task.state}`,
      `Progress: ${progressText(task)}`,
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
  const ordered = [...questions].sort((a, b) => a.id.localeCompare(b.id));
  for (const question of ordered.slice(0, 10)) {
    const status = question.state ?? (question.answered ? "answered" : "open");
    const marker = selectedId === question.id ? ">" : " ";
    lines.push(
      `${marker}${stateIcon(status)} ${pad(question.id, 27)} ${pad(question.taskId ?? question.agentId ?? "unbound", 29)} ${question.prompt}`,
    );
  }
  if (questions.length === 0) lines.push("No questions are visible.");
  else if (questions.length > 10)
    lines.push(`↕ ${questions.length - 10} more questions · use ↑/↓ to select`);
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
