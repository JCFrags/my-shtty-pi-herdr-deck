import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBrokerQuestionAnswer,
  buildSignalsQuestionAnswer,
} from "../../src/deck/question-response.js";
import {
  boardIsNarrow,
  renderBoardScreen,
} from "../../src/deck/board-screen.js";
import type { NormalizedQuestion } from "../../src/deck/product-presentation.js";

const question = (
  responseKind: NormalizedQuestion["responseKind"],
): NormalizedQuestion => ({
  source: "signals",
  uiId: "signals:question:q",
  entityId: "q",
  prompt: "Pick",
  responseKind,
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
  allowFreeform: responseKind.includes("text"),
  recommendedOptionIds: [],
  dismissible: true,
  retryableDelivery: false,
  terminal: false,
});

test("question payload builders cover broker and all Signals response kinds", () => {
  assert.deepEqual(
    buildBrokerQuestionAnswer(
      { ...question("single"), source: "orchestrator" },
      { selectedOptionIds: ["a"], text: "" },
    ),
    { optionId: "a", text: null },
  );
  assert.deepEqual(
    buildSignalsQuestionAnswer(question("single"), {
      selectedOptionIds: ["a"],
      text: "",
    }),
    { kind: "option", optionId: "a" },
  );
  assert.deepEqual(
    buildSignalsQuestionAnswer(question("multiple"), {
      selectedOptionIds: ["a", "b"],
      text: "",
    }),
    { kind: "options", optionIds: ["a", "b"] },
  );
  assert.deepEqual(
    buildSignalsQuestionAnswer(question("text"), {
      selectedOptionIds: [],
      text: "free",
    }),
    { kind: "text", text: "free" },
  );
  assert.deepEqual(
    buildSignalsQuestionAnswer(question("single_or_text"), {
      selectedOptionIds: [],
      text: "free",
    }),
    { kind: "text", text: "free" },
  );
  assert.deepEqual(
    buildSignalsQuestionAnswer(question("multiple_or_text"), {
      selectedOptionIds: ["b"],
      text: "",
    }),
    { kind: "options", optionIds: ["b"] },
  );
});

test("Board emits source badges and uses stacked narrow / column wide layouts", () => {
  const item = {
    uiId: "signals:question:q",
    id: "signals:question:q",
    entityId: "q",
    kind: "signal-question" as const,
    source: {},
    sourceLabel: "SIGNALS" as const,
    title: "Pick",
    summary: "Answer",
    state: "open",
    status: "open",
    section: "attention" as const,
    priority: 1,
    sortTimestamp: "",
    actions: { actions: ["answer"] },
  };
  const model = {
    attention: [item],
    work: [],
    recentSignals: [],
    visible: [item],
    selected: item,
    counts: { attention: 1, work: 0, recentSignals: 0 },
    filter: "all-current" as const,
  };
  const state = {
    filter: "all-current" as const,
    selectedId: item.uiId,
    listScroll: 0,
    detailScroll: 0,
    wheelDetached: false,
  };
  const narrow = renderBoardScreen({
    width: 70,
    height: 24,
    state,
    model,
    actions: { select() {}, filter() {}, answer() {}, run() {} },
  });
  const wide = renderBoardScreen({
    width: 120,
    height: 24,
    state,
    model,
    actions: { select() {}, filter() {}, answer() {}, run() {} },
  });
  assert.equal(boardIsNarrow(70), true);
  assert.equal(boardIsNarrow(120), false);
  assert.ok(narrow.lines.some((line) => line.includes("[SIGNALS]")));
  assert.ok(wide.lines.some((line) => line.includes("[SIGNALS]")));
  assert.ok(
    wide.regions.length === 0 ||
      wide.regions.every((region) => region.width > 0),
  );
});
