import type { AgentBoardProjection } from "../shared/provider-projections.js";
import {
  selectBoardPresentation,
  type BoardRecord,
} from "./board-presentation.js";

export type SignalsEntityType = "question" | "update" | "decision";
export type SignalsResponseKind =
  "single" | "multiple" | "text" | "single_or_text" | "multiple_or_text";

export interface SignalsOptionPresentation {
  id: string;
  label: string;
  description?: string;
}

export interface SignalsQuestionPresentation {
  entityType: "question";
  rowId: string;
  entityId: string;
  displayId: string;
  title: string;
  statusLabel: string;
  changedAt: string;
  revision: number;
  prompt: string;
  responseKind: SignalsResponseKind;
  options: readonly SignalsOptionPresentation[];
  recommendedOptionIds: readonly string[];
  recommendedText?: string;
  userAnswerable: boolean;
  dismissible: boolean;
  retryableDelivery: boolean;
  deliveryPending: boolean;
  awaitingAcknowledgement: boolean;
  answerId?: string;
  answer?: BoardRecord;
  acknowledgement?: BoardRecord;
  latestDeliveryAttempt?: BoardRecord;
  stale: boolean;
  terminal: boolean;
  terminalAt?: string;
  terminalKind?: string;
  answerSummary?: string;
  acknowledgementOutcome?: string;
  deliveryState: string;
}

export interface SignalsUpdatePresentation {
  entityType: "update";
  rowId: string;
  entityId: string;
  displayId: string;
  title: string;
  statusLabel: string;
  changedAt: string;
  revision: number;
  kind: string;
  recentTerminal: boolean;
  archived: boolean;
  terminal: boolean;
  terminalAt?: string;
  terminalKind?: string;
  stage?: string;
  detail?: string;
  progress?: BoardRecord;
  attachments: readonly BoardRecord[];
  createdAt?: string;
  updatedAt?: string;
  item: BoardRecord;
}

export interface SignalsDecisionPresentation {
  entityType: "decision";
  rowId: string;
  entityId: string;
  displayId: string;
  title: string;
  statusLabel: string;
  changedAt: string;
  revision: number;
  outcome: "applied" | "superseded";
  questionId?: string;
  answerId?: string;
  question?: string;
  answerSummary?: string;
  acknowledgementOutcome?: string;
  decidedAt?: string;
  resolvedAt?: string;
  decision: BoardRecord;
}

export type SignalsPresentation =
  | SignalsQuestionPresentation
  | SignalsUpdatePresentation
  | SignalsDecisionPresentation;

export interface SignalsPresentationSource {
  projection: AgentBoardProjection | undefined;
  tab: "inbox" | "updates" | "decisions" | "history";
  row: BoardRecord;
  detail: BoardRecord;
}

/**
 * Shared contract boundary for Board, question modal, Activity, actions, and
 * render dependencies. Implementations must preserve raw entity IDs while
 * sanitizing only display fields.
 */
export interface SignalsPresentationNormalizer {
  normalize(source: SignalsPresentationSource): SignalsPresentation | undefined;
}

const record = (value: unknown): BoardRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as BoardRecord)
    : {};
const raw = (value: unknown): string =>
  typeof value === "string" ? value : "";
const display = (value: unknown, fallback = ""): string =>
  (raw(value) || fallback)
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
      " ",
    )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 4_000);
const revision = (...values: unknown[]): number => {
  const value = values.find(Number.isSafeInteger);
  return typeof value === "number" && value >= 0 ? value : 0;
};
const responseKinds = new Set<SignalsResponseKind>([
  "single",
  "multiple",
  "text",
  "single_or_text",
  "multiple_or_text",
]);

