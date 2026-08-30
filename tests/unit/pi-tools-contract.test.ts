import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@pi-herdr-deck/tui";
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
  let invalidModelRating = false;
  let invalidThinkingLevel = false;
  let invalidThinkingOrder = false;
  let extraModelOptionsField = false;
  let extraModelOptionField = false;
  let invalidModelRank = false;
  let oversizedMoreAvailable = false;
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
          profileId: "scout",
          thinkingGuide: [
            { thinkingLevel: "medium", useFor: "balanced default" },
            { thinkingLevel: "high", useFor: "complex coding or review" },
          ],
          availableModels: [
            {
              rank: invalidModelRank ? 2 : 1,
              provider: "provider-a",
              modelId: "model-ready",
              recommended: true,
              thinkingLevels: [
                {
                  rank: invalidThinkingOrder ? 3 : 1,
                  thinkingLevel: invalidThinkingLevel ? "turbo" : "medium",
                  recommended: !invalidThinkingOrder,
                  ratings: {
                    overall: invalidModelRating ? "★★★★★★ 6/5" : "★★★★☆ 4/5",
                    taskFit: "★★★★★ 5/5",
                    reliability: "★★★★☆ 4/5",
                    speed: "★★★☆☆ 3/5",
                    value: "★★☆☆☆ 2/5",
                  },
                },
                {
                  rank: invalidThinkingOrder ? 1 : 3,
                  thinkingLevel: "high",
                  recommended: invalidThinkingOrder,
                  ratings: {
                    overall: "★★★☆☆ 3/5",
                    taskFit: "★★★★☆ 4/5",
                    reliability: "★★★★☆ 4/5",
                    speed: "★★☆☆☆ 2/5",
                    value: "★★☆☆☆ 2/5",
                  },
                },
              ],
              capacity: { status: "ready", available: 2, limit: 4 },
              ...(extraModelOptionField ? { scorePpm: 800_000 } : {}),
            },
            {
              rank: 2,
              provider: "openrouter",
              modelId: "nvidia/nemotron-3-ultra-550b-a55b:free",
              recommended: false,
              thinkingLevels: [
                {
                  rank: 2,
                  thinkingLevel: "high",
                  recommended: false,
                  ratings: {
                    overall: "☆☆☆☆☆ 0/5",
                    taskFit: "☆☆☆☆☆ 0/5",
                    reliability: "★★☆☆☆ 2/5",
                    speed: "★☆☆☆☆ 1/5",
                    value: "★☆☆☆☆ 1/5",
                  },
                },
              ],
            },
          ],
          moreAvailable: oversizedMoreAvailable ? 255 : 3,
          ...(extraModelOptionsField ? { candidates: [] } : {}),
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
  assert.match(
    modelOptionsTool?.description ?? "",
    /groups its thinking levels/u,
  );
  assert.match(
    modelOptionsTool?.description ?? "",
    /only for explicitly local/u,
  );
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
  const modelOptionsContent = modelOptionsResult.content[0]?.text ?? "";
  assert.deepEqual(JSON.parse(modelOptionsContent), modelOptionsResult.details);
  assert.match(modelOptionsContent, /model-ready/u);
  assert.doesNotMatch(modelOptionsContent, /policy-blocked/u);
  assert.doesNotMatch(modelOptionsContent, /Available agent models/u);
  assert.equal(modelOptionsResult.details.availableModels.length, 2);
  assert.equal(modelOptionsResult.details.moreAvailable, 3);
  assert.deepEqual(modelOptionsResult.details.thinkingGuide, [
    { thinkingLevel: "medium", useFor: "balanced default" },
    { thinkingLevel: "high", useFor: "complex coding or review" },
  ]);
  assert.deepEqual(modelOptionsResult.details.availableModels[0], {
    rank: 1,
    provider: "provider-a",
    modelId: "model-ready",
    recommended: true,
    thinkingLevels: [
      {
        rank: 1,
        thinkingLevel: "medium",
        recommended: true,
        ratings: {
          overall: "★★★★☆ 4/5",
          taskFit: "★★★★★ 5/5",
          reliability: "★★★★☆ 4/5",
          speed: "★★★☆☆ 3/5",
          value: "★★☆☆☆ 2/5",
        },
      },
      {
        rank: 3,
        thinkingLevel: "high",
        recommended: false,
        ratings: {
          overall: "★★★☆☆ 3/5",
          taskFit: "★★★★☆ 4/5",
          reliability: "★★★★☆ 4/5",
          speed: "★★☆☆☆ 2/5",
          value: "★★☆☆☆ 2/5",
        },
      },
    ],
    capacity: { status: "ready", available: 2, limit: 4 },
  });
  assert.equal(
    Object.hasOwn(
      modelOptionsResult.details.availableModels[1] ?? {},
      "capacity",
    ),
    false,
  );
  assert.deepEqual(
    (
      modelOptionsResult.details.availableModels[1]?.thinkingLevels as Array<
        Record<string, unknown>
      >
    )?.[0]?.ratings,
    {
      overall: "☆☆☆☆☆ 0/5",
      taskFit: "☆☆☆☆☆ 0/5",
      reliability: "★★☆☆☆ 2/5",
      speed: "★☆☆☆☆ 1/5",
      value: "★☆☆☆☆ 1/5",
    },
  );
  assert.equal(
    Object.hasOwn(
      modelOptionsResult.details.availableModels[0] ?? {},
      "scorePpm",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(
      modelOptionsResult.details.availableModels[0] ?? {},
      "components",
    ),
    false,
  );
  assert.equal(Object.hasOwn(modelOptionsResult.details, "excluded"), false);
  assert.equal(Object.hasOwn(modelOptionsResult.details, "sourceDates"), false);
  const renderedModelOptions = modelOptionsTool?.renderResult?.(
    modelOptionsResult,
    { expanded: false },
    { fg: (_color, text) => text, bold: (text) => text },
    {},
  );
  const collapsedModelOptionLines = renderedModelOptions?.render(80) ?? [];
  const collapsedModelOptions = collapsedModelOptionLines.join("\n");
  assert.match(collapsedModelOptions, /5 available models/u);
  assert.match(collapsedModelOptions, /#1 provider-a\/model-ready/u);
  assert.match(collapsedModelOptions, /local · 2\/4 free/u);
  assert.match(
    collapsedModelOptions,
    /medium · ★★★★☆ 4\/5 · balanced default/u,
  );
  assert.match(
    collapsedModelOptions,
    /high · ★★★☆☆ 3\/5 · complex coding or review/u,
  );
  assert.match(
    collapsedModelOptions.replace(/\s+/gu, ""),
    /openrouter\/nvidia\/nemotron-3-ultra-550b-a55b:free/u,
  );
  assert.match(collapsedModelOptions, /high · ☆☆☆☆☆ 0\/5/u);
  assert.doesNotMatch(collapsedModelOptions, /will queue|slots/u);
  assert.match(collapsedModelOptions, /3 more available/u);
  for (const width of [24, 40, 80, 140]) {
    const lines = renderedModelOptions?.render(width) ?? [];
    assert.equal(lines.length, 8);
    assert.equal(
      lines.every((line) => visibleWidth(line) <= width),
      true,
    );
    assert.match(lines.join("\n"), /local · 2\/4 free/u);
  }
  assert.doesNotMatch(collapsedModelOptions, /Task fit/u);
  assert.doesNotMatch(collapsedModelOptions, /policy-blocked/u);
  assert.equal(
    collapsedModelOptionLines.some((line) =>
      line.trimStart().startsWith("slots)"),
    ),
    false,
  );
  const hiddenModelOptionsDetails = {
    ...modelOptionsResult.details,
    availableModels: [
      ...modelOptionsResult.details.availableModels,
      ...[3, 4, 5].map((rank) => ({
        ...modelOptionsResult.details.availableModels[0],
        rank,
        modelId: `model-${rank}`,
        recommended: false,
      })),
    ],
  };
  const hiddenModelOptions = modelOptionsTool?.renderResult?.(
    {
      content: [
        { type: "text", text: JSON.stringify(hiddenModelOptionsDetails) },
      ],
      details: hiddenModelOptionsDetails,
    },
    { expanded: false },
    { fg: (_color, text) => text, bold: (text) => text },
    {},
  );
  const hiddenModelOptionsText =
    hiddenModelOptions?.render(80).join("\n") ?? "";
  assert.match(hiddenModelOptionsText, /8 available models/u);
  assert.match(hiddenModelOptionsText, /… 1 more returned model/u);
  assert.doesNotMatch(hiddenModelOptionsText, /model-5/u);
  const expandedModelOptions = modelOptionsTool?.renderResult?.(
    modelOptionsResult,
    { expanded: true },
    { fg: (_color, text) => text, bold: (text) => text },
    {},
  );
  const expandedModelOptionsText =
    expandedModelOptions?.render(240).join("\n") ?? "";
  assert.match(
    expandedModelOptionsText,
    /Task fit ★★★★★ 5\/5 · Reliability ★★★★☆ 4\/5/u,
  );
  assert.match(expandedModelOptionsText, /#1 provider-a\/model-ready/u);
  assert.match(expandedModelOptionsText, /local · 2\/4 free/u);
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
  invalidModelRating = true;
  await assert.rejects(
    (
      modelOptionsTool?.execute as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>
    )(
      "invalid-model-rating",
      { profileId: "scout", limit: 2 },
      AbortSignal.timeout(1000),
      undefined,
      {},
    ),
    /MODEL_OPTIONS_RESPONSE_INVALID/u,
  );
  assert.equal(calls.length, 28);
  invalidModelRating = false;
  invalidThinkingLevel = true;
  await assert.rejects(
    (
      modelOptionsTool?.execute as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>
    )(
      "invalid-thinking-level",
      { profileId: "scout", limit: 2 },
      AbortSignal.timeout(1000),
      undefined,
      {},
    ),
    /MODEL_OPTIONS_RESPONSE_INVALID/u,
  );
  assert.equal(calls.length, 29);
  invalidThinkingLevel = false;
  extraModelOptionsField = true;
  await assert.rejects(
    (
      modelOptionsTool?.execute as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>
    )(
      "extra-model-options-field",
      { profileId: "scout", limit: 2 },
      AbortSignal.timeout(1000),
      undefined,
      {},
    ),
    /MODEL_OPTIONS_RESPONSE_INVALID/u,
  );
  assert.equal(calls.length, 30);
  extraModelOptionsField = false;
  extraModelOptionField = true;
  await assert.rejects(
    (
      modelOptionsTool?.execute as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>
    )(
      "extra-model-option-field",
      { profileId: "scout", limit: 2 },
      AbortSignal.timeout(1000),
      undefined,
      {},
    ),
    /MODEL_OPTIONS_RESPONSE_INVALID/u,
  );
  assert.equal(calls.length, 31);
  extraModelOptionField = false;
  invalidModelRank = true;
  await assert.rejects(
    (
      modelOptionsTool?.execute as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>
    )(
      "invalid-model-rank",
      { profileId: "scout", limit: 2 },
      AbortSignal.timeout(1000),
      undefined,
      {},
    ),
    /MODEL_OPTIONS_RESPONSE_INVALID/u,
  );
  assert.equal(calls.length, 32);
  invalidModelRank = false;
  oversizedMoreAvailable = true;
  await assert.rejects(
    (
      modelOptionsTool?.execute as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>
    )(
      "oversized-more-available",
      { profileId: "scout", limit: 2 },
      AbortSignal.timeout(1000),
      undefined,
      {},
    ),
    /MODEL_OPTIONS_RESPONSE_INVALID/u,
  );
  assert.equal(calls.length, 33);
  oversizedMoreAvailable = false;
  invalidThinkingOrder = true;
  await assert.rejects(
    (
      modelOptionsTool?.execute as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>
    )(
      "invalid-thinking-order",
      { profileId: "scout", limit: 2 },
      AbortSignal.timeout(1000),
      undefined,
      {},
    ),
    /MODEL_OPTIONS_RESPONSE_INVALID/u,
  );
  assert.equal(calls.length, 34);
  invalidThinkingOrder = false;
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
  assert.equal(calls.length, 34);
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
  assert.equal(calls.length, 34);
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
