import type { NormalizedQuestion } from "./product-presentation.js";

export const MAX_OVERLAY_TEXT = 16_384;
export const MAX_OVERLAY_SELECTIONS = 64;

export type TextInputPurpose =
  | "prompt"
  | "ask"
  | "steer"
  | "followUp"
  | "create"
  | "default"
  | "files-filter"
  | "model-filter";

export type ConfirmationAction =
  "cancelTask" | "groupStop" | "groupClose" | "close" | "stop";

export interface OverlayTargetGuard {
  readonly targetId?: string;
  readonly agentId?: string;
  readonly generation?: number;
  readonly questionId?: string;
  readonly revision?: number;
}

export type OverlayFocus =
  "close" | "primary" | "secondary" | "editor" | "options" | "submit";

interface OverlayCommon {
  focus?: OverlayFocus;
  scroll?: number;
  pending?: boolean;
  error?: string;
}

export type OverlayState =
  | { kind: "none" }
  | ({ kind: "settings" } & OverlayCommon)
  | ({ kind: "help" } & OverlayCommon)
  | ({
      kind: "agent-more";
      guard: Required<Pick<OverlayTargetGuard, "agentId" | "generation">>;
    } & OverlayCommon)
  | ({
      kind: "confirm";
      action: ConfirmationAction;
      guard?: OverlayTargetGuard;
      summary: string;
    } & OverlayCommon)
  | ({
      kind: "text-input";
      purpose: TextInputPurpose;
      guard?: OverlayTargetGuard;
      value: string;
      cursor?: number;
    } & OverlayCommon)
  | ({
      kind: "question-response";
      question: NormalizedQuestion;
      guard?: Required<Pick<OverlayTargetGuard, "questionId">> &
        Pick<OverlayTargetGuard, "revision">;
      selectedOptionIds: readonly string[];
      text: string;
      cursor?: number;
    } & OverlayCommon);

export const noOverlay = (): OverlayState => ({ kind: "none" });

export function boundedOverlayText(value: string): string {
  return value.slice(0, MAX_OVERLAY_TEXT);
}

export function boundedOverlaySelections(
  ids: readonly string[],
  allowed: readonly string[],
): string[] {
  const allowedIds = new Set(allowed);
  const result: string[] = [];
  for (const id of ids) {
    if (result.length >= MAX_OVERLAY_SELECTIONS) break;
    if (allowedIds.has(id) && !result.includes(id)) result.push(id);
  }
  return result;
}

export function questionResponseValid(
  state: Extract<OverlayState, { kind: "question-response" }>,
): boolean {
  const hasOptions = state.selectedOptionIds.length > 0;
  const hasText = state.text.trim().length > 0;
  switch (state.question.responseKind) {
    case "single":
      return state.selectedOptionIds.length === 1;
    case "multiple":
      return hasOptions;
    case "text":
      return hasText;
    case "single_or_text":
      return state.selectedOptionIds.length === 1 || hasText;
    case "multiple_or_text":
      return hasOptions || hasText;
  }
}

export function toggleQuestionOption(
  state: Extract<OverlayState, { kind: "question-response" }>,
  optionId: string,
): Extract<OverlayState, { kind: "question-response" }> {
  if (!state.question.options.some((option) => option.id === optionId))
    return state;
  const multiple =
    state.question.responseKind === "multiple" ||
    state.question.responseKind === "multiple_or_text";
  const selectedOptionIds = multiple
    ? state.selectedOptionIds.includes(optionId)
      ? state.selectedOptionIds.filter((id) => id !== optionId)
      : boundedOverlaySelections(
          [...state.selectedOptionIds, optionId],
          state.question.options.map((option) => option.id),
        )
    : [optionId];
  return { ...state, selectedOptionIds };
}

export function applyQuestionRecommendation(
  state: Extract<OverlayState, { kind: "question-response" }>,
): Extract<OverlayState, { kind: "question-response" }> {
  const allowed = state.question.options.map((option) => option.id);
  return {
    ...state,
    selectedOptionIds: boundedOverlaySelections(
      state.question.recommendedOptionIds,
      allowed,
    ),
    text: boundedOverlayText(state.question.recommendedText ?? state.text),
    cursor: Math.min(
      boundedOverlayText(state.question.recommendedText ?? state.text).length,
      MAX_OVERLAY_TEXT,
    ),
  };
}
