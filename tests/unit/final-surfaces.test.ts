import assert from "node:assert/strict";
import test from "node:test";
import { activityDetail, applyActivityWheel } from "../../src/deck/activity.js";
import {
  activateAgentMore,
  agentMoreFocusFromMouse,
  agentMoreGuard,
  agentPrimaryActions,
  handleAgentMoreKey,
  isAgentMoreGuardCurrent,
  openAgentMore,
  renderAgents,
} from "../../src/deck/agents.js";
import type { DeckState } from "../../src/deck/types.js";
import type { Agent } from "../../src/state/types.js";

const agent = (id: string, displayName: string): Agent => ({
  id,
  displayName,
  state: "working",
  generation: 3,
});
const state = (agents: Agent[]): DeckState => ({
  seq: 1,
  agents: new Map(agents.map((item) => [item.id, item])),
  tasks: new Map(),
  runs: new Map(),
  workflows: new Map(),
  groups: new Map(),
  questions: new Map(),
  results: new Map(),
  providerProjections: new Map(),
});

test("Activity wheel scrolls the pane under the pointer without selecting", () => {
  const initial = {
    filter: "all" as const,
    selectedId: "keep",
    listScroll: 2,
    detailScroll: 4,
    wheelDetached: false,
  };
  const result = applyActivityWheel(initial, "list", "down");
  assert.equal(result.handled, true);
  assert.equal(result.state.selectedId, "keep");
  assert.equal(result.state.listScroll, 3);
  assert.equal(result.state.detailScroll, 4);
  assert.equal(result.state.wheelDetached, true);
});

test("Agents use ID hitboxes when display names are duplicated", () => {
  const value = state([agent("a-1", "same"), agent("a-2", "same")]);
  const surface = renderAgents({
    state: value,
    screen: { filter: "active", requestedPage: 0 },
    width: 120,
  });
  const rows = surface.hitBoxes.filter((box) =>
    box.id.startsWith("agents:row:"),
  );
  assert.deepEqual(
    rows.map((box) => box.id),
    ["agents:row:a-2", "agents:row:a-1"],
  );
});

test("Agent primary actions come from authorization and More is generation guarded", () => {
  const value = state([agent("a-1", "worker")]);
  const selected = value.agents.get("a-1")!;
  const actions = agentPrimaryActions(selected, {
    authorize: (action) => (action === "focus" ? "no pane" : undefined),
    activate: () => undefined,
  });
  assert.deepEqual(
    actions.map((item) => item.label),
    [
      "Focus",
      "Prompt",
      "Ask",
      "Steer",
      "Follow-up",
      "Interrupt",
      "Stop",
      "More",
    ],
  );
  assert.equal(actions.find((item) => item.action === "focus")?.disabled, true);
  assert.equal(
    actions.find((item) => item.action === "prompt")?.disabled,
    false,
  );
  const guard = agentMoreGuard(selected)!;
  assert.equal(isAgentMoreGuardCurrent(value, guard), true);
  const more = openAgentMore(value, guard)!;
  assert.deepEqual(
    more.actions.map((item) => item.label),
    [
      "Compact",
      "Restart",
      "Close",
      "Open worktree",
      "Copy ID",
      "Running model",
      "Thinking level",
      "Create child agent",
    ],
  );
  assert.equal(agentMoreFocusFromMouse(more, 2).focusedIndex, 2);
  assert.equal(
    handleAgentMoreKey(more, "ArrowDown", value, {
      authorize: () => undefined,
      activate: () => undefined,
    }).presentation?.focusedIndex,
    1,
  );
  let called = false;
  more.focusedIndex = more.actions.findIndex((item) => item.id === "copyId");
  assert.equal(
    activateAgentMore(value, more, {
      authorize: () => undefined,
      activate: () => {
        called = true;
      },
    }),
    true,
  );
  assert.equal(called, true);
  value.agents.set("a-1", { ...selected, generation: 4 });
  assert.equal(isAgentMoreGuardCurrent(value, guard), false);
  assert.equal(openAgentMore(value, guard), undefined);
});

test("Activity detail preserves typed Signals and system fields", () => {
  const signal = activityDetail({
    uiId: "signals:updates:s-1",
    id: "signals:updates:s-1",
    entityId: "s-1",
    kind: "signal-update",
    title: "Update",
    summary: "Detail",
    state: "active",
    status: "active",
    sortTimestamp: "2026-01-01",
    source: {
      id: "s-1",
      title: "Update",
      detail: "Detail",
      stage: "build",
      changedAt: "2026-01-01",
      revision: 4,
      deliveryState: "delivered",
      retryableDelivery: true,
      archivable: true,
    },
    actions: { actions: ["archive", "retry-delivery"] },
  });
  assert.equal(signal.kind, "signal-update");
  assert.equal(signal.revision, 4);
  assert.equal(signal.retryableDelivery, true);
  const system = activityDetail({
    uiId: "system:e-1",
    id: "system:e-1",
    entityId: "e-1",
    kind: "system-error",
    title: "System failure",
    summary: "failed",
    state: "failure",
    status: "failure",
    sortTimestamp: "1",
    source: {
      id: "e-1",
      title: "System failure",
      state: "failure",
      sequence: 8,
    },
    actions: { actions: ["copy-id"] },
  });
  assert.equal(system.kind, "system-error");
  assert.equal(system.sequence, 8);
});
