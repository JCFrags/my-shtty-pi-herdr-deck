import assert from "node:assert/strict";
import test from "node:test";
import { dispatchParentTool, PARENT_TOOL_DESCRIPTORS, type ParentToolBroker, type ParentToolContext } from "../../src/pi/parent-tools.js";

const parent = "agt_parent";
function fake(calls: Array<[string, Record<string, unknown>]>): ParentToolBroker {
  return { request: async (method, params) => { calls.push([method, params]); return { ok: true }; } };
}
function context(calls: Array<[string, Record<string, unknown>]>, overrides: Partial<ParentToolContext> = {}): ParentToolContext {
  return { principal: { id: "prn_parent", kind: "adopted", agentId: parent, permissions: ["read:state", "delegate"] }, broker: fake(calls), canAccessAgent: async (id) => id === parent || id.startsWith("agt_child"), canAccessTask: async (id) => id.startsWith("tsk_child"), ...overrides };
}

test("M3 parent descriptors expose the complete bounded tool surface", () => {
  assert.deepEqual(PARENT_TOOL_DESCRIPTORS.map((item) => item.name), ["delegate", "agent_spawn", "agent_list", "agent_get", "agent_prompt", "agent_steer", "agent_wait", "agent_result", "agent_answer", "agent_interrupt", "agent_stop", "agent_close", "task_list", "task_get", "task_collect", "task_cancel"]);
  for (const descriptor of PARENT_TOOL_DESCRIPTORS) {
    assert.ok(descriptor.description.length < 160);
    assert.equal(descriptor.inputSchema.additionalProperties, false);
  }
});

test("M3 dispatcher queries the broker and binds delegation to the authenticated parent", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  await dispatchParentTool("delegate", { mode: "single", objective: "inspect", parentAgentId: parent }, context(calls));
  assert.equal(calls[0]?.[0], "delegate.execute");
  assert.equal(calls[0]?.[1].parentAgentId, parent);
});

test("M3 dispatcher rejects sibling targets and observer mutations", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  await assert.rejects(() => dispatchParentTool("agent_stop", { agentId: "agt_sibling", reason: "stop" }, context(calls)), /PERMISSION_DENIED/);
  await assert.rejects(() => dispatchParentTool("task_cancel", { taskId: "tsk_child", reason: "stop" }, context(calls, { principal: { id: "prn_observer", kind: "observer", permissions: ["read:state"] } })), /PERMISSION_DENIED/);
  assert.equal(calls.length, 0);
});

test("M3 dispatcher rejects a forged parent and oversized payload", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  await assert.rejects(() => dispatchParentTool("agent_spawn", { parentAgentId: "agt_other", task: {} }, context(calls)), /PERMISSION_DENIED/);
  await assert.rejects(() => dispatchParentTool("task_get", { taskId: "tsk_child", padding: "x".repeat(262_144) }, context(calls)), /LIMIT_EXCEEDED/);
});
