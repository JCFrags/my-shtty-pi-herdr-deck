import assert from "node:assert/strict";
import test from "node:test";
import { registerParentTools } from "../../src/pi/tools.js";
const inputs: Record<string, Record<string, unknown>> = {
  delegate_compact: {
    text: "- [ ] canary: Read package.json [profile:reviewer] [mode:read]",
    accept: true,
    workflowDigest: "a".repeat(64),
  },
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
  agent_model_options: { profileId: "scout" },
  agent_list: { state: "stopped" },
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
    label: string;
    description: string;
    parameters: unknown;
    execute: (...args: never[]) => Promise<unknown>;
    renderResult?: (
      result: unknown,
      options: { expanded: boolean },
      theme: {
        fg(color: string, text: string): string;
        bold(text: string): string;
      },
      context: unknown,
    ) => { render(width: number): string[] };
  }> = [];
  const calls: Array<{
    method: string;
    params: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  const results = new Map<string, unknown>();
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
      if (method === "model.options")
        return {
          schemaVersion: 1,
          scorerVersion: 1,
          mode: "explicit_required",
          taskProfile: "scout",
          asOf: "2026-08-29T00:00:00.000Z",
          eligibleCount: 2,
          candidates: [
            {
              rank: 1,
              selection: {
                provider: "provider-a",
                modelId: "model-ready",
                thinkingLevel: "medium",
              },
              endpoint: { available: 2, limit: 4 },
            },
            {
              rank: 2,
              selection: {
                provider: "provider-a",
                modelId: "model-busy",
                thinkingLevel: "high",
              },
              endpoint: { available: 0, limit: 4 },
            },
          ],
          excluded: [
            {
              selection: {
                provider: "provider-b",
                modelId: "policy-blocked",
                thinkingLevel: "off",
              },
              reason: "policy_allowlist",
            },
          ],
          excludedCount: 1,
          sourceDates: [],
        };
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
    results.set(
      name,
      await (
        tool.execute as unknown as (...args: unknown[]) => Promise<unknown>
      )(
        "id",
        { ...input, idempotencyKey: `idem-${name}` },
        AbortSignal.timeout(1000),
        undefined,
        {},
      ),
    );
  }
  assert.equal(calls.length, 27);
  const compactTool = tools.find((item) => item.name === "delegate_compact");
  assert.equal(
    (compactTool?.parameters as { properties?: { accept?: { type?: string } } })
      .properties?.accept?.type,
    "boolean",
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      "compact.delegate",
      "delegate.execute",
      "agent.spawn",
      "model.options",
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
  const delegateTool = tools.find((item) => item.name === "delegate");
  const stepProfile = (
    delegateTool?.parameters as {
      properties?: {
        steps?: {
          items?: { properties?: { profileId?: { enum?: string[] } } };
        };
      };
    }
  ).properties?.steps?.items?.properties?.profileId?.enum;
  assert.deepEqual(stepProfile, [
    "implementer",
    "planner",
    "reviewer",
    "scout",
    "test-runner",
  ]);
  const modelOptionsTool = tools.find(
    (item) => item.name === "agent_model_options",
  );
  const modelOptionsProperties = (
    modelOptionsTool?.parameters as {
      properties?: Record<string, { maximum?: number }>;
    }
  ).properties;
  assert.equal(modelOptionsTool?.label, "Available Agent Models");
  assert.match(modelOptionsTool?.description ?? "", /only model/u);
  assert.equal(modelOptionsProperties?.limit?.maximum, 16);
  assert.equal(
    calls.find((call) => call.method === "model.options")?.params.limit,
    16,
  );
  const modelOptionsResult = results.get("agent_model_options") as {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown> & {
      availableModels: Array<Record<string, unknown>>;
    };
  };
  assert.match(
    modelOptionsResult.content[0]?.text ?? "",
    /Available agent models/u,
  );
  assert.match(modelOptionsResult.content[0]?.text ?? "", /model-ready/u);
  assert.doesNotMatch(
    modelOptionsResult.content[0]?.text ?? "",
    /policy-blocked/u,
  );
  assert.equal(modelOptionsResult.details.availableModels.length, 2);
  assert.deepEqual(modelOptionsResult.details.availableModels[0], {
    rank: 1,
    provider: "provider-a",
    modelId: "model-ready",
    thinkingLevel: "medium",
    recommended: true,
    startAvailability: "ready",
    availableSlots: 2,
    maxConcurrent: 4,
  });
  assert.equal(
    modelOptionsResult.details.availableModels[1]?.startAvailability,
    "will_queue",
  );
  assert.equal(Object.hasOwn(modelOptionsResult.details, "excluded"), false);
  assert.equal(Object.hasOwn(modelOptionsResult.details, "sourceDates"), false);
  const renderedModelOptions = modelOptionsTool?.renderResult?.(
    modelOptionsResult,
    { expanded: false },
    { fg: (_color, text) => text, bold: (text) => text },
    {},
  );
  assert.match(
    renderedModelOptions?.render(200).join("\n") ?? "",
    /2 available model options/u,
  );
  assert.doesNotMatch(
    renderedModelOptions?.render(200).join("\n") ?? "",
    /policy-blocked/u,
  );
  await assert.rejects(
    (
      modelOptionsTool?.execute as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>
    )(
      "invalid-model-limit",
      { profileId: "scout", limit: 17 },
      AbortSignal.timeout(1000),
      undefined,
      {},
    ),
    /INVALID_REQUEST/u,
  );
  assert.equal(calls.length, 27);
  const agentListTool = tools.find((item) => item.name === "agent_list");
  const agentListProperties = (
    agentListTool?.parameters as {
      properties?: Record<string, unknown>;
    }
  ).properties;
  assert.equal(Object.hasOwn(agentListProperties ?? {}, "include"), false);
  await assert.rejects(
    (
      agentListTool?.execute as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>
    )(
      "invalid-agent-state",
      { state: "succeeded" },
      AbortSignal.timeout(1000),
      undefined,
      {},
    ),
    /INVALID_REQUEST/,
  );
  assert.equal(calls.length, 27);
  const agentPromptTool = tools.find((item) => item.name === "agent_prompt");
  const agentPromptProperties = (
    agentPromptTool?.parameters as {
      properties?: Record<string, { maximum?: number }>;
    }
  ).properties;
  assert.deepEqual(Object.keys(agentPromptProperties ?? {}).sort(), [
    "agentId",
    "delivery",
    "idempotencyKey",
    "message",
    "timeoutMs",
  ]);
  assert.equal(agentPromptProperties?.timeoutMs?.maximum, 30_000);
  await assert.rejects(
    (
      agentPromptTool?.execute as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>
    )(
      "invalid-prompt-timeout",
      {
        agentId: "child",
        message: "x",
        delivery: "normal",
        timeoutMs: 30_001,
      },
      AbortSignal.timeout(1000),
      undefined,
      {},
    ),
    /INVALID_REQUEST/u,
  );
  assert.equal(calls.length, 27);
});

