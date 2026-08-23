import type { Agent } from "../state/types.js";
import type { AgentBoardPendingQuestion } from "../shared/provider-projections.js";
import type { ActionTarget } from "./actions.js";
import type {
  ActivityItem,
  BoardAction,
  BoardItem,
  NormalizedQuestion,
} from "./product-presentation.js";
import { boardRecord, selectBoardPresentation } from "./board-presentation.js";
import type { AgentBoardProjection } from "../shared/provider-projections.js";
import { normalizeSignalsPresentation } from "./signals-presentation.js";

export interface ProductActionRequest {
  action: string;
  fields: Record<string, unknown>;
}

export interface ProductTargetContext {
  rootAgent?: Agent | undefined;
  scopedAgents: ReadonlyMap<string, Agent>;
  runs?: ReadonlyMap<string, { taskId: string; agentId?: string }>;
  agentBoard?: AgentBoardProjection | undefined;
}

function agentTarget(agent: Agent | undefined): ActionTarget {
  return agent
    ? {
        agent,
        ...(agent.paneId ? { paneId: agent.paneId } : {}),
        ...(agent.terminalId ? { terminalId: agent.terminalId } : {}),
        generation: agent.generation,
        ...(agent.currentRunId ? { runId: agent.currentRunId } : {}),
      }
    : {};
}

export function actionTargetForAgent(agent: Agent | undefined): ActionTarget {
  return agentTarget(agent);
}

export function actionTargetForBoardItem(
  item: BoardItem,
  context: ProductTargetContext,
): ActionTarget {
  const owner =
    item.kind === "task"
      ? ((item.source.assignedAgentId
          ? context.scopedAgents.get(item.source.assignedAgentId)
          : item.source.currentRunId && context.runs
            ? context.scopedAgents.get(
                context.runs.get(item.source.currentRunId)?.agentId ?? "",
              )
            : undefined) ?? context.rootAgent)
      : item.kind === "broker-question" && item.source.agentId
        ? (context.scopedAgents.get(item.source.agentId) ?? context.rootAgent)
        : item.kind === "agent-alert"
          ? item.source
          : context.rootAgent;
  const base = agentTarget(owner ?? context.rootAgent);
  switch (item.kind) {
    case "todo":
      return {
        ...base,
        todoTaskId: item.source.id,
        todoHasWait: Boolean(item.source.waitReason),
      };
    case "task":
      return { ...base, task: item.source };
    case "group":
      return { ...base, group: item.source };
    case "broker-question":
      return {
        ...base,
        question: item.source,
        questionId: item.source.id,
      };
    case "signal-question": {
      const boardQuestion =
        item.pendingQuestion ??
        signalsQuestionForBoardItem(item, context.agentBoard);
      return {
        ...base,
        ...(boardQuestion
          ? { boardQuestion, questionId: boardQuestion.questionId }
          : { questionId: item.entityId }),
      };
    }
    case "signal-update":
      return base;
    case "agent-alert":
      return { ...base, agent: item.source };
  }
}

export function actionTargetForActivityItem(
  item: ActivityItem,
  context: ProductTargetContext,
): ActionTarget {
  switch (item.kind) {
    case "result":
      return {
        ...agentTarget(context.rootAgent),
        copyId: item.entityId,
      };
    case "terminal-task":
      return { ...agentTarget(context.rootAgent), task: item.source };
    case "terminal-group":
      return { ...agentTarget(context.rootAgent), copyId: item.entityId };
    case "terminal-agent":
      return { ...agentTarget(item.source), copyId: item.entityId };
    case "signal-update":
    case "signal-decision":
    case "signal-history":
      return agentTarget(context.rootAgent);
    case "system-error":
    case "system-recovery":
      return { copyId: item.entityId };
  }
}

export function signalsQuestionForBoardItem(
  item: BoardItem,
  agentBoard: AgentBoardProjection | undefined,
): AgentBoardPendingQuestion | undefined {
  if (item.kind !== "signal-question") return undefined;
  if (item.pendingQuestion) return item.pendingQuestion;
  const presentation = selectBoardPresentation(
    agentBoard,
    "inbox",
    item.entityId,
  );
  const detail = boardRecord(presentation.detail);
  const projection = boardRecord(detail.projection);
  const detailItem = boardRecord(
    projection.item ?? detail.item ?? detail.question ?? detail,
  );
  const response = boardRecord(
    detailItem.response ?? projection.response ?? detail.response,
  );
  const questionId = stringValue(
    detailItem.id ?? detailItem.questionId ?? item.entityId,
  );
  const question = stringValue(
    detailItem.question ??
      detailItem.prompt ??
      detailItem.title ??
      detail.question ??
      "",
  );
  const revision = numberValue(
    detailItem.revision ??
      projection.revision ??
      detail.revision ??
      item.revision ??
      0,
  );
  const kind = response.kind;
  if (
    !questionId ||
    !question ||
    !Number.isSafeInteger(revision) ||
    ![
      "single",
      "multiple",
      "text",
      "single_or_text",
      "multiple_or_text",
    ].includes(String(kind))
  )
    return undefined;
  const options = Array.isArray(response.options)
    ? response.options.flatMap((value) => {
        const option = boardRecord(value);
        const id = stringValue(option.id);
        const label = stringValue(option.label);
        return id && label
          ? [
              {
                id,
                label,
                ...(stringValue(option.description)
                  ? { description: stringValue(option.description) }
                  : {}),
              },
            ]
          : [];
      })
    : [];
  const recommendedOptionIds =
    detailItem.recommendedOptionIds ??
    projection.recommendedOptionIds ??
    detail.recommendedOptionIds;
  const recommendedText = stringValue(
    detailItem.recommendedText ??
      projection.recommendedText ??
      detail.recommendedText,
  );
  return {
    questionId,
    revision,
    question,
    response: {
      kind: kind as AgentBoardPendingQuestion["response"]["kind"],
      options,
    },
    recommendedOptionIds: Array.isArray(recommendedOptionIds)
      ? recommendedOptionIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    ...(recommendedText ? { recommendedText } : {}),
  };
}

