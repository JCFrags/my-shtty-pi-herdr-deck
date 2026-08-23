import assert from "node:assert/strict";
import test from "node:test";
import { applyActivityWheel } from "../../src/deck/activity.js";
import {
  activateAgentMore,
  agentMoreGuard,
  agentPrimaryActions,
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
  assert.equal(actions.find((item) => item.action === "focus")?.disabled, true);
  assert.equal(
    actions.find((item) => item.action === "prompt")?.disabled,
    false,
  );
  const guard = agentMoreGuard(selected)!;
  assert.equal(isAgentMoreGuardCurrent(value, guard), true);
  const more = openAgentMore(value, guard)!;
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
