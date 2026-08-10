import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import { digest } from "../../src/broker/authentication.js";
import type { EventStore } from "../../src/state/event-store.js";
import { resolvePaths, sessionKey } from "../../src/shared/paths.js";
import { createId } from "../../src/shared/ids.js";
import { encodeFrame, NdjsonDecoder } from "../../src/shared/protocol/codec.js";

type Frame = {
  type?: string;
  method?: string;
  params?: any;
  ok?: boolean;
  result?: any;
  error?: any;
  id?: string;
};
const body = {
  schemaVersion: 1 as const,
  status: "succeeded" as const,
  summary: "done",
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
const question = {
  schemaVersion: 1 as const,
  prompt: "Continue?",
  context: null,
  options: [{ id: "yes", label: "Yes", description: null }],
  allowFreeform: false,
  defaultOptionId: "yes",
  timeoutMs: 10_000,
};

class DomainHerdr {
  readonly tokens = new Map<string, string>();
  count = 0;
  constructor(readonly store: EventStore) {}
  async startupReconcile() {
    return [];
  }
  async verifyRoot(identity: any) {
    return {
      paneId: identity.paneId,
      terminalId: identity.terminalId,
      workspaceId: "w",
      cwd: "/fake",
    };
  }
  async provision(input: any) {
    const token = `token-${++this.count}`;
    this.tokens.set(input.agentId, token);
    await this.store.append({
      type: "herdr.provision.intent",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId: input.agentId },
      payload: { agentId: input.agentId },
    });
    await this.store.append({
      type: "herdr.provision.outcome",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId: input.agentId },
      payload: {
        agentId: input.agentId,
        state: "pending",
        paneId: `pane-${this.count}`,
        terminalId: `term-${this.count}`,
        tokenDigest: digest(token),
        generation: 1,
        parentAgentId: input.parentAgentId,
        ownerId: input.agentId,
      },
    });
    return {
      name: `child-${this.count}`,
      token: { token, digest: digest(token), generation: 1 },
      paneId: `pane-${this.count}`,
    };
  }
  async register(agentId: string, identity: any) {
    const resource = this.store.state.herdrResources?.[agentId];
    await this.store.append({
      type: "herdr.provision.outcome",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId },
      payload: {
        agentId,
        state: "registered",
        paneId: identity.paneId,
        terminalId: identity.terminalId,
        sessionId: identity.sessionId,
        generation: identity.generation,
        tokenDigest: resource?.tokenDigest,
        parentAgentId: resource?.parentAgentId,
        ownerId: agentId,
      },
    });
  }
}

