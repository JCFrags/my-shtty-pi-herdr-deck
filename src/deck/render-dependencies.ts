import type { DeckNotification, DeckState } from "./types.js";
import { currentProviderProjection, selectAdoptedScope } from "./scope.js";
import {
  effectiveOrderedSelection,
  effectiveSelection,
  selectAgentInspectorRelation,
} from "./selections.js";
import { selectBoardPresentation } from "./board-presentation.js";

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
  if (context.workView === "tasks") {
    const tasks = sortedValues(scoped.tasks.values());
    const selected = effectiveSelection(tasks, context.selectedTaskId);
    return {
      rows: tasks.map((task) => ({
        id: task.id,
        state: task.state,
        title: task.title,
        assignedAgentId: task.assignedAgentId,
        resultId: task.resultId,
        runAgentId: task.currentRunId
          ? scoped.runs.get(task.currentRunId)?.agentId
          : undefined,
      })),
      selected: selectedRelated(scoped, selected?.id),
    };
  }
  if (context.workView === "results") {
    const selected = effectiveSelection(
      scoped.results.values(),
      context.selectedResultId,
    );
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
  if (context.workView === "groups") {
    const groups = sortedValues(scoped.groups.values());
    const selected = effectiveSelection(groups, context.selectedGroupId);
    return {
      rows: groups.map((group) => ({
        id: group.id,
        state: group.state,
        name: group.name,
        title: group.title,
        agentCount: group.agentIds?.length ?? 0,
        taskCount: group.taskIds?.length ?? 0,
      })),
      selected: brokerEntity(selected),
    };
  }
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
  const selected = effectiveOrderedSelection(visible, context.selectedAgentId);
  const relation = selectAgentInspectorRelation(selected, scoped);
  return {
    matchingCount: matching.length,
    order: matching.map((agent) => agent.id),
    rows: visible.map((agent) => ({
      id: agent.id,
      state: agent.state,
      displayName: agent.displayName,
      herdrName: agent.herdrName,
      currentRunId: agent.currentRunId,
      lifecycleClass: agent.lifecycleClass,
      keepForReuse: agent.keepForReuse,
      actualModel: agent.actualModel,
      effectiveModel: agent.effectiveModel,
    })),
    selected: brokerEntity(selected),
    related: {
      run: brokerEntity(relation.run),
      task: brokerEntity(relation.task),
      result: brokerEntity(relation.result),
      question: brokerEntity(relation.question),
    },
  };
}

function boardModel(state: DeckState, context: VisibleSurfaceContext): unknown {
  const { provider, visible: authority } = providerAuthority(
    state,
    context.targetPaneId,
  );
  const board = provider?.agentBoard;
  const presentation = selectBoardPresentation(
    board,
    context.boardTab ?? "inbox",
    context.boardSelectionId,
  );
  return {
    authority,
    available: presentation.available,
    openCount: presentation.openCount,
    tabCounts: presentation.tabCounts,
    tab: presentation.tab,
    rows: presentation.rows,
    empty: presentation.empty,
    selectedRow: presentation.selectedRow,
    selectedRevision: presentation.selectedRevision,
    detail: presentation.detail,
    pendingQuestion: presentation.pendingQuestion,
    userAnswerable: presentation.userAnswerable,
    dismissible: presentation.dismissible,
    retryableDelivery: presentation.retryableDelivery,
    updateKind: presentation.updateKind,
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
