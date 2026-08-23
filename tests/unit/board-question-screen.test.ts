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
import type { BoardAction } from "../../src/deck/product-presentation.js";
import { buildBoardActionRequest } from "../../src/deck/actions.js";
import type { NormalizedQuestion } from "../../src/deck/product-presentation.js";
import { SIGNALS_ANSWER_FIXTURES } from "../fixtures/signals-contract.js";

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
    { kind: "single", optionId: "a" },
  );
  assert.deepEqual(
    buildSignalsQuestionAnswer(question("multiple"), {
      selectedOptionIds: ["a", "b"],
      text: "",
    }),
    { kind: "multiple", optionIds: ["a", "b"] },
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
    { kind: "single_or_text", text: "free" },
  );
  assert.deepEqual(
    buildSignalsQuestionAnswer(question("multiple_or_text"), {
      selectedOptionIds: ["b"],
      text: "",
    }),
    { kind: "multiple_or_text", optionIds: ["b"] },
  );
});

test("Signals answer fixtures preserve current kind and canonical fields", () => {
  for (const fixture of SIGNALS_ANSWER_FIXTURES)
    assert.deepEqual(
      buildSignalsQuestionAnswer(
        {
          ...question(fixture.kind),
          options: [
            { id: "first", label: "First" },
            { id: "second", label: "Second" },
          ],
        },
        fixture.selection,
      ),
      fixture.answer,
    );
});

test("Signals answer builder normalizes provider order and rejects unknown, duplicate, stale, and oversized input", () => {
  assert.throws(() =>
    buildSignalsQuestionAnswer(question("single"), {
      selectedOptionIds: ["unknown"],
      text: "",
    }),
  );
  assert.throws(() =>
    buildSignalsQuestionAnswer(question("multiple"), {
      selectedOptionIds: ["a", "a"],
      text: "",
    }),
  );
  assert.deepEqual(
    buildSignalsQuestionAnswer(question("multiple"), {
      selectedOptionIds: ["b", "a"],
      text: "",
    }),
    { kind: "multiple", optionIds: ["a", "b"] },
  );
  assert.throws(() =>
    buildSignalsQuestionAnswer(
      { ...question("single"), responseKind: "text" },
      { selectedOptionIds: ["a"], text: "" },
    ),
  );
  assert.throws(() =>
    buildSignalsQuestionAnswer(question("text"), {
      selectedOptionIds: [],
      text: "x".repeat(4_001),
    }),
  );
});

test("Board request router emits exact Signals action payloads", () => {
  assert.deepEqual(
    buildBoardActionRequest("agent-1", {
      action: "accept-recommendation",
      fields: { questionId: "q-1", expectedRevision: 4 },
    }),
    {
      ownerAgentId: "agent-1",
      questionId: "q-1",
      expectedRevision: 4,
      action: "accept-recommendation",
    },
  );
  assert.deepEqual(
    buildBoardActionRequest("agent-1", {
      action: "dismiss-question",
      fields: { questionId: "q-1", expectedRevision: 4 },
    }),
    {
      ownerAgentId: "agent-1",
      questionId: "q-1",
      expectedRevision: 4,
      action: "dismiss-question",
    },
  );
  assert.deepEqual(
    buildBoardActionRequest("agent-1", {
      action: "retry-delivery",
      fields: { questionId: "q-1", answerId: "a-1", expectedRevision: 4 },
    }),
    {
      ownerAgentId: "agent-1",
      questionId: "q-1",
      answerId: "a-1",
      expectedRevision: 4,
      action: "retry-delivery",
    },
  );
  assert.deepEqual(
    buildBoardActionRequest("agent-1", {
      action: "archive-update",
      fields: { updateId: "u-1", expectedRevision: 7 },
    }),
    {
      ownerAgentId: "agent-1",
      updateId: "u-1",
      expectedRevision: 7,
      action: "archive-update",
    },
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
    actions: { actions: ["answer"] as BoardAction[] },
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
  for (const height of [18, 24]) {
    assert.ok(
      renderBoardScreen({
        width: 70,
        height,
        state,
        model,
        actions: { select() {}, filter() {}, answer() {}, run() {} },
      }).hitBoxes.some((box) => box.id === "board:answer"),
    );
  }
  assert.ok(
    wide.regions.length === 0 ||
      wide.regions.every((region) => region.width > 0),
  );
});
