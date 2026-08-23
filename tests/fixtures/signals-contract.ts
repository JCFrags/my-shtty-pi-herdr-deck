import type { QuestionResponseSelection } from "../../src/deck/question-response.js";
import type { NormalizedQuestion } from "../../src/deck/product-presentation.js";

export interface SignalsAnswerFixture {
  readonly kind: NormalizedQuestion["responseKind"];
  readonly selection: QuestionResponseSelection;
  readonly answer: Record<string, unknown>;
}

export const SIGNALS_ANSWER_FIXTURES: readonly SignalsAnswerFixture[] = [
  {
    kind: "single",
    selection: { selectedOptionIds: ["first"], text: "" },
    answer: { kind: "single", optionId: "first" },
  },
  {
    kind: "multiple",
    selection: { selectedOptionIds: ["first", "second"], text: "" },
    answer: { kind: "multiple", optionIds: ["first", "second"] },
  },
  {
    kind: "text",
    selection: { selectedOptionIds: [], text: "free text" },
    answer: { kind: "text", text: "free text" },
  },
  {
    kind: "single_or_text",
    selection: { selectedOptionIds: ["second"], text: "extra context" },
    answer: {
      kind: "single_or_text",
      optionId: "second",
      text: "extra context",
    },
  },
  {
    kind: "multiple_or_text",
    selection: { selectedOptionIds: ["first"], text: "extra context" },
    answer: {
      kind: "multiple_or_text",
      optionIds: ["first"],
      text: "extra context",
    },
  },
];
