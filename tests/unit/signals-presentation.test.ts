import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSignalsPresentation } from "../../src/deck/signals-presentation.js";

test("shared Signals normalizer consumes actual nested v2 question detail", () => {
  const value = normalizeSignalsPresentation({
    projection: undefined,
    tab: "inbox",
    row: {
      id: "question:q-1",
      entityId: "q-1",
      displayId: "Q-1",
      title: "Choose",
      statusLabel: "Waiting",
      revision: 4,
      changedAt: "2026-08-23T00:00:00Z",
    },
    detail: {
      entityType: "question",
      projection: {
        item: {
          id: "q-1",
          revision: 4,
          question: "Pick\u202e one",
          response: {
            kind: "multiple",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
          recommendedOptionIds: ["b"],
        },
        userAnswerable: true,
        dismissible: true,
        retryableDelivery: true,
        deliveryPending: false,
        awaitingAcknowledgement: true,
        answer: { id: "answer-1" },
        stale: false,
      },
    },
  });
  assert.equal(value?.entityType, "question");
  if (!value || value.entityType !== "question") throw new Error("question");
  assert.equal(value.entityId, "q-1");
  assert.equal(value.answerId, "answer-1");
  assert.equal(value.dismissible, true);
  assert.equal(value.retryableDelivery, true);
  assert.deepEqual(value.recommendedOptionIds, ["b"]);
  assert.doesNotMatch(value.prompt, /\u202e/u);
});

test("shared Signals normalizer handles terminal update and superseded decision", () => {
  const update = normalizeSignalsPresentation({
    projection: undefined,
    tab: "history",
    row: {
      id: "update:u-1",
      entityId: "u-1",
      title: "Complete",
      statusLabel: "Completed",
      recentTerminal: true,
    },
    detail: {
      entityType: "update",
      terminalAt: "2026-08-23T01:00:00Z",
      terminalKind: "completed",
      item: {
        id: "u-1",
        revision: 3,
        kind: "completed",
        stage: "done",
        detail: "Finished",
        attachments: [{ id: "artifact-1" }],
      },
    },
  });
  assert.equal(update?.entityType, "update");
  if (!update || update.entityType !== "update") throw new Error("update");
  assert.equal(update.terminal, true);
  assert.equal(update.attachments.length, 1);

  const decision = normalizeSignalsPresentation({
    projection: undefined,
    tab: "decisions",
    row: { id: "decision:d-1", entityId: "d-1", title: "Decision" },
    detail: {
      entityType: "decision",
      decision: { id: "d-1", revision: 2, outcome: "superseded" },
    },
  });
  assert.equal(decision?.entityType, "decision");
  if (!decision || decision.entityType !== "decision")
    throw new Error("decision");
  assert.equal(decision.outcome, "superseded");
});