/** Normalize one actual Signals v2 row/detail pair at the static contract boundary. */
export function normalizeSignalsPresentation(
  source: SignalsPresentationSource,
): SignalsPresentation | undefined {
  const detail = record(source.detail);
  const projection = record(detail.projection);
  const nested = {
    ...source.row,
    ...record(projection.item ?? detail.item ?? detail.decision ?? detail),
  };
  const entityType =
    raw(detail.entityType) ||
    (source.tab === "inbox"
      ? "question"
      : source.tab === "decisions"
        ? "decision"
        : "update");
  const rowId = raw(source.row.id) || raw(source.row.entityId);
  const entityId =
    raw(source.row.entityId) || raw(nested.id) || rowId.replace(/^[^:]+:/u, "");
  if (!rowId || !entityId) return undefined;
  const common = {
    rowId,
    entityId,
    displayId: display(source.row.displayId, entityId),
    title: display(source.row.title, entityId),
    statusLabel: display(source.row.statusLabel, "unknown"),
    changedAt: raw(source.row.changedAt),
    revision: revision(
      nested.revision,
      projection.revision,
      source.row.revision,
    ),
  };
  if (entityType === "question") {
    const response = record(nested.response);
    const kind = raw(response.kind) as SignalsResponseKind;
    if (!responseKinds.has(kind)) return undefined;
    const options = Array.isArray(response.options)
      ? response.options.flatMap((value) => {
          const option = record(value);
          const id = raw(option.id);
          const label = display(option.label);
          return id && label
            ? [
                {
                  id,
                  label,
                  ...(display(option.description)
                    ? { description: display(option.description) }
                    : {}),
                },
              ]
            : [];
        })
      : [];
    const answer = record(projection.answer);
    const answerId = raw(answer.id ?? answer.answerId);
    const retryableDelivery = projection.retryableDelivery === true;
    const userAnswerable = projection.userAnswerable === true;
    return {
      entityType: "question",
      ...common,
      prompt: display(
        nested.question ?? nested.prompt ?? nested.title,
        entityId,
      ),
      responseKind: kind,
      options,
      recommendedOptionIds: Array.isArray(nested.recommendedOptionIds)
        ? nested.recommendedOptionIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [],
      ...(display(nested.recommendedText)
        ? { recommendedText: display(nested.recommendedText) }
        : {}),
      userAnswerable,
      dismissible: projection.dismissible === true,
      retryableDelivery,
      deliveryPending: projection.deliveryPending === true,
      awaitingAcknowledgement: projection.awaitingAcknowledgement === true,
      ...(answerId ? { answerId } : {}),
      ...(Object.keys(answer).length ? { answer } : {}),
      ...(Object.keys(record(projection.acknowledgement)).length
        ? { acknowledgement: record(projection.acknowledgement) }
        : {}),
      ...(Object.keys(record(projection.latestDeliveryAttempt)).length
        ? { latestDeliveryAttempt: record(projection.latestDeliveryAttempt) }
        : {}),
      stale: projection.stale === true,
      terminal: !userAnswerable && !retryableDelivery,
      ...(display(answer.value ?? answer.text)
        ? { answerSummary: display(answer.value ?? answer.text) }
        : {}),
      ...(display(record(projection.acknowledgement).outcome)
        ? {
            acknowledgementOutcome: display(
              record(projection.acknowledgement).outcome,
            ),
          }
        : {}),
      deliveryState:
        projection.deliveryPending === true ? "pending" : "settled",
      ...(raw(detail.terminalAt) ? { terminalAt: raw(detail.terminalAt) } : {}),
      ...(raw(detail.terminalKind)
        ? { terminalKind: raw(detail.terminalKind) }
        : {}),
    };
  }
  if (entityType === "decision") {
    const outcome = raw(nested.outcome);
    if (outcome !== "applied" && outcome !== "superseded") return undefined;
    const decisionAnswer = record(nested.answer);
    const decisionAcknowledgement = record(nested.acknowledgement);
    return {
      entityType: "decision",
      ...common,
      outcome,
      ...(raw(nested.questionId) ? { questionId: raw(nested.questionId) } : {}),
      ...(raw(nested.answerId) ? { answerId: raw(nested.answerId) } : {}),
      ...(display(nested.question)
        ? { question: display(nested.question) }
        : {}),
      ...(display(decisionAnswer.value ?? decisionAnswer.text)
        ? {
            answerSummary: display(decisionAnswer.value ?? decisionAnswer.text),
          }
        : {}),
      ...(display(decisionAcknowledgement.outcome)
        ? {
            acknowledgementOutcome: display(decisionAcknowledgement.outcome),
          }
        : {}),
      ...(raw(nested.decidedAt) ? { decidedAt: raw(nested.decidedAt) } : {}),
      ...(raw(nested.resolvedAt) ? { resolvedAt: raw(nested.resolvedAt) } : {}),
      decision: nested,
    };
  }
  const kind = raw(source.row.kind ?? nested.kind);
  const terminalAt = raw(detail.terminalAt ?? nested.terminalAt);
  const terminal =
    source.row.recentTerminal === true ||
    terminalAt.length > 0 ||
    ["completed", "failed", "archived"].includes(kind);
  return {
    entityType: "update",
    ...common,
    kind,
    recentTerminal: source.row.recentTerminal === true,
    archived: nested.archived === true || kind === "archived",
    terminal,
    ...(terminalAt ? { terminalAt } : {}),
    ...(raw(detail.terminalKind)
      ? { terminalKind: raw(detail.terminalKind) }
      : {}),
    ...(display(nested.stage) ? { stage: display(nested.stage) } : {}),
    ...(display(nested.detail) ? { detail: display(nested.detail) } : {}),
    ...(Object.keys(record(nested.progress)).length
      ? { progress: record(nested.progress) }
      : {}),
    attachments: Array.isArray(nested.attachments)
      ? nested.attachments.map(record).slice(0, 64)
      : [],
    ...(raw(nested.createdAt) ? { createdAt: raw(nested.createdAt) } : {}),
    ...(raw(nested.updatedAt) ? { updatedAt: raw(nested.updatedAt) } : {}),
    item: nested,
  };
}

