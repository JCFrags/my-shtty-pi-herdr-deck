import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  registerManagedChildTools,
  registerParentTools,
} from "../../src/pi/tools.js";
import { PiBrokerClient } from "../../src/pi/broker-client.js";
import { NdjsonDecoder, encodeFrame } from "../../src/shared/protocol/codec.js";

const assignment = {
  id: "asg_1",
  taskId: "tsk_1",
  runId: "run_1",
  agentId: "agt_1",
  generation: 1,
  assignmentGeneration: 2,
  piSessionId: "pi_1",
  objective: "test",
  constraints: [],
  deadline: "2030-01-01T00:00:00.000Z",
};
const state = {
  agentId: "agt_1",
  generation: 1,
  sessionId: "pi_1",
  idle: false,
  pendingMessages: 0,
  activity: "working" as const,
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
function fakeAdapter() {
  return { safeState: () => state, assignmentForTools: () => assignment };
}
function fakeContext() {
  return {} as never;
}

test("real socket PiBrokerClient drives a managed ask through normal and early answer delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-real-tool-"));
  const socketPath = join(root, "broker.sock");
  const requests: Record<string, unknown>[] = [];
  let questionCount = 0;
  const server = createServer((socket) => {
    const decoder = new NdjsonDecoder<unknown>((value) => value);
    socket.on("data", (data) => {
      for (const item of decoder.push(data)) {
        if (!item.ok || !item.value || typeof item.value !== "object") continue;
        const frame = item.value as Record<string, unknown>;
        if (frame.type === "hello")
          socket.write(
            encodeFrame({
              v: 1,
              type: "hello_result",
              id: frame.id,
              ok: true,
              broker: { version: "test", status: "healthy", lastEventSeq: 1 },
              principal: {
                id: "prn_child",
                kind: "pi_child",
                permissions: ["read:state"],
              },
              limits: { maxLineBytes: 1_048_576 },
            }),
          );
        else if (frame.type === "request") {
          requests.push(frame);
          if (frame.method === "agent.register_managed")
            socket.write(
              encodeFrame({
                v: 1,
                type: "response",
                id: frame.id,
                method: frame.method,
                ok: true,
                result: {
                  agentId: "agt_1",
                  generation: 1,
                  connectionGeneration: 1,
                  heartbeatMs: 5000,
                  permissions: ["read:state"],
                },
              }),
            );
          else if (frame.method === "question.open") {
            questionCount++;
            const questionId = `q-${questionCount}`;
            const delivery = {
              v: 1,
              type: "server_request",
              id: `answer-${questionCount}`,
              method: "question.deliver_answer",
              params: {
                questionId,
                runId: "run_1",
                toolCallId:
                  frame.params && typeof frame.params === "object"
                    ? (frame.params as Record<string, unknown>).toolCallId
                    : "",
                state: "answered",
                answer: {
                  optionId: questionCount === 1 ? "yes" : null,
                  text: questionCount === 1 ? null : "freeform",
                },
                expected: {},
              },
            };
            const response = encodeFrame({
              v: 1,
              type: "response",
              id: frame.id,
              method: frame.method,
              ok: true,
              result: {
                questionId,
                runId: "run_1",
                assignmentGeneration: 2,
                toolCallId: (frame.params as Record<string, unknown>)
                  .toolCallId,
                state: "open",
              },
            });
            if (questionCount === 1) {
              socket.write(response);
              setTimeout(() => socket.write(encodeFrame(delivery)), 1);
            } else {
              socket.write(encodeFrame(delivery));
              setTimeout(() => {
                socket.write(response);
                setTimeout(() => socket.write(response), 20);
              }, 20);
            }
          }
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = new PiBrokerClient({
    socketPath,
    sessionKey: "session",
    piSessionId: "pi-session",
    agentId: "agt_1",
    generation: 1,
    token: "token",
    onServerRequest: async (request) => {
      assert.equal(request.method, "question.deliver_answer");
      const params = request.params;
      assert.equal(
        client.resolveQuestionDelivery(
          String(params.questionId),
          String(params.runId),
          String(params.toolCallId),
          { state: params.state, answer: params.answer },
        ),
        true,
      );
      return { accepted: true };
    },
  });
  const binding = { adapter: fakeAdapter(), client };
  const tools: Array<{
    name: string;
    execute: (...args: never[]) => Promise<unknown>;
  }> = [];
  const api = {
    registerTool(definition: (typeof tools)[number]) {
      tools.push(definition);
    },
  };
  registerManagedChildTools(api as never, binding as never);
  const ask = tools.find((tool) => tool.name === "orchestrator_ask");
  assert.ok(ask);
  try {
    await client.connect();
    await client.register(state);
    client.markRegistrationReady();
    const question = {
      schemaVersion: 1,
      prompt: "Choose",
      context: null,
      options: [{ id: "yes", label: "Yes", description: null }],
      allowFreeform: true,
      defaultOptionId: null,
      timeoutMs: 10_000,
    };
    await (ask.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
      "call-1",
      question,
      AbortSignal.timeout(1000),
      undefined,
      fakeContext(),
    );
    await Promise.race([
      (ask.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
        "call-2",
        question,
        AbortSignal.timeout(1000),
        undefined,
        fakeContext(),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("EARLY_TERMINAL_HUNG")), 10),
      ),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(client.connected, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.connected, false);
    assert.equal(questionCount, 2);
    assert.equal(
      requests.filter((request) => request.method === "question.open").length,
      2,
    );
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("managed ask fails closed on a semantically invalid late open acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-invalid-late-"));
  const socketPath = join(root, "broker.sock");
  const server = createServer((socket) => {
    const decoder = new NdjsonDecoder<unknown>((value) => value);
    socket.on("data", (data) => {
      for (const item of decoder.push(data)) {
        if (!item.ok || !item.value || typeof item.value !== "object") continue;
        const frame = item.value as Record<string, unknown>;
        if (frame.type === "hello")
          socket.write(
            encodeFrame({
              v: 1,
              type: "hello_result",
              id: frame.id,
              ok: true,
              broker: { version: "test", status: "healthy", lastEventSeq: 1 },
              principal: {
                id: "prn_child",
                kind: "pi_child",
                permissions: ["read:state"],
              },
              limits: { maxLineBytes: 1_048_576 },
            }),
          );
        else if (frame.type === "request" && frame.method === "question.open") {
          const params = frame.params as Record<string, unknown>;
          socket.write(
            encodeFrame({
              v: 1,
              type: "server_request",
              id: "answer-1",
              method: "question.deliver_answer",
              params: {
                questionId: "q-1",
                runId: "run_1",
                toolCallId: params.toolCallId,
                state: "cancelled",
              },
            }),
          );
          setTimeout(
            () =>
              socket.write(
                encodeFrame({
                  v: 1,
                  type: "response",
                  id: frame.id,
                  method: "question.open",
                  ok: true,
                  result: {
                    questionId: "wrong",
                    runId: "run_1",
                    assignmentGeneration: 2,
                    toolCallId: params.toolCallId,
                    state: "open",
                  },
                }),
              ),
            5,
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = new PiBrokerClient({
    socketPath,
    sessionKey: "session",
    piSessionId: "pi-session",
    agentId: "agt_1",
    generation: 1,
    token: "token",
    onServerRequest: async (request) => {
      const params = request.params;
      client.resolveQuestionDelivery(
        String(params.questionId),
        String(params.runId),
        String(params.toolCallId),
        { state: params.state },
      );
      return { accepted: true };
    },
  });
  const tools: Array<{
    name: string;
    execute: (...args: never[]) => Promise<unknown>;
  }> = [];
  const api = {
    registerTool(definition: (typeof tools)[number]) {
      tools.push(definition);
    },
  };
  registerManagedChildTools(
    api as never,
    { adapter: fakeAdapter(), client } as never,
  );
  const ask = tools.find((tool) => tool.name === "orchestrator_ask");
  assert.ok(ask);
  try {
    await client.connect();
    client.markRegistrationReady();
    const question = {
      schemaVersion: 1,
      prompt: "Choose",
      context: null,
      options: [],
      allowFreeform: true,
      defaultOptionId: null,
      timeoutMs: 10_000,
    };
    await (ask.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
      "call-invalid",
      question,
      AbortSignal.timeout(1000),
      undefined,
      fakeContext(),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(client.connected, false);
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("managed tools inject exact assignment identity and query broker state first", async () => {
  const tools: Array<{
    name: string;
    execute: (...args: never[]) => Promise<unknown>;
  }> = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const api = {
    registerTool(definition: (typeof tools)[number]) {
      tools.push(definition);
    },
  };
  const client = {
    connected: true,
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { state: "accepted" };
    },
  };
  registerManagedChildTools(
    api as never,
    fakeAdapter() as never,
    client as never,
  );
  const resultTool = tools.find((tool) => tool.name === "orchestrator_result");
  assert.ok(resultTool);
  await (
    resultTool.execute as unknown as (...args: unknown[]) => Promise<unknown>
  )(
    "call",
    {
      schemaVersion: 1,
      status: "succeeded",
      summary: "ok",
      findings: [],
      changedFiles: [],
      commandsRun: [],
      tests: [],
      commits: [],
      artifacts: [],
      unresolved: [],
      questions: [],
      recommendedNextAction: null,
    },
    AbortSignal.timeout(1000),
    undefined,
    fakeContext(),
  );
  assert.equal(calls[0]?.method, "result.publish");
  assert.deepEqual(calls[0]?.params, {
    agentId: "agt_1",
    taskId: "tsk_1",
    runId: "run_1",
    assignmentGeneration: 2,
    result: {
      schemaVersion: 1,
      status: "succeeded",
      summary: "ok",
      findings: [],
      changedFiles: [],
      commandsRun: [],
      tests: [],
      commits: [],
      artifacts: [],
      unresolved: [],
      questions: [],
      recommendedNextAction: null,
    },
  });
});

test("managed ask observes a pre-ack waiter rejection without unhandled rejection", async () => {
  let unhandled = false;
  const listener = () => {
    unhandled = true;
  };
  process.once("unhandledRejection", listener);
  const tools: Array<{
    name: string;
    execute: (...args: never[]) => Promise<unknown>;
  }> = [];
  const api = {
    registerTool(definition: (typeof tools)[number]) {
      tools.push(definition);
    },
  };
  const client = {
    connected: true,
    request: async () =>
      await new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AGENT_DISCONNECTED")), 10),
      ),
    registerQuestionWaiter: async () => {
      throw new Error("CANCELLED");
    },
    discardQuestionWaiter: () => undefined,
    cancelQuestionWaiter: () => undefined,
  };
  registerManagedChildTools(
    api as never,
    fakeAdapter() as never,
    client as never,
  );
  const ask = tools.find((tool) => tool.name === "orchestrator_ask");
  assert.ok(ask);
  await assert.rejects(
    () =>
      (ask.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
        "call",
        {
          schemaVersion: 1,
          prompt: "Choose",
          context: null,
          options: [],
          allowFreeform: true,
          defaultOptionId: null,
          timeoutMs: 10_000,
        },
        AbortSignal.timeout(1000),
        undefined,
        fakeContext(),
      ),
    /AGENT_DISCONNECTED|CANCELLED/,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.removeListener("unhandledRejection", listener);
  assert.equal(unhandled, false);
});
test("managed ask cleans its waiter when question.open fails", async () => {
  let discarded = false;
  const tools: Array<{
    name: string;
    execute: (...args: never[]) => Promise<unknown>;
  }> = [];
  const api = {
    registerTool(definition: (typeof tools)[number]) {
      tools.push(definition);
    },
  };
  const client = {
    connected: true,
    request: async () => {
      throw new Error("BROKER_REQUEST_FAILED");
    },
    registerQuestionWaiter: async () => new Promise(() => undefined),
    discardQuestionWaiter: () => {
      discarded = true;
    },
    cancelQuestionWaiter: () => undefined,
  };
  registerManagedChildTools(
    api as never,
    fakeAdapter() as never,
    client as never,
  );
  const ask = tools.find((tool) => tool.name === "orchestrator_ask");
  assert.ok(ask);
  await assert.rejects(
    () =>
      (ask.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
        "call",
        {
          schemaVersion: 1,
          prompt: "Choose",
          context: null,
          options: [],
          allowFreeform: true,
          defaultOptionId: null,
          timeoutMs: 10_000,
        },
        AbortSignal.timeout(1000),
        undefined,
        fakeContext(),
      ),
    /BROKER_REQUEST_FAILED/,
  );
  assert.equal(discarded, true);
});
test("managed ask accepts the canonical terminal open acknowledgement", async () => {
  const tools: Array<{
    name: string;
    execute: (...args: never[]) => Promise<unknown>;
  }> = [];
  const api = {
    registerTool(definition: (typeof tools)[number]) {
      tools.push(definition);
    },
  };
  const canonicalQuestion = {
    schemaVersion: 1,
    prompt: "Choose",
    context: null,
    options: [{ id: "yes", label: "Yes", description: null }],
    allowFreeform: true,
    defaultOptionId: null,
    timeoutMs: 10_000,
  };
  const client = {
    connected: true,
    request: async () => ({
      questionId: "q-1",
      runId: "run_1",
      assignmentGeneration: 2,
      toolCallId: "call",
      state: "answered",
      answer: { optionId: "yes", text: null },
    }),
    registerQuestionWaiter: async () => ({
      state: "answered",
      answer: { optionId: "yes", text: null },
    }),
    bindQuestionWaiter: () => undefined,
    cancelQuestionWaiter: () => undefined,
    discardQuestionWaiter: () => undefined,
  };
  registerManagedChildTools(
    api as never,
    fakeAdapter() as never,
    client as never,
  );
  const ask = tools.find((tool) => tool.name === "orchestrator_ask");
  assert.ok(ask);
  const result = await (
    ask.execute as unknown as (...args: unknown[]) => Promise<unknown>
  )(
    "call",
    canonicalQuestion,
    AbortSignal.timeout(1000),
    undefined,
    fakeContext(),
  );
  const projected = (result as { content: Array<{ text: string }> }).content[0]!
    .text;
  assert.match(projected, /answered/);
  assert.doesNotMatch(
    projected,
    /questionId|runId|toolCallId|assignmentGeneration/,
  );
});
test("managed ask releases its binding after normal completion for tool ID reuse", async () => {
  let active = false;
  let discarded = 0;
  const tools: Array<{
    name: string;
    execute: (...args: never[]) => Promise<unknown>;
  }> = [];
  const api = {
    registerTool(definition: (typeof tools)[number]) {
      tools.push(definition);
    },
  };
  const client = {
    connected: true,
    request: async () => ({
      questionId: "q-1",
      runId: "run_1",
      assignmentGeneration: 2,
      toolCallId: "call",
      state: "open",
    }),
    registerQuestionWaiter: async () => {
      if (active) throw new Error("LIMIT_EXCEEDED");
      active = true;
      return {
        state: "answered",
        answer: { optionId: null, text: "freeform" },
      };
    },
    bindQuestionWaiter: () => undefined,
    discardQuestionWaiter: () => {
      active = false;
      discarded++;
    },
    cancelQuestionWaiter: () => undefined,
  };
  registerManagedChildTools(
    api as never,
    fakeAdapter() as never,
    client as never,
  );
  const ask = tools.find((tool) => tool.name === "orchestrator_ask");
  assert.ok(ask);
  const question = {
    schemaVersion: 1,
    prompt: "Choose",
    context: null,
    options: [],
    allowFreeform: true,
    defaultOptionId: null,
    timeoutMs: 10_000,
  };
  await (ask.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
    "call",
    question,
    AbortSignal.timeout(1000),
    undefined,
    fakeContext(),
  );
  await (ask.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
    "call",
    question,
    AbortSignal.timeout(1000),
    undefined,
    fakeContext(),
  );
  assert.equal(discarded, 2);
});
test("managed result runtime validator enforces canonical item bounds", async () => {
  const tools: Array<{
    name: string;
    execute: (...args: never[]) => Promise<unknown>;
  }> = [];
  const api = {
    registerTool(definition: (typeof tools)[number]) {
      tools.push(definition);
    },
  };
  const client = { connected: true, request: async () => ({}) };
  registerManagedChildTools(
    api as never,
    fakeAdapter() as never,
    client as never,
  );
  const resultTool = tools.find((tool) => tool.name === "orchestrator_result");
  assert.ok(resultTool);
  const base = {
    schemaVersion: 1,
    status: "succeeded",
    summary: "ok",
    findings: [],
    changedFiles: [],
    commandsRun: [],
    tests: [],
    commits: [],
    artifacts: [],
    unresolved: [],
    questions: [],
    recommendedNextAction: null,
  };
  await assert.rejects(
    () =>
      (
        resultTool.execute as unknown as (
          ...args: unknown[]
        ) => Promise<unknown>
      )(
        "call",
        {
          ...base,
          commandsRun: [{ command: "x", exitCode: -1, outcome: "failed" }],
        },
        AbortSignal.timeout(1000),
        undefined,
        fakeContext(),
      ),
    /INVALID_REQUEST/,
  );
});

test("parent tools let the broker authorize child targets without model identity fields", async () => {
  const tools: Array<{
    name: string;
    execute: (...args: never[]) => Promise<unknown>;
  }> = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const api = {
    registerTool(definition: (typeof tools)[number]) {
      tools.push(definition);
    },
  };
  const client = {
    connected: true,
    principal: {
      id: "principal_1",
      kind: "pi_parent" as const,
      permissions: ["read:state"],
    },
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return {};
    },
  };
  registerParentTools(api as never, fakeAdapter() as never, client as never);
  for (const [name, input] of [
    ["agent_get", { agentId: "child_1" }],
    [
      "agent_prompt",
      { agentId: "child_1", message: "x", delivery: "normal", timeoutMs: 1000 },
    ],
    ["task_get", { taskId: "child_task" }],
    ["agent_result", { taskId: "child_task" }],
  ] as const) {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool);
    await (tool.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
      "call",
      input,
      AbortSignal.timeout(1000),
      undefined,
      fakeContext(),
    );
  }
  assert.deepEqual(
    calls
      .filter((call) => call.method !== "agent.get")
      .map((call) => call.method),
    ["agent.prompt", "task.get", "result.get"],
  );
  assert.equal(calls.filter((call) => call.method === "agent.get").length, 1);
  for (const call of calls) {
    assert.equal(Object.hasOwn(call.params, "principalId"), false);
    assert.equal(Object.hasOwn(call.params, "parentAgentId"), false);
  }
});

test("agent_wait polls fresh broker state to an allowed outcome and enforces the broker timeout bound", async () => {
  const tools: Array<{
    name: string;
    parameters: {
      properties?: Record<string, { maximum?: number }>;
    };
    execute: (...args: never[]) => Promise<unknown>;
  }> = [];
  const states = ["working", "settled", "succeeded"];
  let calls = 0;
  const client = {
    connected: true,
    principal: {
      id: "principal_1",
      kind: "pi_parent" as const,
      permissions: ["read:state"],
    },
    request: async (method: string) => {
      assert.equal(method, "agent.wait");
      return {
        agentId: "child_1",
        taskId: "task_1",
        runId: "run_1",
        state: states[Math.min(calls++, states.length - 1)],
        settled: calls > 1,
      };
    },
  };
  registerParentTools(
    {
      registerTool: (definition: (typeof tools)[number]) =>
        tools.push(definition),
    } as never,
    fakeAdapter() as never,
    client as never,
  );
  const wait = tools.find((tool) => tool.name === "agent_wait");
  assert.ok(wait);
  assert.equal(wait.parameters.properties?.timeoutMs?.maximum, 30_000);
  const execute = wait.execute as unknown as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const response = await execute(
    "call",
    {
      agentId: "child_1",
      taskId: "task_1",
      runId: "run_1",
      until: ["succeeded"],
      timeoutMs: 1000,
    },
    AbortSignal.timeout(2000),
    undefined,
    fakeContext(),
  );
  assert.equal(calls, 3);
  assert.match(JSON.stringify(response), /succeeded/u);
  await assert.rejects(
    () =>
      execute(
        "call",
        {
          agentId: "child_1",
          taskId: "task_1",
          runId: "run_1",
          until: ["succeeded"],
          timeoutMs: 30_001,
        },
        AbortSignal.timeout(1000),
        undefined,
        fakeContext(),
      ),
    /INVALID_REQUEST/u,
  );
  assert.equal(calls, 3);
});

test("agent_wait bounds initial and repeat broker reads and observes cancellation", async () => {
  const makeExecute = (client: unknown) => {
    const tools: Array<{
      name: string;
      execute: (...args: never[]) => Promise<unknown>;
    }> = [];
    registerParentTools(
      {
        registerTool: (definition: (typeof tools)[number]) =>
          tools.push(definition),
      } as never,
      fakeAdapter() as never,
      client as never,
    );
    const wait = tools.find((tool) => tool.name === "agent_wait");
    assert.ok(wait);
    return wait.execute as unknown as (...args: unknown[]) => Promise<unknown>;
  };
  const input = {
    agentId: "child_1",
    taskId: "task_1",
    runId: "run_1",
    until: ["succeeded"],
    timeoutMs: 20,
    idempotencyKey: "model-call-key",
  };
  const slowRequest = () =>
    new Promise<Record<string, unknown>>((resolve) => {
      setTimeout(
        () =>
          resolve({
            agentId: "child_1",
            taskId: "task_1",
            runId: "run_1",
            state: "working",
            settled: false,
          }),
        500,
      );
    });

  const timeoutExecute = makeExecute({
    connected: true,
    principal: {
      id: "principal_1",
      kind: "pi_parent" as const,
      permissions: ["read:state"],
    },
    request: slowRequest,
  });
  const timeoutStarted = Date.now();
  await assert.rejects(
    () =>
      timeoutExecute(
        "call",
        input,
        AbortSignal.timeout(1000),
        undefined,
        fakeContext(),
      ),
    /WAIT_TIMEOUT/u,
  );
  assert.ok(Date.now() - timeoutStarted < 250);

  const options: Array<Record<string, unknown> | undefined> = [];
  let pollCalls = 0;
  const pollExecute = makeExecute({
    connected: true,
    principal: {
      id: "principal_1",
      kind: "pi_parent" as const,
      permissions: ["read:state"],
    },
    request: async (
      _method: string,
      _params: Record<string, unknown>,
      requestOptions?: Record<string, unknown>,
    ) => {
      options.push(requestOptions);
      if (pollCalls++ === 0)
        return {
          agentId: "child_1",
          taskId: "task_1",
          runId: "run_1",
          state: "working",
          settled: false,
        };
      return slowRequest();
    },
  });
  const pollStarted = Date.now();
  const latest = await pollExecute(
    "call",
    { ...input, timeoutMs: 150 },
    AbortSignal.timeout(1000),
    undefined,
    fakeContext(),
  );
  assert.ok(Date.now() - pollStarted < 350);
  assert.match(JSON.stringify(latest), /working/u);
  assert.equal(options[0]?.idempotencyKey, "model-call-key");
  assert.deepEqual(options[1], {});

  const abortExecute = makeExecute({
    connected: true,
    principal: {
      id: "principal_1",
      kind: "pi_parent" as const,
      permissions: ["read:state"],
    },
    request: slowRequest,
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const abortStarted = Date.now();
  await assert.rejects(
    () =>
      abortExecute(
        "call",
        { ...input, timeoutMs: 1000 },
        controller.signal,
        undefined,
        fakeContext(),
      ),
    /CANCELLED/u,
  );
  assert.ok(Date.now() - abortStarted < 250);
});

test("managed tools fail closed and do not queue while disconnected", async () => {
  const tools: Array<{
    name: string;
    execute: (...args: never[]) => Promise<unknown>;
  }> = [];
  const api = {
    registerTool(definition: (typeof tools)[number]) {
      tools.push(definition);
    },
  };
  const client = {
    request: async () => {
      throw new Error("AGENT_DISCONNECTED");
    },
  };
  registerManagedChildTools(
    api as never,
    fakeAdapter() as never,
    client as never,
  );
  const ask = tools.find((tool) => tool.name === "orchestrator_ask");
  assert.ok(ask);
  await assert.rejects(
    () =>
      (ask.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
        "call",
        { schemaVersion: 1 },
        AbortSignal.timeout(1000),
        undefined,
        fakeContext(),
      ),
    /AGENT_DISCONNECTED/,
  );
});
