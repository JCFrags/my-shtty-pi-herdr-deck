import assert from "node:assert/strict";
import test from "node:test";
import { registerManagedChildTools, registerParentTools } from "../../src/pi/tools.js";

const assignment = { id: "asg_1", taskId: "tsk_1", runId: "run_1", agentId: "agt_1", generation: 1, assignmentGeneration: 2, piSessionId: "pi_1", objective: "test", constraints: [], deadline: "2030-01-01T00:00:00.000Z" };
const state = { agentId: "agt_1", generation: 1, sessionId: "pi_1", idle: false, pendingMessages: 0, activity: "working" as const, activeTools: [], capabilities: { core: true, prompt: true, steer: true, followUp: true, abort: true, compact: true, model: true, thinking: true, tools: true, toolExpansion: false } };
function fakeAdapter() { return { safeState: () => state, assignmentForTools: () => assignment }; }
function fakeContext() { return {} as never; }

test("managed tools inject exact assignment identity and query broker state first", async () => {
  const tools: Array<{ name: string; execute: (...args: never[]) => Promise<unknown> }> = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const api = { registerTool(definition: typeof tools[number]) { tools.push(definition); } };
  const client = { connected: true, request: async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return { state: "accepted" }; } };
  registerManagedChildTools(api as never, fakeAdapter() as never, client as never);
  const resultTool = tools.find((tool) => tool.name === "orchestrator_result");
  assert.ok(resultTool);
  await (resultTool.execute as unknown as (...args: unknown[]) => Promise<unknown>)("call", { schemaVersion: 1 }, AbortSignal.timeout(1000), undefined, fakeContext());
  assert.equal(calls[0]?.method, "result.publish");
  assert.deepEqual(calls[0]?.params, { agentId: "agt_1", taskId: "tsk_1", runId: "run_1", assignmentGeneration: 2, result: { schemaVersion: 1 } });
});

test("parent tools let the broker authorize child targets without model identity fields", async () => {
  const tools: Array<{ name: string; execute: (...args: never[]) => Promise<unknown> }> = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const api = { registerTool(definition: typeof tools[number]) { tools.push(definition); } };
  const client = { connected: true, principal: { id: "principal_1", kind: "pi_parent" as const, permissions: ["read:state"] }, request: async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return {}; } };
  registerParentTools(api as never, fakeAdapter() as never, client as never);
  for (const [name, input] of [["agent_get", { agentId: "child_1" }], ["agent_prompt", { agentId: "child_1", message: "x", delivery: "normal", timeoutMs: 1000 }], ["task_get", { taskId: "child_task" }], ["agent_result", { taskId: "child_task" }]] as const) { const tool = tools.find((item) => item.name === name); assert.ok(tool); await (tool.execute as unknown as (...args: unknown[]) => Promise<unknown>)("call", { input }, AbortSignal.timeout(1000), undefined, fakeContext()); }
  assert.deepEqual(calls.filter((call) => call.method !== "agent.get").map((call) => call.method), ["agent.prompt", "task.get", "result.get"]); assert.equal(calls.filter((call) => call.method === "agent.get").length, 1);
  for (const call of calls) { assert.equal(Object.hasOwn(call.params, "principalId"), false); assert.equal(Object.hasOwn(call.params, "parentAgentId"), false); }
});

test("managed tools fail closed and do not queue while disconnected", async () => {
  const tools: Array<{ name: string; execute: (...args: never[]) => Promise<unknown> }> = [];
  const api = { registerTool(definition: typeof tools[number]) { tools.push(definition); } };
  const client = { request: async () => { throw new Error("AGENT_DISCONNECTED"); } };
  registerManagedChildTools(api as never, fakeAdapter() as never, client as never);
  const ask = tools.find((tool) => tool.name === "orchestrator_ask");
  assert.ok(ask);
  await assert.rejects(() => (ask.execute as unknown as (...args: unknown[]) => Promise<unknown>)("call", { schemaVersion: 1 }, AbortSignal.timeout(1000), undefined, fakeContext()), /AGENT_DISCONNECTED/);
});