export const signalsPresentationNormalizer: SignalsPresentationNormalizer = {
  normalize: normalizeSignalsPresentation,
};

export type SignalsTab = "inbox" | "updates" | "decisions" | "history";

/** Select and normalize one complete Signals tab. This is the only active row/detail parser. */
export function selectSignalsTabPresentation(
  projection: AgentBoardProjection | undefined,
  tab: SignalsTab,
): SignalsPresentation[] {
  const tabPresentation = selectBoardPresentation(projection, tab);
  return tabPresentation.rows.flatMap((row) => {
    const rowId = raw(row.id) || raw(row.entityId);
    if (!rowId) return [];
    const detail = selectBoardPresentation(projection, tab, rowId).detail;
    const normalized = normalizeSignalsPresentation({
      projection,
      tab,
      row,
      detail: record(detail),
    });
    if (normalized) return [normalized];
    if (tab !== "inbox") return [];
    const pending = projection?.pendingQuestions?.find(
      (question) => question.questionId === raw(row.entityId ?? row.id),
    );
    if (!pending) return [];
    const fallback = normalizeSignalsPresentation({
      projection,
      tab,
      row,
      detail: {
        entityType: "question",
        projection: {
          item: {
            id: pending.questionId,
            question: pending.question,
            revision: pending.revision,
            response: pending.response,
            recommendedOptionIds: pending.recommendedOptionIds,
            recommendedText: pending.recommendedText,
          },
          userAnswerable: row.userAnswerable !== false,
          dismissible: row.dismissible === true,
          retryableDelivery: row.retryableDelivery === true,
          deliveryPending: row.deliveryPending === true,
          awaitingAcknowledgement: row.awaitingAcknowledgement === true,
        },
      },
    });
    return fallback ? [fallback] : [];
  });
}

export function selectSignalsQuestion(
  projection: AgentBoardProjection | undefined,
  questionId: string,
): SignalsQuestionPresentation | undefined {
  return selectSignalsTabPresentation(projection, "inbox").find(
    (item): item is SignalsQuestionPresentation =>
      item.entityType === "question" &&
      (item.entityId === questionId || item.rowId === questionId),
  );
}

export function selectSignalsUpdate(
  projection: AgentBoardProjection | undefined,
  entityId: string,
): SignalsUpdatePresentation | undefined {
  const candidates = [
    ...selectSignalsTabPresentation(projection, "updates"),
    ...selectSignalsTabPresentation(projection, "history"),
  ];
  return candidates.find(
    (item): item is SignalsUpdatePresentation =>
      item.entityType === "update" &&
      (item.entityId === entityId || item.rowId === entityId),
  );
}

export function selectSignalsDecision(
  projection: AgentBoardProjection | undefined,
  entityId: string,
): SignalsDecisionPresentation | undefined {
  return selectSignalsTabPresentation(projection, "decisions").find(
    (item): item is SignalsDecisionPresentation =>
      item.entityType === "decision" &&
      (item.entityId === entityId || item.rowId === entityId),
  );
}

export function selectSignalsHistoryItem(
  projection: AgentBoardProjection | undefined,
  rowIdOrEntityId: string,
): SignalsPresentation | undefined {
  return selectSignalsTabPresentation(projection, "history").find(
    (item) =>
      item.rowId === rowIdOrEntityId || item.entityId === rowIdOrEntityId,
  );
}

/** Select Activity records with History taking precedence for terminal entities. */
export function selectSignalsActivityItems(
  projection: AgentBoardProjection | undefined,
): SignalsPresentation[] {
  const history = selectSignalsTabPresentation(projection, "history");
  const historyKeys = new Set(
    history.map((item) => `${item.entityType}:${item.entityId}`),
  );
  const terminalUpdates = selectSignalsTabPresentation(
    projection,
    "updates",
  ).filter(
    (item): item is SignalsUpdatePresentation =>
      item.entityType === "update" &&
      item.terminal &&
      !historyKeys.has(`update:${item.entityId}`),
  );
  return [
    ...history,
    ...terminalUpdates,
    ...selectSignalsTabPresentation(projection, "decisions"),
  ];
}
