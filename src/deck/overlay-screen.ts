import type { NormalizedQuestion } from "./product-presentation.js";

export type OverlayState =
  | { kind: "none" }
  | { kind: "settings"; scroll: number }
  | { kind: "help"; scroll: number }
  | { kind: "agent-more"; agentId: string; generation: number; scroll: number }
  | {
      kind: "confirm";
      action: string;
      targetId: string;
      expectedGeneration?: number;
      expectedRevision?: number;
      summary: string;
      pending: boolean;
      error?: string;
    }
  | {
      kind: "text-input";
      purpose: string;
      targetId?: string;
      value: string;
      error?: string;
    }
  | {
      kind: "question-response";
      question: NormalizedQuestion;
      selectedOptionIds: string[];
      text: string;
      error?: string;
    };

export function questionResponseValid(
  state: Extract<OverlayState, { kind: "question-response" }>,
): boolean {
  const { question } = state;
  const hasOptions = state.selectedOptionIds.length > 0;
  const hasText = state.text.trim().length > 0;
  switch (question.responseKind) {
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
      : [...state.selectedOptionIds, optionId]
    : [optionId];
  return { ...state, selectedOptionIds };
}

export function applyQuestionRecommendation(
  state: Extract<OverlayState, { kind: "question-response" }>,
): Extract<OverlayState, { kind: "question-response" }> {
  const allowed = new Set(state.question.options.map((option) => option.id));
  return {
    ...state,
    selectedOptionIds: state.question.recommendedOptionIds.filter((id) =>
      allowed.has(id),
    ),
    text: state.question.recommendedText ?? state.text,
  };
}
