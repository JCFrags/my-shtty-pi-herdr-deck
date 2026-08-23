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