function request(
  socket: Socket,
  method: string,
  params: Record<string, unknown>,
): Promise<Frame> {
  const id = createId("evt");
  socket.write(encodeFrame({ v: 1, type: "request", id, method, params }));
  return new Promise((resolve, reject) => {
    const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
    const timer = setTimeout(
      () => reject(new Error(`timeout ${method}`)),
      5_000,
    );
    const onData = (chunk: Buffer) => {
      for (const item of decoder.push(chunk)) {
        if (!item.ok || item.value.id !== id) continue;
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(item.value);
      }
    };
    socket.on("data", onData);
  });
}
async function connect(
  paths: ReturnType<typeof resolvePaths>,
  secret: string,
  kind = "pi_parent",
): Promise<Socket> {
  const socket = createConnection(paths.socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    encodeFrame({
      v: 1,
      type: "hello",
      id: createId("evt"),
      client: {
        kind,
        name: "domain-test",
        version: "0.1.0",
        capabilities: ["events.replay"],
      },
      sessionKey: sessionKey(paths.socket),
      auth: { kind: "client_secret", secret },
    }),
  );
  await new Promise<void>((resolve, reject) => {
    const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
    const timer = setTimeout(() => reject(new Error("hello timeout")), 5_000);
    const onData = (chunk: Buffer) => {
      for (const item of decoder.push(chunk)) {
        if (!item.ok || item.value.type !== "hello_result") continue;
        clearTimeout(timer);
        socket.off("data", onData);
        if (item.value.ok !== true) reject(new Error("hello rejected"));
        else resolve();
      }
    };
    socket.on("data", onData);
  });
  return socket;
}
async function connectManaged(
  paths: ReturnType<typeof resolvePaths>,
  token: string,
  agentId: string,
  session: string,
  onServer: (frame: Frame, socket: Socket) => void,
): Promise<Socket> {
  const socket = createConnection(paths.socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
  let resolveHello!: () => void;
  const hello = new Promise<void>((resolve) => {
    resolveHello = resolve;
  });
  socket.on("data", (chunk) => {
    for (const item of decoder.push(chunk)) {
      if (!item.ok) continue;
      const frame = item.value;
      if (frame.type === "hello_result") resolveHello();
      else if (frame.type === "server_request") onServer(frame, socket);
    }
  });
  socket.write(
    encodeFrame({
      v: 1,
      type: "hello",
      id: createId("evt"),
      client: {
        kind: "pi_child",
        name: "strict-child",
        version: "0.1.0",
        capabilities: ["pi.lifecycle"],
      },
      sessionKey: sessionKey(paths.socket),
      auth: {
        kind: "agent_token",
        token,
        agentId,
        generation: 1,
        piSessionId: session,
      },
    }),
  );
  await hello;
  return socket;
}

function resultOf(frame: Frame): any {
  assert.equal(frame.ok, true, JSON.stringify(frame.error));
  return frame.result;
}

test("broker domain wire persists correlated result, question, workflow, and replay across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "domain-wire-"));
  const runtime = await mkdtemp(join(tmpdir(), "domain-wire-runtime-"));
  const paths = {
    ...resolvePaths(join(runtime, "herdr.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
  const broker = new Broker(paths, {
    herdrFactory: async (store) =>
      ({
        store,
        startupReconcile: async () => [],
        verifyRoot: async (identity: any) => ({
          paneId: identity.paneId,
          terminalId: identity.terminalId,
          workspaceId: "w",
          cwd: "/fake",
        }),
      }) as any,
  });
  await broker.start();
  try {
    const secret = await readFile(paths.secret, "utf8").then((value) =>
      value.trim(),
    );
    let socket = await connect(paths, secret);
    const registered = resultOf(
      await request(socket, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "pane",
          terminalId: "terminal",
          detectedKind: "pi",
          name: "primary",
        },
        pi: {
          sessionId: "session",
          sessionName: "primary",
          capabilities: {},
          state: {},
        },
      }),
    );
    const workflow = resultOf(
      await request(socket, "workflow.create", {
        objective: "inspect",
        parentAgentId: registered.agentId,
        definition: {
          version: 1,
          id: "single",
          name: "Single",
          description: "test",
          mode: "single",
          failureMode: "collect_all",
          maxCorrectionLoops: 0,
          steps: [
            {
              key: "one",
              profileId: "scout",
              title: "One",
              objectiveTemplate: "{{input.objective}}",
              constraints: [],
              dependsOn: [],
              resultProjection: [],
              isolationMode: "shared-readonly",
            },
          ],
        },
      }),
    );
    const taskId = workflow.tasks[0].taskId;
    const run = resultOf(
      await request(socket, "run.create", {
        taskId,
        agentId: registered.agentId,
        assignmentGeneration: 1,
      }),
    );
    const opened = resultOf(
      await request(socket, "question.open", {
        agentId: registered.agentId,
        taskId,
        runId: run.runId,
        assignmentGeneration: 1,
        toolCallId: "tool-question-wire",
        question,
      }),
    );
    const operator = await connect(paths, secret, "human");
    assert.equal(
      (
        await request(operator, "question.answer", {
          questionId: opened.questionId,
          answer: { optionId: null },
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await request(operator, "question.answer", {
          questionId: opened.questionId,
          answer: { optionId: "missing", text: null },
        })
      ).ok,
      false,
    );
    resultOf(
      await request(operator, "question.answer", {
        questionId: opened.questionId,
        answer: { optionId: "yes", text: null },
      }),
    );
    assert.equal(
      broker.store.state.questions![opened.questionId]!.state,
      "answered",
    );
    const terminalReplaySeq = broker.store.state.lastEventSeq;
    const terminalReplay = resultOf(
      await request(socket, "question.open", {
        agentId: registered.agentId,
        taskId,
        runId: run.runId,
        assignmentGeneration: 1,
        toolCallId: "tool-question-wire",
        question,
      }),
    );
    assert.equal(terminalReplay.state, "answered");
    assert.deepEqual(terminalReplay.answer, { optionId: "yes", text: null });
    assert.equal(broker.store.state.lastEventSeq, terminalReplaySeq);
    const freeform = resultOf(
      await request(socket, "question.open", {
        agentId: registered.agentId,
        taskId,
        runId: run.runId,
        assignmentGeneration: 1,
        toolCallId: "tool-question-freeform",
        question: {
          schemaVersion: 1,
          prompt: "Explain",
          context: null,
          options: [],
          allowFreeform: true,
          defaultOptionId: null,
          timeoutMs: 10_000,
        },
      }),
    );
    const freeformAnswer = resultOf(
      await request(operator, "question.answer", {
        questionId: freeform.questionId,
        answer: { optionId: null, text: "freeform answer" },
      }),
    );
    assert.deepEqual(freeformAnswer.answer, {
      optionId: null,
      text: "freeform answer",
    });
    operator.destroy();
    resultOf(
      await request(socket, "result.publish", {
        agentId: registered.agentId,
        taskId,
        runId: run.runId,
        assignmentGeneration: 1,
        result: body,
      }),
    );
    const got = resultOf(
      await request(socket, "result.get", {
        resultId: (await request(socket, "task.collect", { taskIds: [taskId] }))
          .result.items[0].id,
      }),
    );
    assert.equal(got.payload.summary, "done");
    socket.destroy();
    await broker.stop();
    const restarted = new Broker(paths);
    await restarted.start();
    socket = await connect(paths, secret, "human");
    const replay = resultOf(
      await request(socket, "events.subscribe", {
        fromSeq: 0,
        includeSnapshot: true,
        filters: { events: ["question.*", "result.*", "workflow.*"] },
      }),
    );
    assert.equal(replay.snapshot.workflows.length, 1);
    assert.equal(replay.snapshot.questions.length, 2);
    assert.equal(replay.snapshot.results.length, 1);
    socket.destroy();
    await restarted.stop();
  } finally {
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production broker restarts an open question from its durable absolute deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "domain-question-timeout-"));
  const runtime = await mkdtemp(
    join(tmpdir(), "domain-question-timeout-runtime-"),
  );
  const paths = {
    ...resolvePaths(join(runtime, "herdr.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const timers: Array<{
    callback: () => void;
    delay: number;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  const schedule = (callback: () => void, delay: number) => {
    const handle = setTimeout(() => undefined, 2_000_000);
    timers.push({ callback, delay, handle });
    return handle;
  };
  const makeBroker = () =>
    new Broker(paths, {
      now: () => clock,
      setTimeout: schedule,
      herdrFactory: async (store) =>
        ({
          store,
          startupReconcile: async () => [],
          verifyRoot: async (identity: any) => ({
            paneId: identity.paneId,
            terminalId: identity.terminalId,
            workspaceId: "w",
            cwd: "/fake",
          }),
        }) as any,
    });
  let broker = makeBroker();
  await broker.start();
  let socket: Socket | undefined;
  try {
    const secret = (await readFile(paths.secret, "utf8")).trim();
    socket = await connect(paths, secret);
    const registered = resultOf(
      await request(socket, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "pane-timeout",
          terminalId: "terminal-timeout",
          detectedKind: "pi",
          name: "timeout",
        },
        pi: {
          sessionId: "session-timeout",
          sessionName: "timeout",
          capabilities: {},
          state: {},
        },
      }),
    );
    const workflow = resultOf(
      await request(socket, "workflow.create", {
        objective: "timeout",
        parentAgentId: registered.agentId,
        definition: {
          version: 1,
          id: "timeout",
          name: "Timeout",
          description: "timeout",
          mode: "single",
          failureMode: "collect_all",
          maxCorrectionLoops: 0,
          steps: [
            {
              key: "one",
              profileId: "scout",
              title: "One",
              objectiveTemplate: "{{input.objective}}",
              constraints: [],
              dependsOn: [],
              resultProjection: [],
              isolationMode: "shared-readonly",
            },
          ],
        },
      }),
    );
    const taskId = workflow.tasks[0].taskId;
    const run = resultOf(
      await request(socket, "run.create", {
        taskId,
        agentId: registered.agentId,
        assignmentGeneration: 1,
      }),
    );
    const opened = resultOf(
      await request(socket, "question.open", {
        agentId: registered.agentId,
        taskId,
        runId: run.runId,
        assignmentGeneration: 1,
        toolCallId: "tool-timeout",
        question: { ...question, timeoutMs: 10_000 },
      }),
    );
    assert.equal(
      broker.store.state.questions![opened.questionId]!.state,
      "open",
    );
    socket.destroy();
    socket = undefined;
    const beforeStopSeq = broker.store.state.lastEventSeq;
    await broker.stop();
    assert.equal(broker.store.state.lastEventSeq, beforeStopSeq);
    clock += 9_000;
    broker = makeBroker();
    await broker.start();
    socket = await connect(paths, secret);
    assert.equal(
      broker.store.state.questions![opened.questionId]!.state,
      "open",
    );
    assert.equal(timers.at(-1)!.delay, 1_000);
    clock += 1_000;
    const answerRace = request(socket, "question.answer", {
      questionId: opened.questionId,
      answer: { optionId: "yes", text: null },
    });
    timers.at(-1)!.callback();
    await answerRace;
    for (
      let attempt = 0;
      attempt < 20 &&
      broker.store.state.questions![opened.questionId]!.state === "open";
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const raceQuestion = broker.store.state.questions![opened.questionId]!;
    assert.ok(["answered", "timed_out"].includes(raceQuestion.state));
    assert.equal(
      Object.values(broker.store.events).filter(
        (event) =>
          event.entityRefs?.questionId === opened.questionId &&
          [
            "question.answered",
            "question.timed_out",
            "question.cancelled",
          ].includes(event.type),
      ).length,
      1,
    );
    assert.equal(
      broker.store.state.runs[run.runId]!.state,
      raceQuestion.state === "answered" ? "working" : "failed",
    );
    socket = await connect(paths, secret);
    const registeredExpired = resultOf(
      await request(socket, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "pane-expired",
          terminalId: "terminal-expired",
          detectedKind: "pi",
          name: "expired",
        },
        pi: {
          sessionId: "session-expired",
          sessionName: "expired",
          capabilities: {},
          state: {},
        },
      }),
    );
    const workflowExpired = resultOf(
      await request(socket, "workflow.create", {
        objective: "expired",
        parentAgentId: registeredExpired.agentId,
        definition: {
          version: 1,
          id: "expired",
          name: "Expired",
          description: "expired",
          mode: "single",
          failureMode: "collect_all",
          maxCorrectionLoops: 0,
          steps: [
            {
              key: "one",
              profileId: "scout",
              title: "One",
              objectiveTemplate: "{{input.objective}}",
              constraints: [],
              dependsOn: [],
              resultProjection: [],
              isolationMode: "shared-readonly",
            },
          ],
        },
      }),
    );
    const runExpired = resultOf(
      await request(socket, "run.create", {
        taskId: workflowExpired.tasks[0].taskId,
        agentId: registeredExpired.agentId,
        assignmentGeneration: 1,
      }),
    );
    const openedExpired = resultOf(
      await request(socket, "question.open", {
        agentId: registeredExpired.agentId,
        taskId: workflowExpired.tasks[0].taskId,
        runId: runExpired.runId,
        assignmentGeneration: 1,
        toolCallId: "tool-expired",
        question: { ...question, timeoutMs: 10_000 },
      }),
    );
    socket.destroy();
    socket = undefined;
    clock += 20_000;
    await broker.stop();
    broker = makeBroker();
    await broker.start();
    assert.equal(
      broker.store.state.questions![openedExpired.questionId]!.state,
      "timed_out",
    );
  } finally {
    socket?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production broker immediately terminalizes an already expired durable question", async () => {
  const root = await mkdtemp(join(tmpdir(), "domain-question-timeout-"));
  const runtime = await mkdtemp(
    join(tmpdir(), "domain-question-timeout-runtime-"),
  );
  const paths = {
    ...resolvePaths(join(runtime, "herdr.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const timers: Array<{
    callback: () => void;
    delay: number;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  const schedule = (callback: () => void, delay: number) => {
    const handle = setTimeout(() => undefined, 2_000_000);
    timers.push({ callback, delay, handle });
    return handle;
  };
  const makeBroker = () =>
    new Broker(paths, {
      now: () => clock,
      setTimeout: schedule,
      herdrFactory: async (store) =>
        ({
          store,
          startupReconcile: async () => [],
          verifyRoot: async (identity: any) => ({
            paneId: identity.paneId,
            terminalId: identity.terminalId,
            workspaceId: "w",
            cwd: "/fake",
          }),
        }) as any,
    });
  let broker = makeBroker();
  await broker.start();
  let socket: Socket | undefined;
  try {
    const secret = (await readFile(paths.secret, "utf8")).trim();
    socket = await connect(paths, secret);
    const registered = resultOf(
      await request(socket, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "pane-timeout",
          terminalId: "terminal-timeout",
          detectedKind: "pi",
          name: "timeout",
        },
        pi: {
          sessionId: "session-timeout",
          sessionName: "timeout",
          capabilities: {},
          state: {},
        },
      }),
    );
    const workflow = resultOf(
      await request(socket, "workflow.create", {
        objective: "timeout",
        parentAgentId: registered.agentId,
        definition: {
          version: 1,
          id: "timeout",
          name: "Timeout",
          description: "timeout",
          mode: "single",
          failureMode: "collect_all",
          maxCorrectionLoops: 0,
          steps: [
            {
              key: "one",
              profileId: "scout",
              title: "One",
              objectiveTemplate: "{{input.objective}}",
              constraints: [],
              dependsOn: [],
              resultProjection: [],
              isolationMode: "shared-readonly",
            },
          ],
        },
      }),
    );
    const taskId = workflow.tasks[0].taskId;
    const run = resultOf(
      await request(socket, "run.create", {
        taskId,
        agentId: registered.agentId,
        assignmentGeneration: 1,
      }),
    );
    const opened = resultOf(
      await request(socket, "question.open", {
        agentId: registered.agentId,
        taskId,
        runId: run.runId,
        assignmentGeneration: 1,
        toolCallId: "tool-timeout",
        question: { ...question, timeoutMs: 10_000 },
      }),
    );
    assert.equal(
      broker.store.state.questions![opened.questionId]!.state,
      "open",
    );
    socket.destroy();
    socket = undefined;
    await broker.stop();
    clock += 20_000;
    broker = makeBroker();
    await broker.start();
    assert.equal(
      broker.store.state.questions![opened.questionId]!.state,
      "timed_out",
    );
    assert.equal(broker.store.state.runs[run.runId]!.state, "failed");
  } finally {
    socket?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production broker task cancellation terminalizes an open question durably", async () => {
  const root = await mkdtemp(join(tmpdir(), "domain-question-timeout-"));
  const runtime = await mkdtemp(
    join(tmpdir(), "domain-question-timeout-runtime-"),
  );
  const paths = {
    ...resolvePaths(join(runtime, "herdr.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const timers: Array<{
    callback: () => void;
    delay: number;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  const schedule = (callback: () => void, delay: number) => {
    const handle = setTimeout(() => undefined, 2_000_000);
    timers.push({ callback, delay, handle });
    return handle;
  };
  const makeBroker = () =>
    new Broker(paths, {
      now: () => clock,
      setTimeout: schedule,
      herdrFactory: async (store) =>
        ({
          store,
          startupReconcile: async () => [],
          verifyRoot: async (identity: any) => ({
            paneId: identity.paneId,
            terminalId: identity.terminalId,
            workspaceId: "w",
            cwd: "/fake",
          }),
        }) as any,
    });
  let broker = makeBroker();
  await broker.start();
  let socket: Socket | undefined;
  try {
    const secret = (await readFile(paths.secret, "utf8")).trim();
    socket = await connect(paths, secret);
    const registered = resultOf(
      await request(socket, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "pane-timeout",
          terminalId: "terminal-timeout",
          detectedKind: "pi",
          name: "timeout",
        },
        pi: {
          sessionId: "session-timeout",
          sessionName: "timeout",
          capabilities: {},
          state: {},
        },
      }),
    );
    const workflow = resultOf(
      await request(socket, "workflow.create", {
        objective: "timeout",
        parentAgentId: registered.agentId,
        definition: {
          version: 1,
          id: "timeout",
          name: "Timeout",
          description: "timeout",
          mode: "single",
          failureMode: "collect_all",
          maxCorrectionLoops: 0,
          steps: [
            {
              key: "one",
              profileId: "scout",
              title: "One",
              objectiveTemplate: "{{input.objective}}",
              constraints: [],
              dependsOn: [],
              resultProjection: [],
              isolationMode: "shared-readonly",
            },
          ],
        },
      }),
    );
    const taskId = workflow.tasks[0].taskId;
    const run = resultOf(
      await request(socket, "run.create", {
        taskId,
        agentId: registered.agentId,
        assignmentGeneration: 1,
      }),
    );
    const opened = resultOf(
      await request(socket, "question.open", {
        agentId: registered.agentId,
        taskId,
        runId: run.runId,
        assignmentGeneration: 1,
        toolCallId: "tool-timeout",
        question: { ...question, timeoutMs: 10_000 },
      }),
    );
    assert.equal(
      broker.store.state.questions![opened.questionId]!.state,
      "open",
    );
    socket.destroy();
    socket = undefined;
    await broker.stop();
    clock += 20_000;
    broker = makeBroker();
    await broker.start();
    assert.equal(
      broker.store.state.questions![opened.questionId]!.state,
      "timed_out",
    );
    assert.equal(broker.store.state.runs[run.runId]!.state, "failed");
  } finally {
    socket?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production strict managed child task.cancel-versus-timeout race", async () => {
  const root = await mkdtemp(join(tmpdir(), "domain-cancel-delivery-"));
  const runtime = await mkdtemp(
    join(tmpdir(), "domain-cancel-delivery-runtime-"),
  );
  const paths = {
    ...resolvePaths(join(runtime, "herdr.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
  let herdr!: DomainHerdr;
  const timers: Array<() => void> = [];
  const broker = new Broker(paths, {
    now: () => Date.now(),
    setTimeout: (callback) => {
      const handle = setTimeout(() => undefined, 2_000_000);
      timers.push(callback);
      return handle;
    },
    herdrFactory: async (store) => (herdr = new DomainHerdr(store)) as any,
  });
  await broker.start();
  let parent: Socket | undefined;
  let child: Socket | undefined;
  try {
    const secret = (await readFile(paths.secret, "utf8")).trim();
    parent = await connect(paths, secret);
    const parentRegistration = resultOf(
      await request(parent, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "root-pane",
          terminalId: "root-term",
          detectedKind: "pi",
          name: "parent",
        },
        pi: {
          sessionId: "parent-session",
          sessionName: "parent",
          capabilities: {},
          state: {},
        },
      }),
    );
    assert.ok(parentRegistration.agentId);
    const delegated = resultOf(
      await request(parent, "delegate.execute", {
        mode: "single",
        title: "cancel",
        steps: [
          {
            key: "one",
            profileId: "scout",
            title: "One",
            objective: "cancel",
            dependsOn: [],
          },
        ],
        wait: false,
        waitUntil: [],
        timeoutMs: 10_000,
        failureMode: "collect_all",
        dryRun: false,
      }),
    );
    const item = delegated.tasks[0];
    const agent = broker.store.state.agents[item.agentId];
    assert.ok(agent);
    let resolveDelivery!: () => void;
    const deliveredStates: string[] = [];
    const delivery = new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    });
    child = await connectManaged(
      paths,
      herdr.tokens.get(item.agentId)!,
      item.agentId,
      "strict-child",
      (frame, socket) => {
        if (frame.method === "assignment.deliver") {
          socket.write(
            encodeFrame({
              v: 1,
              type: "server_response",
              id: frame.id,
              ok: true,
              result: { status: "accepted" },
            }),
          );
          return;
        }
        assert.equal(frame.method, "question.deliver_answer");
        assert.deepEqual(Object.keys(frame.params).sort(), [
          "expected",
          "questionId",
          "runId",
          "state",
          "toolCallId",
        ]);
        deliveredStates.push(frame.params.state);
        assert.ok(["cancelled", "timed_out"].includes(frame.params.state));
        assert.equal(frame.params.expected.assignmentGeneration, 1);
        assert.equal(frame.params.expected.runId, item.runId);
        assert.equal(
          broker.store.state.questions?.[frame.params.questionId]?.state,
          frame.params.state,
        );
        assert.equal(
          broker.store.state.runs[item.runId]?.state,
          frame.params.state === "cancelled" ? "cancelled" : "failed",
        );
        assert.equal(
          broker.store.state.tasks[item.taskId]?.state,
          frame.params.state === "cancelled" ? "cancelled" : "failed",
        );
        socket.write(
          encodeFrame({
            v: 1,
            type: "server_response",
            id: frame.id,
            ok: true,
            result: { accepted: true },
          }),
        );
        resolveDelivery();
      },
    );
    const registered = resultOf(
      await request(child, "agent.register_managed", {
        agentId: item.agentId,
        generation: 1,
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "pane-1",
          terminalId: "term-1",
          detectedKind: "pi",
          name: "strict-child",
        },
        pi: {
          sessionId: "strict-child",
          sessionName: "strict-child",
          capabilities: {},
          state: {},
        },
      }),
    );
    const run = broker.store.state.runs[item.runId]!;
    for (
      let attempt = 0;
      attempt < 20 &&
      broker.store.state.runs[item.runId]?.assignmentDeliveryState !==
        "accepted";
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      broker.store.state.runs[item.runId]?.assignmentDeliveryState,
      "accepted",
    );
    assert.equal(registered.agentId, item.agentId);
    resultOf(
      await request(child, "agent.lifecycle_event", {
        agentId: item.agentId,
        connectionGeneration: registered.connectionGeneration,
        adapterSeq: 1,
        event: "turn_start",
        piSessionId: "strict-child",
        turnIndex: 1,
        agentCycleId: "cancel-cycle",
        assignment: {
          assignmentId: run.assignmentId,
          generation: run.assignmentGeneration,
        },
        safeData: { toolName: null, contextPercent: 0 },
      }),
    );
    const questionAck = resultOf(
      await request(child, "question.open", {
        agentId: item.agentId,
        taskId: item.taskId,
        runId: item.runId,
        assignmentGeneration: run.assignmentGeneration,
        toolCallId: "cancel-tool",
        question: {
          schemaVersion: 1,
          prompt: "Cancel",
          context: null,
          options: [{ id: "a", label: "A", description: null }],
          allowFreeform: false,
          defaultOptionId: "a",
          timeoutMs: 10_000,
        },
      }),
    );
    assert.equal(questionAck.toolCallId, "cancel-tool");
    const terminalBefore = broker.store.state.lastEventSeq;
    const cancelRace = request(parent, "task.cancel", {
      taskId: item.taskId,
      reason: "test_cancel",
      cascade: true,
    });
    timers.at(-1)?.();
    assert.equal((await cancelRace).ok, true);
    await Promise.race([
      delivery,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("delivery timeout")), 2_000),
      ),
    ]);
    assert.equal(
      Object.values(broker.store.state.questions ?? {}).filter(
        (q) =>
          q.runId === item.runId &&
          ["answered", "cancelled", "timed_out"].includes(q.state),
      ).length,
      1,
    );
    assert.ok(broker.store.state.lastEventSeq > terminalBefore);
    assert.equal((await request(parent, "system.status", {})).ok, true);
    assert.equal(deliveredStates.length, 1);
    assert.equal(
      Object.values(broker.store.events).filter(
        (event) =>
          event.entityRefs?.questionId === questionAck.questionId &&
          [
            "question.answered",
            "question.cancelled",
            "question.timed_out",
          ].includes(event.type),
      ).length,
      1,
    );
  } finally {
    child?.destroy();
    parent?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production strict child receives durable timeout delivery after durable timeout request", async () => {
  const root = await mkdtemp(join(tmpdir(), "domain-cancel-delivery-"));
  const runtime = await mkdtemp(
    join(tmpdir(), "domain-cancel-delivery-runtime-"),
  );
  const paths = {
    ...resolvePaths(join(runtime, "herdr.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
  let herdr!: DomainHerdr;
  const broker = new Broker(paths, {
    herdrFactory: async (store) => (herdr = new DomainHerdr(store)) as any,
  });
  await broker.start();
  let parent: Socket | undefined;
  let child: Socket | undefined;
  try {
    const secret = (await readFile(paths.secret, "utf8")).trim();
    parent = await connect(paths, secret);
    const parentRegistration = resultOf(
      await request(parent, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "root-pane",
          terminalId: "root-term",
          detectedKind: "pi",
          name: "parent",
        },
        pi: {
          sessionId: "parent-session",
          sessionName: "parent",
          capabilities: {},
          state: {},
        },
      }),
    );
    assert.ok(parentRegistration.agentId);
    const delegated = resultOf(
      await request(parent, "delegate.execute", {
        mode: "single",
        title: "cancel",
        steps: [
          {
            key: "one",
            profileId: "scout",
            title: "One",
            objective: "cancel",
            dependsOn: [],
          },
        ],
        wait: false,
        waitUntil: [],
        timeoutMs: 10_000,
        failureMode: "collect_all",
        dryRun: false,
      }),
    );
    const item = delegated.tasks[0];
    const agent = broker.store.state.agents[item.agentId];
    assert.ok(agent);
    let resolveDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    });
    child = await connectManaged(
      paths,
      herdr.tokens.get(item.agentId)!,
      item.agentId,
      "strict-child",
      (frame, socket) => {
        if (frame.method === "assignment.deliver") {
          socket.write(
            encodeFrame({
              v: 1,
              type: "server_response",
              id: frame.id,
              ok: true,
              result: { status: "accepted" },
            }),
          );
          return;
        }
        assert.equal(frame.method, "question.deliver_answer");
        assert.deepEqual(Object.keys(frame.params).sort(), [
          "expected",
          "questionId",
          "runId",
          "state",
          "toolCallId",
        ]);
        assert.equal(frame.params.state, "timed_out");
        assert.equal(frame.params.expected.assignmentGeneration, 1);
        assert.equal(frame.params.expected.runId, item.runId);
        assert.equal(
          broker.store.state.questions?.[frame.params.questionId]?.state,
          "timed_out",
        );
        assert.equal(broker.store.state.runs[item.runId]?.state, "failed");
        assert.equal(broker.store.state.tasks[item.taskId]?.state, "failed");
        socket.write(
          encodeFrame({
            v: 1,
            type: "server_response",
            id: frame.id,
            ok: true,
            result: { accepted: true },
          }),
        );
        resolveDelivery();
      },
    );
    const registered = resultOf(
      await request(child, "agent.register_managed", {
        agentId: item.agentId,
        generation: 1,
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "pane-1",
          terminalId: "term-1",
          detectedKind: "pi",
          name: "strict-child",
        },
        pi: {
          sessionId: "strict-child",
          sessionName: "strict-child",
          capabilities: {},
          state: {},
        },
      }),
    );
    const run = broker.store.state.runs[item.runId]!;
    for (
      let attempt = 0;
      attempt < 20 &&
      broker.store.state.runs[item.runId]?.assignmentDeliveryState !==
        "accepted";
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      broker.store.state.runs[item.runId]?.assignmentDeliveryState,
      "accepted",
    );
    assert.equal(registered.agentId, item.agentId);
    resultOf(
      await request(child, "agent.lifecycle_event", {
        agentId: item.agentId,
        connectionGeneration: registered.connectionGeneration,
        adapterSeq: 1,
        event: "turn_start",
        piSessionId: "strict-child",
        turnIndex: 1,
        agentCycleId: "cancel-cycle",
        assignment: {
          assignmentId: run.assignmentId,
          generation: run.assignmentGeneration,
        },
        safeData: { toolName: null, contextPercent: 0 },
      }),
    );
    const questionAck = resultOf(
      await request(child, "question.open", {
        agentId: item.agentId,
        taskId: item.taskId,
        runId: item.runId,
        assignmentGeneration: run.assignmentGeneration,
        toolCallId: "cancel-tool",
        question: {
          schemaVersion: 1,
          prompt: "Cancel",
          context: null,
          options: [{ id: "a", label: "A", description: null }],
          allowFreeform: false,
          defaultOptionId: "a",
          timeoutMs: 10_000,
        },
      }),
    );
    assert.equal(questionAck.toolCallId, "cancel-tool");
    const terminalBefore = broker.store.state.lastEventSeq;
    const operator = await connect(paths, secret, "human");
    assert.equal(
      (
        await request(operator, "question.timeout", {
          questionId: questionAck.questionId,
        })
      ).ok,
      true,
    );
    operator.destroy();
    await Promise.race([
      delivery,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("delivery timeout")), 2_000),
      ),
    ]);
    assert.equal(
      Object.values(broker.store.state.questions ?? {}).filter(
        (q) =>
          q.runId === item.runId &&
          ["answered", "cancelled", "timed_out"].includes(q.state),
      ).length,
      1,
    );
    assert.ok(broker.store.state.lastEventSeq > terminalBefore);
  } finally {
    child?.destroy();
    parent?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});
