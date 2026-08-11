import test from "node:test";
import assert from "node:assert/strict";
import {
  BudgetController,
  graceExpired,
  selectTerminalOutcome,
} from "../../src/scheduler/budget-controller.js";

type Budget = ConstructorParameters<typeof BudgetController>[0];
const budget: Budget = { wallTimeMs: 10_000, softPercent: 80, graceMs: 1_000 };

test("controller emits one warning and preserves unknown usage dimensions", () => {
  const controller = new BudgetController(budget);
  const first = controller.evaluate(
    { wallTimeMs: 8_000, unavailable: ["costUsd"] },
    8_000,
  );
  assert.equal(first.action, "warning");
  assert.equal(first.warning, true);
  assert.deepEqual(first.assessment.unavailable, ["costUsd"]);
  controller.markWarningSent();
  assert.equal(
    controller.evaluate({ wallTimeMs: 8_100, unavailable: ["costUsd"] }, 8_100)
      .warning,
    false,
  );
});

test("controller requests graceful stop, then force stop after the grace period", () => {
  const controller = new BudgetController(budget);
  const graceful = controller.evaluate(
    { wallTimeMs: 10_000, unavailable: [] },
    10_000,
  );
  assert.equal(graceful.action, "graceful_stop");
  assert.equal(controller.terminalOutcome(undefined, graceful), undefined);
  assert.equal(controller.terminalOutcome("succeeded", graceful), "succeeded");
  assert.equal(graceful.graceStartedAtMs, 10_000);
  assert.equal(graceExpired(graceful.graceStartedAtMs, 10_999, 1_000), false);
  const forced = controller.evaluate(
    { wallTimeMs: 10_000, unavailable: [] },
    11_000,
  );
  assert.equal(forced.action, "force_stop");
  assert.equal(controller.terminalOutcome(undefined, forced), "timed_out");
  assert.equal(controller.terminalOutcome("succeeded", forced), "succeeded");
  assert.equal(forced.graceExpiresAtMs, 11_000);
});

test("graceful breach requests stop but leaves terminal outcome unchanged", () => {
  assert.equal(selectTerminalOutcome("graceful_stop", undefined), undefined);
  assert.equal(selectTerminalOutcome("graceful_stop", "failed"), "failed");
  assert.equal(
    selectTerminalOutcome("graceful_stop", "succeeded"),
    "succeeded",
  );
});

test("force stop selects timeout only when no valid terminal outcome exists", () => {
  assert.equal(selectTerminalOutcome("force_stop", undefined), "timed_out");
  assert.equal(selectTerminalOutcome("force_stop", "succeeded"), "succeeded");
  assert.equal(selectTerminalOutcome("force_stop", "failed"), "failed");
  assert.equal(selectTerminalOutcome("none", "succeeded"), "succeeded");
  assert.equal(selectTerminalOutcome("warning", "cancelled"), "cancelled");
});
