import assert from "node:assert/strict";
import test from "node:test";
import { reconcileActiveTools } from "../../extensions/pi-herdr-orchestrator.js";

function harness(active: string[], all: string[]) {
  let current = [...active];
  return {
    api: {
      getActiveTools: () => [...current],
      getAllTools: () => all.map((name) => ({ name })),
      setActiveTools: (names: string[]) => {
        current = [...names];
      },
    },
    get active() {
      return current;
    },
    replaceActive(names: string[]) {
      current = [...names];
    },
  };
}

test("active-tool reconciliation preserves every non-orchestrator tool across reconnect", () => {
  const state = harness(
    ["read", "ask_user_question", "search_tools", "agent_get"],
    ["read", "ask_user_question", "search_tools", "agent_get", "agent_list"],
  );
  reconcileActiveTools(state.api as never, ["agent_list"]);
  assert.deepEqual(state.active, [
    "read",
    "ask_user_question",
    "search_tools",
    "agent_list",
  ]);
  state.replaceActive([
    ...state.active,
    "coordination_wait",
    "another_extension_tool",
  ]);
  reconcileActiveTools(state.api as never, ["agent_get"]);
  assert.deepEqual(state.active, [
    "read",
    "ask_user_question",
    "search_tools",
    "coordination_wait",
    "another_extension_tool",
    "agent_get",
  ]);
});

test("active-tool reconciliation fails closed on duplicate current ownership", () => {
  const state = harness(
    ["read", "agent_wait", "agent_get"],
    ["read", "agent_wait", "agent_wait", "agent_get"],
  );
  assert.throws(
    () => reconcileActiveTools(state.api as never, ["agent_get"]),
    /ORCHESTRATION_TOOL_OWNERSHIP_CONFLICT:agent_wait/,
  );
  assert.deepEqual(state.active, ["read"]);
});

test("active-tool reconciliation rejects distinct legacy registration", () => {
  const state = harness(
    ["read", "agent_dispatch", "agent_get"],
    ["read", "agent_dispatch", "agent_get"],
  );
  assert.throws(
    () => reconcileActiveTools(state.api as never, ["agent_get"]),
    /ORCHESTRATION_TOOL_OWNERSHIP_CONFLICT:agent_dispatch/,
  );
  assert.deepEqual(state.active, ["read"]);
});
