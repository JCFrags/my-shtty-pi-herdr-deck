import test from "node:test";
import assert from "node:assert/strict";
import {
  PARENT_TOOL_METADATA,
  isParentToolRequest,
  parentToolMethod,
  validateParentToolRequest,
} from "../../src/pi/parent-tool-schema.js";

test("parent tool metadata converges names to broker methods", () => {
  assert.equal(parentToolMethod("agent_get"), "agent.get");
  assert.equal(parentToolMethod("delegate"), "delegate.execute");
  assert.equal(parentToolMethod("agent_result"), "result.get");
  assert.equal(parentToolMethod("agent_answer"), "question.answer");
  assert.deepEqual(PARENT_TOOL_METADATA.agent_get.targetParameters, ["agentId"]);
  assert.deepEqual(PARENT_TOOL_METADATA.agent_wait.targetParameters, ["agentId", "taskId", "runId"]);
  assert.deepEqual(PARENT_TOOL_METADATA.agent_result.targetParameters, ["taskId"]);
  assert.deepEqual(PARENT_TOOL_METADATA.agent_answer.targetParameters, ["questionId"]);
  assert.deepEqual(PARENT_TOOL_METADATA.task_collect.targetParameters, ["taskIds"]);
  assert.equal(PARENT_TOOL_METADATA.agent_list.requiresTarget, false);
  assert.equal(PARENT_TOOL_METADATA.delegate.requiresDelegation, true);
});

test("parent tool request validation accepts the frozen request shape", () => {
  const result = validateParentToolRequest({ tool: "task_get", input: { taskId: "tsk_1" }, idempotencyKey: "retry-1" });
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.request.tool, "task_get");
  assert.equal(isParentToolRequest({ tool: "agent_list", input: {} }), true);
});

test("parent tool request validation rejects unknown and oversized fields", () => {
  const input = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key${index}`, index]));
  const result = validateParentToolRequest({ tool: "not-a-tool", input, extra: true, idempotencyKey: "" });
  assert.equal(result.valid, false);
  if (!result.valid) assert.deepEqual(result.issues.map((issue) => issue.path), ["$.extra", "$.tool", "$.input", "$.idempotencyKey"]);
});