export function normalizedSignalsQuestionForBoardItem(
  item: BoardItem,
  agentBoard: AgentBoardProjection | undefined,
): NormalizedQuestion | undefined {
  if (item.kind !== "signal-question") return undefined;
  const presentation = selectBoardPresentation(
    agentBoard,
    "inbox",
    item.entityId,
  );
  const normalized = normalizeSignalsPresentation({
    projection: agentBoard,
    tab: "inbox",
    row: item.source,
    detail: boardRecord(presentation.detail),
  });
  if (!normalized || normalized.entityType !== "question") return undefined;
  return {
    source: "signals",
    uiId: `signals:question:${normalized.entityId}`,
    entityId: normalized.entityId,
    revision: normalized.revision,
    prompt: normalized.prompt,
    responseKind: normalized.responseKind,
    options: normalized.options,
    allowFreeform: normalized.responseKind.includes("text"),
    recommendedOptionIds: normalized.recommendedOptionIds,
    ...(normalized.recommendedText
      ? { recommendedText: normalized.recommendedText }
      : {}),
    dismissible: normalized.dismissible,
    retryableDelivery: normalized.retryableDelivery,
    ...(normalized.answerId ? { answerId: normalized.answerId } : {}),
    deliveryState: normalized.deliveryPending ? "pending" : "settled",
    terminal: normalized.terminal,
  };
}

export function signalsActionRequest(
  item: BoardItem,
  action: BoardAction | string,
  agentBoard: AgentBoardProjection | undefined,
): ProductActionRequest | undefined {
  if (!item.kind.startsWith("signal-")) return undefined;
  const presentation = selectBoardPresentation(
    agentBoard,
    item.kind === "signal-question" ? "inbox" : "updates",
    item.entityId,
  );
  const detail = boardRecord(presentation.detail);
  const projection = boardRecord(detail.projection);
  const detailItem = boardRecord(
    projection.item ??
      detail.item ??
      detail.decision ??
      detail.question ??
      detail,
  );
  const answer = boardRecord(
    projection.answer ?? detail.answer ?? detail.response ?? detailItem.answer,
  );
  const revision = numberValue(
    item.revision ??
      detailItem.revision ??
      projection.revision ??
      detail.revision ??
      0,
  );
  const questionId = stringValue(
    detailItem.questionId ?? detailItem.id ?? item.entityId,
  );
  const answerId = stringValue(
    answer.id ?? answer.answerId ?? detail.answerId ?? "",
  );
  switch (action) {
    case "archive-update":
      return {
        action,
        fields: { updateId: item.entityId, expectedRevision: revision },
      };
    case "acknowledge-answer":
      return {
        action,
        fields: {
          answerId: answerId || item.entityId,
          outcome: "applied",
          summary: "Acknowledged from Agent Board.",
        },
      };
    case "retry-delivery":
      if (!answerId) return undefined;
      return {
        action,
        fields: { questionId, answerId, expectedRevision: revision },
      };
    case "accept-recommendation":
    case "use-recommendation":
      return {
        action: "accept-recommendation",
        fields: { questionId, expectedRevision: revision },
      };
    case "dismiss-question":
      return {
        action,
        fields: { questionId, expectedRevision: revision },
      };
    default:
      return undefined;
  }
}

export function activityActionRequest(
  item: ActivityItem,
  action: string,
): ProductActionRequest | undefined {
  if (action !== "archive-update" && action !== "retry-delivery")
    return undefined;
  if (
    item.kind !== "signal-update" &&
    item.kind !== "signal-decision" &&
    item.kind !== "signal-history"
  )
    return undefined;
  const source = item.source;
  const revision = numberValue(source.revision ?? 0);
  if (action === "archive-update")
    return {
      action,
      fields: { updateId: item.entityId, expectedRevision: revision },
    };
  const questionId = stringValue(
    source.questionId ?? source.id ?? item.entityId,
  );
  const answerId = stringValue(source.answerId ?? "");
  if (!answerId) return undefined;
  return {
    action,
    fields: { questionId, answerId, expectedRevision: revision },
  };
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .trim()
    .slice(0, 4_000);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Number(value) || 0;
}
