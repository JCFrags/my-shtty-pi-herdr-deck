import type { NormalizedQuestion } from "./product-presentation.js";

export interface QuestionResponseSelection {
  selectedOptionIds: readonly string[];
  text: string;
}

export type SignalsQuestionAnswer =
  | { kind: "option"; optionId: string }
  | { kind: "options"; optionIds: string[] }
  | { kind: "text"; text: string };

/** Build the broker wire answer. Broker questions accept one option or free text. */
export function buildBrokerQuestionAnswer(
  question: NormalizedQuestion,
  selection: QuestionResponseSelection,
): { optionId: string | null; text: string | null } {
  const ids = validOptionIds(question, selection.selectedOptionIds);
  const text = selection.text.trim();
  if (ids.length > 0) return { optionId: ids[0]!, text: null };
  if (text && question.allowFreeform) return { optionId: null, text };
  throw new Error("Select an option or enter an answer.");
}

/** Build the provider payload for every Signals response kind. */
export function buildSignalsQuestionAnswer(
  question: NormalizedQuestion,
  selection: QuestionResponseSelection,
): SignalsQuestionAnswer {
  const ids = validOptionIds(question, selection.selectedOptionIds);
  const text = selection.text.trim();
  switch (question.responseKind) {
    case "single":
      if (ids.length !== 1) throw new Error("Select one option.");
      return { kind: "option", optionId: ids[0]! };
    case "multiple":
      if (ids.length === 0) throw new Error("Select at least one option.");
      return { kind: "options", optionIds: ids };
    case "text":
      if (!text) throw new Error("Enter an answer.");
      return { kind: "text", text };
    case "single_or_text":
      if (ids.length === 1) return { kind: "option", optionId: ids[0]! };
      if (text) return { kind: "text", text };
      throw new Error("Select one option or enter an answer.");
    case "multiple_or_text":
      if (ids.length > 0) return { kind: "options", optionIds: ids };
      if (text) return { kind: "text", text };
      throw new Error("Select options or enter an answer.");
  }
}

export function buildQuestionResponsePayload(
  question: NormalizedQuestion,
  selection: QuestionResponseSelection,
): { source: NormalizedQuestion["source"]; answer: unknown } {
  return {
    source: question.source,
    answer:
      question.source === "signals"
        ? buildSignalsQuestionAnswer(question, selection)
        : buildBrokerQuestionAnswer(question, selection),
  };
}

function validOptionIds(
  question: NormalizedQuestion,
  selected: readonly string[],
): string[] {
  const allowed = new Set(question.options.map((option) => option.id));
  return [...new Set(selected)].filter((id) => allowed.has(id));
}
