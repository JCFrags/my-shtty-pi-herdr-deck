import type { NormalizedQuestion } from "./product-presentation.js";

export interface QuestionResponseSelection {
  selectedOptionIds: readonly string[];
  text: string;
}

/** Signals persists the response mode in the answer value. */
export type SignalsQuestionAnswer =
  | { kind: "single"; optionId: string }
  | { kind: "multiple"; optionIds: string[] }
  | { kind: "text"; text: string }
  | { kind: "single_or_text"; optionId?: string; text?: string }
  | { kind: "multiple_or_text"; optionIds: string[]; text?: string };

const MAX_ANSWER_TEXT_CODE_POINTS = 4_000;
const RESPONSE_KINDS = new Set<NormalizedQuestion["responseKind"]>([
  "single",
  "multiple",
  "text",
  "single_or_text",
  "multiple_or_text",
]);

/** Build the broker wire answer. Broker questions accept one option or free text. */
export function buildBrokerQuestionAnswer(
  question: NormalizedQuestion,
  selection: QuestionResponseSelection,
): { optionId: string | null; text: string | null } {
  const ids = validOptionIds(question, selection.selectedOptionIds);
  const text = answerText(selection.text);
  if (ids.length > 0) return { optionId: ids[0]!, text: null };
  if (text && question.allowFreeform) return { optionId: null, text };
  throw new Error("Select an option or enter an answer.");
}

/** Build the exact provider payload for the current Signals response kind. */
export function buildSignalsQuestionAnswer(
  question: NormalizedQuestion,
  selection: QuestionResponseSelection,
): SignalsQuestionAnswer {
  if (!RESPONSE_KINDS.has(question.responseKind))
    throw new Error("The Signals question response kind is invalid.");
  const ids = validOptionIds(question, selection.selectedOptionIds);
  const text = answerText(selection.text);
  switch (question.responseKind) {
    case "single":
      if (ids.length !== 1) throw new Error("Select one option.");
      return { kind: "single", optionId: ids[0]! };
    case "multiple":
      if (ids.length === 0) throw new Error("Select at least one option.");
      return { kind: "multiple", optionIds: ids };
    case "text":
      if (!text) throw new Error("Enter an answer.");
      return { kind: "text", text };
    case "single_or_text":
      if (ids.length > 1)
        throw new Error("Select one option or enter an answer.");
      if (ids.length === 1 || text)
        return {
          kind: "single_or_text",
          ...(ids.length === 1 ? { optionId: ids[0] } : {}),
          ...(text ? { text } : {}),
        };
      throw new Error("Select one option or enter an answer.");
    case "multiple_or_text":
      if (ids.length > 0 || text)
        return {
          kind: "multiple_or_text",
          optionIds: ids,
          ...(text ? { text } : {}),
        };
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
  if (!Array.isArray(selected))
    throw new Error("Selected options are invalid.");
  const options = question.options;
  const allowed = new Map(options.map((option, index) => [option.id, index]));
  if (allowed.size !== options.length)
    throw new Error("The question options are invalid.");
  const selectedIds = new Set<string>();
  for (const id of selected) {
    if (typeof id !== "string" || !allowed.has(id))
      throw new Error("The selected option is not available.");
    if (selectedIds.has(id)) throw new Error("An option was selected twice.");
    selectedIds.add(id);
  }
  return options.map((option) => option.id).filter((id) => selectedIds.has(id));
}

function answerText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Answer text is invalid.");
  const normalized = value.trim();
  if ([...normalized].length > MAX_ANSWER_TEXT_CODE_POINTS)
    throw new Error("Answer text is too long.");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized))
    throw new Error("Answer text contains unsupported control characters.");
  return normalized;
}
