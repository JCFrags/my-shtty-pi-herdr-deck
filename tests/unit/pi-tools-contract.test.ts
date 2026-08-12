import assert from "node:assert/strict";
import test from "node:test";
import { registerParentTools } from "../../src/pi/tools.js";
const inputs: Record<string, Record<string, unknown>> = {
  delegate: {
    mode: "parallel",
    title: "x",
    steps: [{ key: "a", profileId: "scout", title: "a", objective: "a" }],
    wait: false,
    waitUntil: ["terminal"],
    timeoutMs: 120000,
    failureMode: "collect_all",
    dryRun: true,
  },
  agent_spawn: {
    task: { title: "x", objective: "x" },
    profileId: "scout",
    project: { cwd: "/tmp" },
    isolation: { mode: "shared-readonly" },
    budget: { wallTimeMs: 1000 },
    wait: false,
  },
  agent_list: {},
  agent_get: { agentId: "child" },
  agent_prompt: {
    agentId: "child",
    message: "x",
    delivery: "normal",
    timeoutMs: 1000,
  },
  agent_steer: { agentId: "child", message: "x", delivery: "steer" },
  agent_ask: {
    agentId: "child",
    message: "x",
    followUps: ["y", "z"],
    timeoutMs: 1000,
  },
  agent_wait: {
    agentId: "child",
    taskId: "task",
    runId: "run",
    until: ["blocked"],
    timeoutMs: 1000,
  },
  coordination_wait: {
    kind: "signal",
    targetId: "ready",
    timeoutMs: 1000,
  },
  coordination_signal: { targetId: "ready" },
  group_create: { name: "pair", agentIds: ["child"] },
  group_list: {},
  group_get: { groupId: "group" },
  group_wait: {
    groupId: "group",
    until: ["stopped"],
    mode: "all",
    timeoutMs: 1000,
  },
  group_stop: { groupId: "group", reason: "done", force: false },
  group_close: { groupId: "group", confirm: true },
  agent_result: { taskId: "task" },
  agent_answer: {
    questionId: "question",
    answer: { optionId: "yes", text: null },
  },
  agent_interrupt: { agentId: "child", reason: "stop" },
  agent_stop: { agentId: "child", reason: "stop", force: false },
  agent_close: { agentId: "child", confirm: true },
  task_list: {},
  task_get: { taskId: "task" },
  task_collect: { taskIds: ["task"], select: ["summary"], maxBytes: 1000 },
  task_cancel: { taskId: "task", reason: "stop", cascade: true },
};
const state = {
  agentId: "parent",
  generation: 1,
  sessionId: "session",
  idle: true,
  pendingMessages: 0,
  activity: "idle" as const,
  activeTools: [],
  capabilities: {
    core: true,
    prompt: true,
    steer: true,
    followUp: true,
    abort: true,
    compact: true,
    model: true,
    thinking: true,
    tools: true,
    toolExpansion: false,
  },
};
test("all parent tools capture frozen methods and frame-owned idempotency", async () => {
  const tools: Array<{
    name: string;
    execute: (...args: never[]) => Promise<unknown>;
  }> = [];
  const calls: Array<{
    method: string;
    params: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  const api = {
    registerTool: (definition: (typeof tools)[number]) =>
      tools.push(definition),
  };
  const client = {
    connected: true,
    principal: {
      id: "principal",
      kind: "pi_parent" as const,
      permissions: ["delegate"],
    },
    request: async (
      method: string,
      params: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      calls.push({ method, params, ...(options ? { options } : {}) });
      return method === "agent.wait"
        ? { state: "blocked" }
        : method === "coordination.wait" || method === "group.wait"
          ? { ready: true }
          : {};
    },
  };
  const adapter = { safeState: () => state };
  registerParentTools(api as never, adapter as never, client as never);
  for (const [name, input] of Object.entries(inputs)) {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, name);
    await (tool.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
      "id",
      { ...input, idempotencyKey: `idem-${name}` },
      AbortSignal.timeout(1000),
      undefined,
      {},
    );
  }
  assert.equal(calls.length, 25);
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      "delegate.execute",
      "agent.spawn",
      "agent.list",
      "agent.get",
      "agent.prompt",
      "agent.steer",
      "agent.ask",
      "agent.wait",
      "coordination.wait",
      "coordination.signal",
      "group.create",
      "group.list",
      "group.get",
      "group.wait",
      "group.stop",
      "group.close",
      "result.get",
      "question.answer",
      "agent.interrupt",
      "agent.stop",
      "agent.close",
      "task.list",
      "task.get",
      "task.collect",
      "task.cancel",
    ],
  );
  for (const call of calls) {
    assert.equal(Object.hasOwn(call.params, "principalId"), false);
    assert.equal(Object.hasOwn(call.params, "parentAgentId"), false);
    assert.equal(typeof call.options?.idempotencyKey, "string");
  }
});
