import type { DeckNotification, DeckState } from "./types.js";
import {
  currentProviderProjection,
  selectAdoptedScope,
  selectFilesPresentationAuthority,
} from "./scope.js";
import {
  effectiveSelection,
  selectAgentInspectorRelation,
  selectAgentListPresentation,
  selectTaskDetailRelation,
  selectTaskRowPresentation,
  taskRowDependency,
} from "./selections.js";
import { selectBoardPresentation } from "./board-presentation.js";
import {
  selectActivityPresentation,
  selectUnifiedBoardPresentation,
  type AgentBoardTab,
} from "./product-presentation.js";

export type { AgentBoardTab } from "./product-presentation.js";
/** Legacy context names remain accepted by pure dependency tests only. */
export type VisibleDeckTab = AgentBoardTab | "home" | "work" | "inbox" | "more";
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
  const relation = selectTaskDetailRelation(task, state);
  return {
    task: brokerEntity(task),
    run: brokerEntity(relation.run),
    result: brokerEntity(relation.result),
    question: brokerEntity(relation.question),
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
      rows: tasks.map((task) => taskRowDependency(task, scoped)),
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
  const rows = selectTaskRowPresentation(scoped);
  return {
    currentCount: rows.current.length,
    historyCount: rows.history.length,
    current: rows.visibleCurrent.map((task) => taskRowDependency(task, scoped)),
    history: rows.visibleHistory.map((task) => taskRowDependency(task, scoped)),
    results: sortedValues(scoped.results.values()).map((result) => ({
      id: result.id,
      status: result.status,
      summary: result.summary,
    })),
  };
}

function agentsModel(
  state: DeckState,
  context: VisibleSurfaceContext,
): unknown {
  const scoped = selectAdoptedScope(state, context.targetPaneId).state;
  const presentation = selectAgentListPresentation(
    scoped.agents.values(),
    context.agentFilter ?? "active",
    context.agentPage ?? 0,
    context.selectedAgentId,
  );
  const matching = presentation.matching;
  const visible = presentation.visible;
  const selected = presentation.selected;
  const relation = selectAgentInspectorRelation(selected, scoped);
  return {
    matchingCount: presentation.matchingCount,
    pageCount: presentation.pageCount,
    safePage: presentation.safePage,
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

function boardItemRow(item: {
  kind: string;
  id: string;
  title: string;
  status: string;
  waitReason?: string;
}) {
  return {
    kind: item.kind,
    id: item.id,
    title: item.title,
    status: item.status,
    ...(item.waitReason ? { waitReason: item.waitReason } : {}),
  };
}

function unifiedBoardModel(
  state: DeckState,
  context: VisibleSurfaceContext,
): unknown {
  const presentation = selectUnifiedBoardPresentation(
    state,
    context.targetPaneId,
    context.boardSelectionId,
  );
  const selected = presentation.selected;
  let detail: unknown;
  if (selected?.kind === "task")
    detail = selectedRelated(
      selectAdoptedScope(state, context.targetPaneId).state,
      selected.source.id,
    );
  else if (selected?.kind.startsWith("signal-")) {
    const tab =
      selected.kind === "signal-question"
        ? "inbox"
        : selected.kind === "signal-update"
          ? "updates"
          : "decisions";
    detail = selectBoardPresentation(
      presentation.provider?.agentBoard,
      tab,
      selected.id.slice(selected.id.indexOf(":") + 1),
    ).detail;
  } else if (selected) detail = brokerEntity(selected.source);
  return {
    work: presentation.work.map(boardItemRow),
    attention: presentation.attention.map(boardItemRow),
    selected: selected ? boardItemRow(selected) : undefined,
    detail,
    counts: presentation.counts,
  };
}

function activityModel(
  state: DeckState,
  context: VisibleSurfaceContext,
): unknown {
  const presentation = selectActivityPresentation(
    state,
    context.targetPaneId,
    context.boardSelectionId,
  );
  return {
    items: presentation.items.map(boardItemRow),
    selected: presentation.selected
      ? {
          ...boardItemRow(presentation.selected),
          detail: brokerEntity(presentation.selected.source),
        }
      : undefined,
    counts: presentation.counts,
  };
}

export function visibleSurfaceModel(
  state: DeckState,
  context: VisibleSurfaceContext,
): unknown {
  if (context.tab === "files") {
    const filesAuthority = selectFilesPresentationAuthority(
      state,
      context.targetPaneId,
    );
    return {
      authority: filesAuthority.providerIdentity,
      canOpenStandalone: filesAuthority.canOpenStandalone,
      files: filesAuthority.provider?.files,
    };
  }
  if (context.tab === "board") return unifiedBoardModel(state, context);
  if (context.tab === "activity") return activityModel(state, context);
  if (context.tab === "agents") return agentsModel(state, context);
  // Legacy pure contexts keep their old behavior for one compatibility cycle.
  if (context.tab === "work") return workModel(state, context);
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
