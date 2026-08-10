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
  assert.equal(calls[0]?.method, "agent.get");
  assert.equal(calls[1]?.method, "result.publish");
  assert.deepEqual(calls[1]?.params, { agentId: "agt_1", taskId: "tsk_1", runId: "run_1", assignmentGeneration: 2, result: { schemaVersion: 1 } });
});

test("parent tool identity is adapter-owned and broker state is refreshed per call", async () => {
  const tools: Array<{ name: string; execute: (...args: never[]) => Promise<unknown> }> = [];
  const calls: string[] = [];
  const api = { registerTool(definition: typeof tools[number]) { tools.push(definition); } };
  const client = { principal: { id: "principal_1", kind: "pi_parent" as const, permissions: ["read:state"] }, request: async (method: string, params: Record<string, unknown>) => { calls.push(`${method}:${String(params.parentAgentId ?? "")}`); return {}; } };
  registerParentTools(api as never, fakeAdapter() as never, client as never);
  const listTool = tools.find((tool) => tool.name === "agent_list");
  assert.ok(listTool);
  await (listTool.execute as unknown as (...args: unknown[]) => Promise<unknown>)("call", { input: { parentAgentId: "forged" } }, AbortSignal.timeout(1000), undefined, fakeContext());
  assert.deepEqual(calls, ["agent.get:", "agent.list:agt_1"]);
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
