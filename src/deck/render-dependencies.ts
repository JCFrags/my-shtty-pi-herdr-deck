import type { DeckNotification, DeckState } from "./types.js";
import type { Agent } from "../state/types.js";
import type { ShellHeaderPresentation } from "./screen-types.js";
import {
  currentProviderProjection,
  selectAdoptedScope,
  selectFilesPresentationAuthority,
} from "./scope.js";
import {
  selectAgentInspectorRelation,
  selectAgentListPresentation,
  selectTaskDetailRelation,
} from "./selections.js";
import {
  normalizeBrokerQuestion,
  selectActivityPresentation,
  selectUnifiedBoardPresentation,
  type ActivityFilter,
  type AgentBoardTab,
  type BoardFilter,
} from "./product-presentation.js";
import { selectBoardPresentation } from "./board-presentation.js";

export type { AgentBoardTab } from "./product-presentation.js";
export type VisibleAgentFilter = "active" | "idle" | "history";

export interface VisibleSurfaceContext {
  tab: AgentBoardTab;
  targetPaneId?: string;
  selectedAgentId?: string;
  agentFilter?: VisibleAgentFilter;
  agentPage?: number;
  boardSelectionId?: string;
  boardFilter?: BoardFilter;
  activityFilter?: ActivityFilter;
  notifications?: readonly DeckNotification[];
  /** Shell state is visible for every tab and therefore belongs in the gate. */
  online?: boolean;
  overlay?:
    | "settings"
    | "help"
    | "agent-more"
    | "confirm"
    | "text-input"
    | "question-response";
  overlayGuard?: unknown;
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

function normalizedActions(value: unknown): unknown {
  if (!value || typeof value !== "object") return { actions: [] };
  const actions = value as Record<string, unknown>;
  return {
    ...(typeof actions.primary === "string"
      ? { primary: actions.primary }
      : {}),
    actions: Array.isArray(actions.actions)
      ? actions.actions.filter(
          (action): action is string => typeof action === "string",
        )
      : [],
    ...(typeof actions.disabledReason === "string"
      ? { disabledReason: actions.disabledReason }
      : {}),
  };
}

function normalizedPendingQuestion(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const question = value as Record<string, unknown>;
  const response =
    question.response && typeof question.response === "object"
      ? (question.response as Record<string, unknown>)
      : {};
  const options = Array.isArray(response.options)
    ? response.options.flatMap((option) => {
        if (!option || typeof option !== "object") return [];
        const item = option as Record<string, unknown>;
        return typeof item.id === "string" && typeof item.label === "string"
          ? [
              {
                id: item.id,
                label: item.label,
                ...(typeof item.description === "string"
                  ? { description: item.description }
                  : {}),
              },
            ]
          : [];
      })
    : [];
  return {
    questionId: question.questionId,
    revision: question.revision,
    question: question.question,
    response: { kind: response.kind, options },
    recommendedOptionIds: Array.isArray(question.recommendedOptionIds)
      ? question.recommendedOptionIds.filter(
          (id): id is string => typeof id === "string",
        )
      : [],
    ...(typeof question.recommendedText === "string"
      ? { recommendedText: question.recommendedText }
      : {}),
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

function providerSelectedDetail(
  provider: ReturnType<typeof selectUnifiedBoardPresentation>["provider"],
  item: { kind: string; entityId: string },
): unknown {
  if (!provider || !item.kind.startsWith("signal-")) return undefined;
  const tab =
    item.kind === "signal-question"
      ? "inbox"
      : item.kind === "signal-decision"
        ? "decisions"
        : item.kind === "signal-history"
          ? "history"
          : "updates";
  const presentation = selectBoardPresentation(
    provider.agentBoard,
    tab,
    item.entityId,
  );
  return {
    row: brokerEntity(presentation.selectedRow),
    detail: brokerEntity(presentation.detail),
    revision: presentation.selectedRevision,
    pendingQuestion: normalizedPendingQuestion(presentation.pendingQuestion),
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
    actions: normalizedActions(item.actions),
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
  else if (selected?.kind === "broker-question")
    detail = {
      question: brokerEntity(normalizeBrokerQuestion(selected.source)),
      related: selectedRelated(
        selectAdoptedScope(state, context.targetPaneId).state,
        selected.source.taskId,
      ),
    };
  else if (selected) {
    const providerDetail = providerSelectedDetail(
      presentation.provider,
      selected,
    );
    detail = {
      source: brokerEntity(selected.source),
      ...(providerDetail ? { provider: providerDetail } : {}),
    };
  }
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
    selected: selected
      ? {
          ...boardRow(selected),
          ...(selected.revision === undefined
            ? {}
            : { revision: selected.revision }),
          ...(selected.pendingQuestion
            ? {
                pendingQuestion: normalizedPendingQuestion(
                  selected.pendingQuestion,
                ),
              }
            : {}),
        }
      : undefined,
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
  const selectedProviderDetail = selected
    ? providerSelectedDetail(
        currentProviderProjection(state, context.targetPaneId),
        selected,
      )
    : undefined;
  return {
    filter: presentation.filter,
    items: presentation.items.map(boardRow),
    selected: selected
      ? {
          ...boardRow(selected),
          ...(selected.revision === undefined
            ? {}
            : { revision: selected.revision }),
          detail:
            selected.kind === "terminal-task"
              ? selectedRelated(scoped, selected.entityId)
              : selectedProviderDetail
                ? {
                    source: brokerEntity(selected.source),
                    provider: selectedProviderDetail,
                  }
                : brokerEntity(selected.source),
        }
      : undefined,
    counts: presentation.counts,
  };
}

function sanitizeShellText(value: string, fallback: string): string {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "�")
    .trim();
  return sanitized || fallback;
}

export function shellHeaderPresentation(
  state: DeckState,
  context: VisibleSurfaceContext,
): ShellHeaderPresentation {
  const scope = selectAdoptedScope(state, context.targetPaneId);
  const root = scope.rootAgentId
    ? state.agents.get(scope.rootAgentId)
    : undefined;
  const scopeLabel = sanitizeShellText(
    root
      ? root.displayName || root.herdrName || root.id
      : context.targetPaneId
        ? `pane ${context.targetPaneId}`
        : "all panes",
    context.targetPaneId ? `pane ${context.targetPaneId}` : "all panes",
  );
  const board = selectUnifiedBoardPresentation(
    state,
    context.targetPaneId,
    undefined,
    "all-current",
  );
  return {
    productName: "AGENT BOARD",
    scopeLabel,
    // Shell attention is the canonical Board attention partition, including synthetic waits.
    attentionCount: board.attention.length,
    online: context.online === true,
    selectedTab: context.tab,
  };
}

function overlayRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function overlayLocal(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ["focus", "scroll", "pending", "error", "value", "cursor", "text"]
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}

function agentOverlayAvailability(
  agent: Agent | undefined,
): Record<string, boolean> {
  const state = agent?.state;
  return {
    compact: state === "idle",
    restart: Boolean(agent) && !["stopped", "replaced"].includes(state ?? ""),
    close: Boolean(agent),
    worktree: Boolean(agent?.cwd),
    copy: Boolean(agent),
    model: Boolean(agent),
    thinking: Boolean(agent),
    create: Boolean(agent?.cwd),
  };
}

function overlayModel(
  state: DeckState,
  context: VisibleSurfaceContext,
): unknown {
  const value = overlayRecord(context.overlayGuard);
  const guard = overlayRecord(value.guard);
  const scoped = selectAdoptedScope(state, context.targetPaneId).state;
  if (context.overlay === "agent-more") {
    const agent = state.agents.get(String(guard.agentId ?? ""));
    return {
      kind: context.overlay,
      current: brokerEntity(agent),
      guard: {
        agentId: guard.agentId,
        expectedGeneration: guard.generation,
        currentGeneration: agent?.generation,
        currentState: agent?.state,
      },
      availability: agentOverlayAvailability(agent),
      local: overlayLocal(value),
    };
  }
  if (context.overlay === "confirm") {
    const action = String(value.action ?? "");
    const targetId = String(guard.targetId ?? "");
    const agentId = String(guard.agentId ?? "");
    const current =
      action === "cancelTask"
        ? scoped.tasks.get(targetId)
        : action === "groupStop" || action === "groupClose"
          ? scoped.groups.get(targetId)
          : scoped.agents.get(agentId);
    const available =
      action === "cancelTask"
        ? Boolean(
            current &&
            !["succeeded", "failed", "cancelled", "timed_out"].includes(
              (current as { state: string }).state,
            ),
          )
        : action === "groupStop" || action === "groupClose"
          ? Boolean(
              current &&
              ![
                "closed",
                "stopped",
                "completed",
                "failed",
                "cancelled",
              ].includes((current as { state: string }).state),
            )
          : Boolean(
              current &&
              (guard.generation === undefined ||
                (current as { generation: number }).generation ===
                  guard.generation),
            );
    return {
      kind: context.overlay,
      action,
      targetId: targetId || agentId || undefined,
      current: brokerEntity(current),
      availability: { confirm: available },
      local: overlayLocal(value),
    };
  }
  if (context.overlay === "question-response") {
    const target = overlayRecord(value.target);
    const questionId = String(
      guard.questionId ??
        target.questionId ??
        overlayRecord(target.boardQuestion).questionId ??
        "",
    );
    const provider = currentProviderProjection(state, context.targetPaneId);
    const pending = provider?.agentBoard.pendingQuestions?.find(
      (question) => question.questionId === questionId,
    );
    const row = provider
      ? selectBoardPresentation(provider.agentBoard, "inbox", questionId)
      : undefined;
    const brokerQuestion = scoped.questions.get(questionId);
    const currentQuestion = brokerQuestion
      ? normalizeBrokerQuestion(brokerQuestion)
      : pending
        ? normalizedPendingQuestion(pending)
        : undefined;
    const currentRevision = pending?.revision ?? row?.selectedRevision;
    return {
      kind: context.overlay,
      questionId,
      current: currentQuestion,
      revision: currentRevision,
      expectedRevision: guard.revision,
      options: brokerQuestion
        ? normalizeBrokerQuestion(brokerQuestion).options
        : (pending?.response.options ?? []),
      availability: {
        answer:
          Boolean(currentQuestion) &&
          (brokerQuestion
            ? !normalizeBrokerQuestion(brokerQuestion).terminal
            : row?.userAnswerable === true || row?.retryableDelivery === true),
        revision:
          guard.revision === undefined || currentRevision === guard.revision,
      },
      local: {
        ...overlayLocal(value),
        selectedOptionIds: Array.isArray(value.selectedOptionIds)
          ? value.selectedOptionIds.filter(
              (id): id is string => typeof id === "string",
            )
          : [],
      },
    };
  }
  if (context.overlay === "text-input") {
    const agentId = String(guard.agentId ?? "");
    const agent = state.agents.get(agentId);
    const question = guard.questionId
      ? scoped.questions.get(String(guard.questionId))
      : undefined;
    const purpose = String(value.purpose ?? "");
    const available =
      purpose === "prompt" || purpose === "ask"
        ? Boolean(agent)
        : purpose === "steer" || purpose === "followUp"
          ? agent?.state === "working"
          : purpose === "create"
            ? Boolean(agent)
            : purpose === "files-filter" ||
                purpose === "model-filter" ||
                purpose === "default"
              ? true
              : Boolean(agent || question);
    return {
      kind: context.overlay,
      purpose,
      current: { agent: brokerEntity(agent), question: brokerEntity(question) },
      availability: { submit: available },
      local: overlayLocal(value),
    };
  }
  return { kind: context.overlay, local: overlayLocal(value) };
}

function activeBodyModel(
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
  if (context.tab === "board") return boardModel(state, context);
  if (context.tab === "activity") return activityModel(state, context);
  return agentsModel(state, context);
}

export function visibleSurfaceModel(
  state: DeckState,
  context: VisibleSurfaceContext,
): unknown {
  const shell = shellHeaderPresentation(state, context);
  if (context.overlay)
    return {
      shell,
      overlay: overlayModel(state, context),
    };
  return { shell, body: activeBodyModel(state, context) };
}

export function visibleSurfaceSignature(
  state: DeckState,
  context: VisibleSurfaceContext,
): string {
  return JSON.stringify(canonical(visibleSurfaceModel(state, context)));
}
