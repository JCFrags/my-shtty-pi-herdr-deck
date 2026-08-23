import type { DeckNotification, DeckState } from "./types.js";
import { currentProviderProjection, selectAdoptedScope } from "./scope.js";

export type VisibleDeckTab =
  "home" | "work" | "files" | "agents" | "inbox" | "more";
export type VisibleWorkView =
  "todo" | "tasks" | "results" | "groups" | "history";
export type VisibleAgentFilter = "active" | "idle" | "history";
export type VisibleBoardTab = "inbox" | "updates" | "decisions" | "history";

export interface VisibleSurfaceContext {
  tab: VisibleDeckTab;
  workView: VisibleWorkView;
  targetPaneId?: string;
  selectedTaskId?: string;
  selectedResultId?: string;
  selectedGroupId?: string;
  selectedAgentId?: string;
  agentFilter?: VisibleAgentFilter;
  agentPage?: number;
  boardTab?: VisibleBoardTab;
  boardSelectionId?: string;
  notifications?: readonly DeckNotification[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Set) return [...value].sort().map(canonical);
  if (value instanceof Map)
    return [...value.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, item]) => [key, canonical(item)]);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

function brokerEntity(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const {
    seq: _seq,
    adapterSeq: _adapterSeq,
    heartbeatAt: _heartbeatAt,
    lastHeartbeatAt: _lastHeartbeatAt,
    updatedAt: _updatedAt,
    timestamp: _timestamp,
    ...semantic
  } = value as Record<string, unknown>;
  return semantic;
}

