import type { DeckNotification, DeckState } from "./types.js";
import {
  selectAdoptedScope,
  selectFilesPresentationAuthority,
} from "./scope.js";
import {
  selectAgentInspectorRelation,
  selectAgentListPresentation,
  selectTaskDetailRelation,
} from "./selections.js";
import {
  selectActivityPresentation,
  selectUnifiedBoardPresentation,
  type ActivityFilter,
  type AgentBoardTab,
  type BoardFilter,
} from "./product-presentation.js";

export type { AgentBoardTab } from "./product-presentation.js";
export type VisibleAgentFilter = "active" | "idle" | "history";

export interface VisibleSurfaceContext {
  tab: AgentBoardTab | string;
  targetPaneId?: string;
  selectedAgentId?: string;
  agentFilter?: VisibleAgentFilter;
  agentPage?: number;
  boardSelectionId?: string;
  boardFilter?: BoardFilter;
  activityFilter?: ActivityFilter;
  notifications?: readonly DeckNotification[];
  overlay?:
    | "settings"
    | "help"
    | "agent-more"
    | "confirm"
    | "text-input"
    | "question-response";
  overlayGuard?: unknown;
  /** Allows old callers to compile; removed surface fields do not affect a model. */
  [unusedCompatibilityField: string]: unknown;
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
  const relation = selectAgentInspectorRelation(presentation.selected, scoped);
  return {
    matchingCount: presentation.matchingCount,
    pageCount: presentation.pageCount,
    safePage: presentation.safePage,
    order: presentation.matching.map((agent) => agent.id),
    rows: presentation.visible.map((agent) => ({
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
    selected: brokerEntity(presentation.selected),
    related: {
      run: brokerEntity(relation.run),
      task: brokerEntity(relation.task),
      result: brokerEntity(relation.result),
      question: brokerEntity(relation.question),
    },
  };
}

function boardRow(item: {
  uiId: string;
  entityId: string;
  kind: string;
  sourceLabel?: string;
  title: string;
  summary: string;
  state: string;
  section?: string;
  actions?: unknown;
}) {
  return {
    uiId: item.uiId,
    entityId: item.entityId,
    kind: item.kind,
    sourceLabel: item.sourceLabel,
    title: item.title,
    summary: item.summary,
    state: item.state,
    section: item.section,
    actions: item.actions,
  };
}

function boardModel(state: DeckState, context: VisibleSurfaceContext): unknown {
  const presentation = selectUnifiedBoardPresentation(
    state,
    context.targetPaneId,
    context.boardSelectionId,
    context.boardFilter ?? "all-current",
  );
  const selected = presentation.selected;
  let detail: unknown;
  if (selected?.kind === "task")
    detail = selectedRelated(
      selectAdoptedScope(state, context.targetPaneId).state,
      selected.source.id,
    );
  else if (selected) detail = brokerEntity(selected.source);
  const owner = presentation.provider
    ? state.agents.get(presentation.provider.ownerAgentId)
    : undefined;
  return {
    authority: presentation.provider
      ? {
          ownerAgentId: presentation.provider.ownerAgentId,
          piSessionId: presentation.provider.piSessionId,
          connectionGeneration: owner?.connectionGeneration ?? 0,
          rootExists: Boolean(owner),
        }
      : undefined,
    filter: presentation.filter,
    attention: presentation.attention.map(boardRow),
    work: presentation.work.map(boardRow),
    recentSignals: presentation.recentSignals.map(boardRow),
    visible: presentation.visible.map(boardRow),
    selected: selected ? boardRow(selected) : undefined,
    detail,
    counts: presentation.counts,
    notifications: context.notifications?.slice(0, 4) ?? [],
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
    context.activityFilter ?? "all",
    context.notifications ?? [],
  );
  const selected = presentation.selected;
  const scoped = selectAdoptedScope(state, context.targetPaneId).state;
  return {
    filter: presentation.filter,
    items: presentation.items.map(boardRow),
    selected: selected
      ? {
          ...boardRow(selected),
          detail:
            selected.kind === "terminal-task"
              ? selectedRelated(scoped, selected.entityId)
              : brokerEntity(selected.source),
        }
      : undefined,
    counts: presentation.counts,
  };
}

export function visibleSurfaceModel(
  state: DeckState,
  context: VisibleSurfaceContext,
): unknown {
  if (context.overlay)
    return {
      overlay: context.overlay,
      guard: context.overlayGuard,
    };
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
  if (context.tab === "board") return boardModel(state, context);
  if (context.tab === "activity") return activityModel(state, context);
  if (context.tab === "agents") return agentsModel(state, context);
  return {};
}

export function visibleSurfaceSignature(
  state: DeckState,
  context: VisibleSurfaceContext,
): string {
  return JSON.stringify(canonical(visibleSurfaceModel(state, context)));
}
