import assert from "node:assert/strict";
import test from "node:test";
import {
  applyQuestionRecommendation,
  questionResponseValid,
  toggleQuestionOption,
  type OverlayState,
} from "../../src/deck/overlay-screen.js";
import type { NormalizedQuestion } from "../../src/deck/product-presentation.js";

const question = (
  responseKind: NormalizedQuestion["responseKind"],
): NormalizedQuestion => ({
  source: "signals",
  uiId: "signals:question:q1",
  entityId: "q1",
  revision: 2,
  prompt: "Choose",
  responseKind,
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
  allowFreeform: responseKind.includes("text"),
  recommendedOptionIds: ["b"],
  recommendedText: "recommended",
  dismissible: true,
  retryableDelivery: false,
  terminal: false,
});
const state = (
  kind: NormalizedQuestion["responseKind"],
): Extract<OverlayState, { kind: "question-response" }> => ({
  kind: "question-response",
  question: question(kind),
  selectedOptionIds: [],
  text: "",
});

test("question modal validates all five response forms", () => {
  assert.equal(questionResponseValid(state("single")), false);
  assert.equal(
    questionResponseValid(toggleQuestionOption(state("single"), "a")),
    true,
  );
  assert.equal(questionResponseValid(state("multiple")), false);
  assert.equal(
    questionResponseValid(toggleQuestionOption(state("multiple"), "a")),
    true,
  );
  assert.equal(
    questionResponseValid({ ...state("text"), text: "answer" }),
    true,
  );
  assert.equal(
    questionResponseValid({ ...state("single_or_text"), text: "answer" }),
    true,
  );
  assert.equal(
    questionResponseValid(toggleQuestionOption(state("multiple_or_text"), "a")),
    true,
  );
});

test("single replaces, multiple toggles, and recommendation is bounded", () => {
  const single = toggleQuestionOption(
    toggleQuestionOption(state("single"), "a"),
    "b",
  );
  assert.deepEqual(single.selectedOptionIds, ["b"]);
  let multiple = toggleQuestionOption(state("multiple"), "a");
  multiple = toggleQuestionOption(multiple, "b");
  assert.deepEqual(multiple.selectedOptionIds, ["a", "b"]);
  multiple = toggleQuestionOption(multiple, "a");
  assert.deepEqual(multiple.selectedOptionIds, ["b"]);
  const recommended = applyQuestionRecommendation(state("multiple_or_text"));
  assert.deepEqual(recommended.selectedOptionIds, ["b"]);
  assert.equal(recommended.text, "recommended");
});