function sortedValues<T extends { id: string }>(values: Iterable<T>): T[] {
  return [...values].sort((a, b) => a.id.localeCompare(b.id));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function providerAuthority(state: DeckState, targetPaneId?: string) {
  const provider = currentProviderProjection(state, targetPaneId);
  const owner = provider ? state.agents.get(provider.ownerAgentId) : undefined;
  return {
    provider,
    visible: provider
      ? {
          ownerAgentId: provider.ownerAgentId,
          piSessionId: provider.piSessionId,
          connectionGeneration: owner?.connectionGeneration ?? 0,
          rootExists: Boolean(owner),
        }
      : undefined,
  };
}

function selectedRelated(state: DeckState, taskId?: string) {
  const task = taskId ? state.tasks.get(taskId) : undefined;
  const run = task?.currentRunId
    ? state.runs.get(task.currentRunId)
    : undefined;
  const result = sortedValues(state.results.values()).find(
    (item) => item.taskId === taskId || (run && item.runId === run.id),
  );
  const question = sortedValues(state.questions.values()).find(
    (item) =>
      !item.answered &&
      item.state !== "answered" &&
      (item.taskId === taskId || (run && item.runId === run.id)),
  );
  return {
    task: brokerEntity(task),
    run: brokerEntity(run),
    result: brokerEntity(result),
    question: brokerEntity(question),
  };
}

function workModel(state: DeckState, context: VisibleSurfaceContext): unknown {
  const { provider, visible: authority } = providerAuthority(
    state,
    context.targetPaneId,
  );
  const scoped = selectAdoptedScope(state, context.targetPaneId).state;
  if (context.workView === "todo") return { authority, todo: provider?.todo };
  if (context.workView === "tasks")
    return {
      rows: sortedValues(scoped.tasks.values()).map(brokerEntity),
      runs: sortedValues(scoped.runs.values()).map(brokerEntity),
      selected: selectedRelated(scoped, context.selectedTaskId),
    };
  if (context.workView === "results") {
    const selected = context.selectedResultId
      ? scoped.results.get(context.selectedResultId)
      : undefined;
    return {
      rows: sortedValues(scoped.results.values()).map((item) => ({
        id: item.id,
        status: item.status,
        summary: item.summary,
      })),
      selected: brokerEntity(selected),
      relatedTask: brokerEntity(
        selected?.taskId ? scoped.tasks.get(selected.taskId) : undefined,
      ),
    };
  }
  if (context.workView === "groups")
    return {
      rows: sortedValues(scoped.groups.values()).map(brokerEntity),
      selected: brokerEntity(
        context.selectedGroupId
          ? scoped.groups.get(context.selectedGroupId)
          : undefined,
      ),
    };
  const terminalTasks = sortedValues(scoped.tasks.values()).filter((task) =>
    ["succeeded", "failed", "cancelled", "timed_out"].includes(task.state),
  );
  return {
    tasks: terminalTasks.map(brokerEntity),
    runs: sortedValues(scoped.runs.values())
      .filter((run) =>
        terminalTasks.some((task) => task.currentRunId === run.id),
      )
      .map(brokerEntity),
    results: sortedValues(scoped.results.values()).map(brokerEntity),
  };
}

function agentsModel(
  state: DeckState,
  context: VisibleSurfaceContext,
): unknown {
  const scoped = selectAdoptedScope(state, context.targetPaneId).state;
  const active = new Set([
    "provisioning",
    "starting",
    "working",
    "blocked",
    "stopping",
  ]);
  const filter = context.agentFilter ?? "active";
  const matching = sortedValues(scoped.agents.values())
    .filter((agent) =>
      filter === "active"
        ? active.has(agent.state)
        : filter === "idle"
          ? agent.state === "idle"
          : !active.has(agent.state) && agent.state !== "idle",
    )
    .sort((a, b) => b.id.localeCompare(a.id));
  const page = Math.max(0, context.agentPage ?? 0);
  const visible = matching.slice(page * 12, page * 12 + 12);
  const selected = context.selectedAgentId
    ? scoped.agents.get(context.selectedAgentId)
    : undefined;
  const task = selected
    ? sortedValues(scoped.tasks.values()).find(
        (item) => item.assignedAgentId === selected.id,
      )
    : undefined;
  return {
    matchingCount: matching.length,
    order: matching.map((agent) => agent.id),
    rows: visible.map(brokerEntity),
    selected: brokerEntity(selected),
    related: selectedRelated(scoped, task?.id),
  };
}

function boardModel(state: DeckState, context: VisibleSurfaceContext): unknown {
  const { provider, visible: authority } = providerAuthority(
    state,
    context.targetPaneId,
  );
  const board = provider?.agentBoard;
  const view = record(board?.view);
  const counts = record(view.counts);
  const tabs = record(view.tabs);
  const tabName = context.boardTab ?? "inbox";
  const tab = record(tabs[tabName]);
  const rows = Array.isArray(tab.rows) ? tab.rows.map(record) : [];
  const selected = rows.find(
    (row) => String(row.id ?? row.entityId ?? "") === context.boardSelectionId,
  );
  const details = record(tab.details);
  const selectedId = context.boardSelectionId ?? "";
  const pending = board?.pendingQuestions?.find(
    (item) => item.questionId === selectedId,
  );
  return {
    authority,
    available: board?.available,
    openCount: board?.openCount,
    health: board?.health,
    preferredCommand: board?.preferredCommand,
    counts,
    rows,
    selected,
    detail: details[selectedId] ?? tab.detail,
    pending,
  };
}

function homeModel(state: DeckState, context: VisibleSurfaceContext): unknown {
  const scoped = selectAdoptedScope(state, context.targetPaneId).state;
  const { provider, visible: authority } = providerAuthority(
    state,
    context.targetPaneId,
  );
  const portfolio = { active: 0, idle: 0, history: 0 };
  for (const agent of state.agents.values()) {
    if (
      ["provisioning", "starting", "working", "blocked", "stopping"].includes(
        agent.state,
      )
    )
      portfolio.active++;
    else if (agent.state === "idle") portfolio.idle++;
    else portfolio.history++;
  }
  return {
    authority,
    agents: sortedValues(scoped.agents.values()).map(brokerEntity),
    tasks: sortedValues(scoped.tasks.values()).map(brokerEntity),
    runs: sortedValues(scoped.runs.values()).map(brokerEntity),
    questions: sortedValues(scoped.questions.values())
      .filter((item) => !item.answered && item.state !== "answered")
      .map(brokerEntity),
    results: sortedValues(scoped.results.values()).slice(-5).map(brokerEntity),
    todo: provider?.todo,
    board: provider?.agentBoard
      ? {
          available: provider.agentBoard.available,
          openCount: provider.agentBoard.openCount,
          health: provider.agentBoard.health,
        }
      : undefined,
    portfolio,
    notifications: context.notifications?.slice(0, 4) ?? [],
  };
}

export function visibleSurfaceModel(
  state: DeckState,
  context: VisibleSurfaceContext,
): unknown {
  const { provider, visible: authority } = providerAuthority(
    state,
    context.targetPaneId,
  );
  if (context.tab === "files") return { authority, files: provider?.files };
  if (context.tab === "work") return workModel(state, context);
  if (context.tab === "agents") return agentsModel(state, context);
  if (context.tab === "inbox") return boardModel(state, context);
  if (context.tab === "home") return homeModel(state, context);
  return {};
}

export function visibleSurfaceSignature(
  state: DeckState,
  context: VisibleSurfaceContext,
): string {
  return JSON.stringify(canonical(visibleSurfaceModel(state, context)));
}