test("launch tools add lifecycle reminders only for created work", async () => {
  const tools: Array<{
    name: string;
    execute: (...args: never[]) => Promise<any>;
  }> = [];
  const client = {
    connected: true,
    principal: {
      id: "principal",
      kind: "pi_parent" as const,
      permissions: ["delegate"],
    },
    request: async (method: string, params: Record<string, unknown>) => ({
      workflowId: `wfl_${method}`,
      state: "scheduled",
      tasks: [{ key: "one", taskId: "tsk_one", state: "queued" }],
      ...(method === "compact.delegate" && params.accept !== true
        ? { schemaVersion: 1, workflowDigest: "b".repeat(64) }
        : {}),
    }),
  };
  registerParentTools(
    {
      registerTool: (definition: (typeof tools)[number]) =>
        tools.push(definition),
    } as never,
    { safeState: () => state } as never,
    client as never,
  );
  const run = async (name: string, input: Record<string, unknown>) => {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool);
    return (tool.execute as unknown as (...args: unknown[]) => Promise<any>)(
      `call-${name}`,
      input,
      AbortSignal.timeout(1_000),
      undefined,
      {},
    );
  };
  const reminder =
    "After each managed task becomes terminal, use task_collect to record its result. If an assigned agent remains open and is no longer needed, use agent_close.";
  const spawn = await run("agent_spawn", inputs.agent_spawn ?? {});
  assert.equal(spawn.details.lifecycleReminder, reminder);
  const delegated = await run("delegate", {
    ...(inputs.delegate ?? {}),
    dryRun: false,
  });
  assert.equal(delegated.details.lifecycleReminder, reminder);
  const accepted = await run("delegate_compact", inputs.delegate_compact ?? {});
  assert.equal(accepted.details.lifecycleReminder, reminder);
  const preview = await run("delegate_compact", {
    text: "- [ ] canary: Read package.json [profile:reviewer] [mode:read]",
    accept: false,
  });
  assert.equal(Object.hasOwn(preview.details, "lifecycleReminder"), false);
  const dryRun = await run("delegate", inputs.delegate ?? {});
  assert.equal(Object.hasOwn(dryRun.details, "lifecycleReminder"), false);
});

test("delegate wait polls task state through automatic execution", async () => {
  const tools: Array<{
    name: string;
    parameters: unknown;
    execute: (...args: never[]) => Promise<any>;
  }> = [];
  let taskPolls = 0;
  const calls: string[] = [];
  const client = {
    connected: true,
    principal: {
      id: "principal",
      kind: "pi_parent" as const,
      permissions: ["delegate", "read:state"],
      agentId: "parent",
    },
    request: async (method: string) => {
      calls.push(method);
      if (method === "delegate.execute")
        return {
          workflowId: "wfl_test",
          state: "running",
          tasks: [{ key: "one", taskId: "tsk_test", state: "provisioning" }],
        };
      if (method === "task.get") {
        taskPolls++;
        if (taskPolls === 1)
          throw Object.assign(new Error("AGENT_DISCONNECTED"), {
            code: "AGENT_DISCONNECTED",
            retryable: true,
          });
        return {
          id: "tsk_test",
          state: taskPolls === 2 ? "running" : "succeeded",
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  registerParentTools(
    {
      registerTool: (definition: (typeof tools)[number]) =>
        tools.push(definition),
    } as never,
    { safeState: () => state } as never,
    client as never,
  );
  const delegateTool = tools.find((item) => item.name === "delegate");
  assert.ok(delegateTool);
  const output = await (
    delegateTool.execute as unknown as (...args: unknown[]) => Promise<any>
  )(
    "wait-delegate",
    {
      ...inputs.delegate,
      mode: "single",
      wait: true,
      dryRun: false,
      waitUntil: ["terminal", "blocked"],
      timeoutMs: 5_000,
    },
    AbortSignal.timeout(6_000),
    undefined,
    {},
  );
  assert.equal(output.details.state, "succeeded");
  assert.equal(output.details.tasks[0].state, "succeeded");
  assert.deepEqual(calls, [
    "delegate.execute",
    "task.get",
    "task.get",
    "task.get",
  ]);
});
