import type { AgentBoardProjection } from "../shared/provider-projections.js";
import type { BoardRecord } from "./board-presentation.js";

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
  const nested = record(
    projection.item ?? detail.item ?? detail.decision ?? detail,
  );
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
      ...(raw(detail.terminalAt) ? { terminalAt: raw(detail.terminalAt) } : {}),
      ...(raw(detail.terminalKind)
        ? { terminalKind: raw(detail.terminalKind) }
        : {}),
    };
  }
  if (entityType === "decision") {
    const outcome = raw(nested.outcome);
    if (outcome !== "applied" && outcome !== "superseded") return undefined;
    return { entityType: "decision", ...common, outcome, decision: nested };
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
    item: nested,
  };
}

export const signalsPresentationNormalizer: SignalsPresentationNormalizer = {
  normalize: normalizeSignalsPresentation,
};
