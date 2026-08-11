import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import { digest } from "../../src/broker/authentication.js";
import type { EventStore } from "../../src/state/event-store.js";
import { sessionKey, type ResolvedPaths } from "../../src/shared/paths.js";
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
  onProvision?: (input: any) => void;
  readonly provisions: any[] = [];
  readonly stops: any[] = [];
  readonly interrupts: any[] = [];
  readonly stopCompleted: Promise<void>;
  #resolveStop!: () => void;
  constructor(
    readonly store: EventStore,
    readonly onStop?: () => void,
  ) {
    this.stopCompleted = new Promise((resolve) => {
      this.#resolveStop = resolve;
    });
  }
  async interrupt(guard: any) {
    this.interrupts.push(guard);
  }
  async stop(guard: any) {
    this.stops.push(guard);
    this.onStop?.();
    this.#resolveStop();
  }
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
    this.provisions.push(input);
    this.onProvision?.(input);
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

class DeterministicTimers {
  readonly entries = new Map<
    NodeJS.Timeout,
    { due: number; order: number; callback: () => void; active: boolean }
  >();
  now: number;
  #order = 0;
  constructor(now = Date.now()) {
    this.now = now;
  }
  setTimeout = (callback: () => void, delayMs: number): NodeJS.Timeout => {
    const handle = {
      timer: Symbol("deterministic-timer"),
      unref: () => handle,
    } as unknown as NodeJS.Timeout;
    this.entries.set(handle, {
      due: this.now + delayMs,
      order: this.#order++,
      callback,
      active: true,
    });
    return handle;
  };
  clearTimeout = (handle: NodeJS.Timeout): void => {
    const entry = this.entries.get(handle);
    if (entry) entry.active = false;
  };
  advance(until: number): void {
    this.now = until;
    while (true) {
      const due = [...this.entries.entries()]
        .filter(([, entry]) => entry.active && entry.due <= until)
        .sort(([, a], [, b]) => a.due - b.due || a.order - b.order);
      if (!due.length) break;
      for (const [handle, entry] of due) {
        if (!entry.active) continue;
        this.clearTimeout(handle);
        entry.callback();
      }
    }
    assert.equal(
      [...this.entries.values()].filter(
        (entry) => entry.active && entry.due <= until,
      ).length,
      0,
    );
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
  paths: ResolvedPaths & { sessionKey: string },
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
      sessionKey: paths.sessionKey!,
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
        if (item.value.ok !== true) {
          const error = item.value.error as
            { code?: unknown; message?: unknown } | undefined;
          reject(
            new Error(
              `hello rejected: ${String(error?.code)} ${String(error?.message)}`,
            ),
          );
        } else resolve();
      }
    };
    socket.on("data", onData);
  });
  return socket;
}
async function connectManaged(
  paths: ResolvedPaths & { sessionKey: string },
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
  let rejectHello!: (error: Error) => void;
  const hello = new Promise<void>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  socket.on("data", (chunk) => {
    for (const item of decoder.push(chunk)) {
      if (!item.ok) continue;
      const frame = item.value;
      if (frame.type === "hello_result") {
        if (frame.ok === true) resolveHello();
        else rejectHello(new Error("hello rejected"));
      } else if (frame.type === "server_request") onServer(frame, socket);
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
      sessionKey: paths.sessionKey!,
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

async function connectManagedHello(
  paths: ResolvedPaths & { sessionKey: string },
  token: string,
  agentId: string,
  session: string,
  onServer?: (frame: Frame, socket: Socket) => void,
): Promise<{ socket: Socket; hello: Frame; close: Promise<void> }> {
  const socket = createConnection(paths.socket);
  const close = new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
  const hello = new Promise<Frame>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("managed hello timeout")),
      2_000,
    );
    const onData = (chunk: Buffer) => {
      for (const item of decoder.push(chunk)) {
        if (!item.ok) continue;
        if (item.value.type === "hello_result") {
          clearTimeout(timer);
          resolve(item.value);
        } else if (item.value.type === "server_request")
          onServer?.(item.value, socket);
      }
    };
    socket.on("data", onData);
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.off("data", onData);
      reject(error);
    });
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
      sessionKey: paths.sessionKey!,
      auth: {
        kind: "agent_token",
        token,
        agentId,
        generation: 1,
        piSessionId: session,
      },
    }),
  );
  return { socket, hello: await hello, close };
}

function resultOf(frame: Frame): any {
  assert.equal(frame.ok, true, JSON.stringify(frame.error));
  return frame.result;
}
async function bounded<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 2_000,
): Promise<T> {
  let timer!: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("broker domain wire persists correlated result, question, workflow, and replay across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "domain-wire-"));
  const runtime = await mkdtemp(join(tmpdir(), "domain-wire-runtime-"));
  const paths = {
    sessionKey: sessionKey(join(runtime, "broker.sock")),
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
    void workflow;
    const manualTask = resultOf(
      await request(socket, "task.create_m3", {
        title: "manual question task",
        objective: "manual question task",
      }),
    );
    const taskId = manualTask.taskId;
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
    sessionKey: sessionKey(join(runtime, "broker.sock")),
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
    void workflow;
    const manualTask = resultOf(
      await request(socket, "task.create_m3", {
        title: "manual question task",
        objective: "manual question task",
      }),
    );
    const taskId = manualTask.taskId;
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
    void workflowExpired;
    const manualExpiredTask = resultOf(
      await request(socket, "task.create_m3", {
        title: "manual expired question task",
        objective: "manual expired question task",
      }),
    );
    const runExpired = resultOf(
      await request(socket, "run.create", {
        taskId: manualExpiredTask.taskId,
        agentId: registeredExpired.agentId,
        assignmentGeneration: 1,
      }),
    );
    const openedExpired = resultOf(
      await request(socket, "question.open", {
        agentId: registeredExpired.agentId,
        taskId: manualExpiredTask.taskId,
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
    sessionKey: sessionKey(join(runtime, "broker.sock")),
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
    void workflow;
    const manualTask = resultOf(
      await request(socket, "task.create_m3", {
        title: "manual question task",
        objective: "manual question task",
      }),
    );
    const taskId = manualTask.taskId;
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
    sessionKey: sessionKey(join(runtime, "broker.sock")),
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
    void workflow;
    const manualTask = resultOf(
      await request(socket, "task.create_m3", {
        title: "manual question task",
        objective: "manual question task",
      }),
    );
    const taskId = manualTask.taskId;
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

test("production A to B queue races do not resurrect or provision cancelled work", async () => {
  for (const order of [
    "cancel-first",
    "advance-first",
    "deadline-first",
    "deadline-advance-first",
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), `domain-ab-${order}-`));
    const runtime = await mkdtemp(
      join(tmpdir(), `domain-ab-${order}-runtime-`),
    );
    const paths = {
      sessionKey: sessionKey(join(runtime, "broker.sock")),
      root,
      runtime,
      events: join(root, "events.jsonl"),
      snapshot: join(root, "snapshot.json"),
      lock: join(runtime, "lock"),
      socket: join(runtime, "broker.sock"),
      secret: join(runtime, "secret"),
    };
    let herdr!: DomainHerdr;
    const timers = new DeterministicTimers();
    const broker = new Broker(paths, {
      now: () => timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      herdrFactory: async (store) => (herdr = new DomainHerdr(store)) as any,
    });
    await broker.start();
    let parent: Socket | undefined;
    let childA: Socket | undefined;
    let childB: Socket | undefined;
    let removeEvents = () => {};
    try {
      const secret = (await readFile(paths.secret, "utf8")).trim();
      parent = await connect(paths, secret);
      const adopted = resultOf(
        await request(parent, "agent.register_adopted", {
          adapterVersion: "0.1.0",
          herdr: {
            paneId: "ab-root",
            terminalId: "ab-root",
            detectedKind: "pi",
            name: "ab-root",
          },
          pi: {
            sessionId: "ab-root",
            sessionName: "ab-root",
            capabilities: {},
            state: {},
          },
        }),
      );
      const workflow = resultOf(
        await request(parent, "delegate.execute", {
          mode: "chain",
          title: "A to B",
          parentAgentId: adopted.agentId,
          steps: [
            {
              key: "a",
              profileId: "scout",
              title: "A",
              objective: "A",
              dependsOn: [],
            },
            {
              key: "b",
              profileId: "scout",
              title: "B",
              objective: "B",
              dependsOn: ["a"],
            },
          ],
          wait: false,
          waitUntil: [],
          timeoutMs: 60_000,
          failureMode: "collect_all",
          dryRun: false,
        }),
      );
      const taskA = workflow.tasks.find((item: any) => item.key === "a").taskId;
      const taskB = workflow.tasks.find((item: any) => item.key === "b").taskId;
      const runAId = broker.store.state.tasks[taskA]!.currentRunId!;
      const runA = broker.store.state.runs[runAId]!;
      childA = await connectManaged(
        paths,
        herdr.tokens.get(runA.agentId!)!,
        runA.agentId!,
        "ab-a",
        (frame, socket) => {
          socket.write(
            encodeFrame({
              v: 1,
              type: "server_response",
              id: frame.id,
              ok: true,
              result:
                frame.method === "control.abort"
                  ? { ok: true }
                  : { status: "accepted" },
            }),
          );
        },
      );
      let resolveAssignmentA!: () => void;
      const assignmentAcceptedA = new Promise<void>(
        (resolve) => (resolveAssignmentA = resolve),
      );
      const removeAssignmentA = broker.store.onAppend((event) => {
        if (
          event.type === "assignment.accepted" &&
          event.entityRefs?.runId === runAId
        )
          resolveAssignmentA();
      });
      resultOf(
        await request(childA, "agent.register_managed", {
          agentId: runA.agentId,
          generation: 1,
          adapterVersion: "0.1.0",
          herdr: {
            paneId: "ab-a",
            terminalId: "ab-a",
            detectedKind: "pi",
            name: "ab-a",
          },
          pi: {
            sessionId: "ab-a",
            sessionName: "ab-a",
            capabilities: {},
            state: {},
          },
        }),
      );
      await bounded(assignmentAcceptedA, "A assignment acceptance timeout");
      removeAssignmentA();
      const events: any[] = [];
      let resolveBRun!: () => void;
      const bRun = new Promise<void>((resolve) => (resolveBRun = resolve));
      let resolveBCancel!: () => void;
      const bCancel = new Promise<void>(
        (resolve) => (resolveBCancel = resolve),
      );
      let resolveBTimeout!: () => void;
      const bTimeout = new Promise<void>(
        (resolve) => (resolveBTimeout = resolve),
      );
      let resolveBProvision!: (input: any) => void;
      const bProvision = new Promise<any>(
        (resolve) => (resolveBProvision = resolve),
      );
      let resolveBAssignmentAccepted!: () => void;
      const bAssignmentAccepted = new Promise<void>(
        (resolve) => (resolveBAssignmentAccepted = resolve),
      );
      let resolveBOutcome!: () => void;
      const bOutcome = new Promise<void>(
        (resolve) => (resolveBOutcome = resolve),
      );
      let bRunCreated = 0;
      let bCancelRequested = 0;
      let bRunTimedOut = 0;
      let bTaskTimedOut = 0;
      let bAbortCount = 0;
      removeEvents = broker.store.onAppend((event) => {
        events.push(event);
        if (event.type === "run.created" && event.entityRefs?.taskId === taskB)
          bRunCreated++;
        if (
          event.type === "task.cancel_requested" &&
          event.entityRefs?.taskId === taskB
        )
          bCancelRequested++;
        if (
          event.type === "run.state_changed" &&
          event.entityRefs?.taskId === taskB &&
          (event.payload as any)?.state === "timed_out"
        )
          bRunTimedOut++;
        if (
          event.type === "task.state_changed" &&
          event.entityRefs?.taskId === taskB &&
          (event.payload as any)?.to === "timed_out"
        )
          bTaskTimedOut++;
        if (event.type === "run.created" && event.entityRefs?.taskId === taskB)
          resolveBRun();
        if (
          event.type === "task.cancel_requested" &&
          event.entityRefs?.taskId === taskB
        )
          resolveBCancel();
        if (
          event.type === "assignment.accepted" &&
          event.entityRefs?.taskId === taskB
        )
          resolveBAssignmentAccepted();
        if (
          (event.type === "run.state_changed" ||
            event.type === "task.state_changed") &&
          event.entityRefs?.taskId === taskB &&
          ((event.payload as any)?.state === "timed_out" ||
            (event.payload as any)?.to === "timed_out")
        )
          resolveBTimeout();
        if (
          event.type === "herdr.provision.outcome" &&
          event.entityRefs?.agentId !== runA.agentId &&
          (event.payload as any)?.state === "pending"
        )
          resolveBOutcome();
      });
      herdr.onProvision = (input) => {
        if (input.agentId !== runA.agentId) resolveBProvision(input);
      };
      const startA = () => {
        const live = broker.store.state.agents[runA.agentId!]!;
        return request(childA!, "agent.lifecycle_event", {
          agentId: runA.agentId,
          connectionGeneration: live.connectionGeneration,
          adapterSeq: 2,
          event: "turn_start",
          piSessionId: live.piSessionId,
          turnIndex: 1,
          agentCycleId: "ab-cycle",
          assignment: { assignmentId: runA.assignmentId, generation: 1 },
          safeData: { toolName: null, contextPercent: 0 },
        });
      };
      const settleA = () => {
        const live = broker.store.state.agents[runA.agentId!]!;
        return request(childA!, "agent.lifecycle_event", {
          agentId: runA.agentId,
          connectionGeneration: live.connectionGeneration,
          adapterSeq: 3,
          event: "agent_settled",
          piSessionId: live.piSessionId,
          turnIndex: 1,
          agentCycleId: "ab-cycle",
          assignment: { assignmentId: runA.assignmentId, generation: 1 },
          safeData: { toolName: null, contextPercent: 0 },
        });
      };
      resultOf(await startA());
      if (order === "cancel-first") {
        resultOf(
          await request(parent, "task.cancel", {
            taskId: taskB,
            reason: "cancel_b",
            cascade: true,
          }),
        );
        await bounded(bCancel, "B cancellation event timeout");
        resultOf(await settleA());
        resultOf(
          await request(childA, "result.publish", {
            agentId: runA.agentId,
            taskId: taskA,
            runId: runA.id,
            assignmentGeneration: 1,
            result: body,
          }),
        );
        assert.equal(herdr.provisions.length, 1);
        assert.equal(broker.store.state.tasks[taskB]?.state, "cancelled");
        assert.equal(broker.store.state.tasks[taskB]?.currentRunId, undefined);
        assert.equal(bCancelRequested, 1);
        assert.equal(bRunCreated, 0);
        assert.equal(bRunTimedOut, 0);
        assert.equal(bTaskTimedOut, 0);
        assert.equal(bAbortCount, 0);
      } else if (order === "deadline-first") {
        resultOf(await settleA());
        let removeDeadlineHook = () => {};
        removeDeadlineHook = broker.store.onAppend((event) => {
          if (
            event.type === "run.state_changed" &&
            event.entityRefs?.runId === runAId &&
            event.entityRefs?.taskId === taskA &&
            (event.payload as any)?.state === "succeeded"
          ) {
            timers.advance(
              Date.parse(broker.store.state.tasks[taskB]!.timeoutAt!),
            );
            removeDeadlineHook();
          }
        });
        resultOf(
          await request(childA, "result.publish", {
            agentId: runA.agentId,
            taskId: taskA,
            runId: runA.id,
            assignmentGeneration: 1,
            result: body,
          }),
        );
        removeDeadlineHook();
        await bounded(bTimeout, "B timeout event timeout");
        assert.equal(herdr.provisions.length, 1);
        assert.equal(broker.store.state.tasks[taskB]?.state, "timed_out");
        assert.equal(broker.store.state.tasks[taskB]?.currentRunId, undefined);
        assert.equal(bCancelRequested, 0);
        assert.equal(bRunCreated, 0);
        assert.equal(bRunTimedOut, 0);
        assert.equal(bTaskTimedOut, 1);
        assert.equal(bAbortCount, 0);
      } else {
        resultOf(await settleA());
        resultOf(
          await request(childA, "result.publish", {
            agentId: runA.agentId,
            taskId: taskA,
            runId: runA.id,
            assignmentGeneration: 1,
            result: body,
          }),
        );
        await bounded(bRun, "B run creation event timeout");
        const runBId = broker.store.state.tasks[taskB]!.currentRunId!;
        const runB = broker.store.state.runs[runBId]!;
        const agentB = broker.store.state.agents[runB.agentId!]!;
        let resolveAbortResponseProcessed!: () => void;
        const abortResponseProcessed = new Promise<void>(
          (resolve) => (resolveAbortResponseProcessed = resolve),
        );
        const provision = await bounded(
          bProvision,
          "B provision event timeout",
        );
        await bounded(bOutcome, "B provision outcome timeout");
        childB = await connectManaged(
          paths,
          herdr.tokens.get(provision.agentId)!,
          provision.agentId,
          "ab-b",
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
            assert.equal(frame.method, "control.abort");
            bAbortCount++;
            socket.write(
              encodeFrame({
                v: 1,
                type: "server_response",
                id: frame.id,
                ok: true,
                result: { ok: true },
              }),
            );
            void request(socket, "race.abort-response-processed", {}).then(
              (response) => {
                assert.equal(response.ok, false);
                assert.equal(response.error?.code, "NOT_FOUND");
                resolveAbortResponseProcessed();
              },
            );
          },
        );
        resultOf(
          await request(childB, "agent.register_managed", {
            agentId: provision.agentId,
            generation: agentB.generation,
            adapterVersion: "0.1.0",
            herdr: {
              paneId: "ab-b",
              terminalId: "ab-b",
              detectedKind: "pi",
              name: "ab-b",
            },
            pi: {
              sessionId: "ab-b",
              sessionName: "ab-b",
              capabilities: {},
              state: {},
            },
          }),
        );
        await bounded(bAssignmentAccepted, "B assignment acceptance timeout");
        if (order === "advance-first") {
          resultOf(
            await request(parent, "task.cancel", {
              taskId: taskB,
              reason: "cancel_b",
              cascade: true,
            }),
          );
          await bounded(bCancel, "B cancellation event timeout");
          await bounded(
            abortResponseProcessed,
            "B abort response processing timeout",
          );
          assert.equal(broker.store.state.tasks[taskB]?.currentRunId, runBId);
          assert.equal(broker.store.state.runs[runBId]?.state, "cancelled");
          assert.equal(bCancelRequested, 1);
          assert.equal(bRunCreated, 1);
          assert.equal(bAbortCount, 1);
        } else {
          timers.advance(
            Date.parse(broker.store.state.tasks[taskB]!.timeoutAt!),
          );
          await bounded(bTimeout, "B timeout event timeout");
          await bounded(
            abortResponseProcessed,
            "B abort response processing timeout",
          );
          assert.equal(broker.store.state.runs[runBId]?.state, "timed_out");
          assert.equal(bCancelRequested, 0);
          assert.equal(bRunCreated, 1);
          assert.equal(bRunTimedOut, 1);
          assert.equal(bTaskTimedOut, 0);
          assert.equal(bAbortCount, 1);
        }
        assert.deepEqual(herdr.stops, []);
      }
      assert.equal(
        events.filter(
          (event) =>
            event.type === "run.created" && event.entityRefs?.taskId === taskB,
        ).length,
        order === "cancel-first" || order === "deadline-first" ? 0 : 1,
      );
    } finally {
      removeEvents();
      childB?.destroy();
      childA?.destroy();
      parent?.destroy();
      await broker.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      await rm(runtime, { recursive: true, force: true });
    }
  }
});

test("production mutation queue orders cancel and run creation without resurrection", async () => {
  for (const order of ["cancel-first", "run-first"] as const) {
    const root = await mkdtemp(join(tmpdir(), `domain-queue-${order}-`));
    const runtime = await mkdtemp(
      join(tmpdir(), `domain-queue-${order}-runtime-`),
    );
    const paths = {
      sessionKey: sessionKey(join(runtime, "broker.sock")),
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
    let removeEvents = () => {};
    try {
      const secret = (await readFile(paths.secret, "utf8")).trim();
      parent = await connect(paths, secret);
      const parentRegistration = resultOf(
        await request(parent, "agent.register_adopted", {
          adapterVersion: "0.1.0",
          herdr: {
            paneId: "root-pane",
            terminalId: "root-terminal",
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
      const agentId = createId("agt");
      resultOf(
        await request(parent, "herdr.provision", {
          agentId,
          parentAgentId: parentRegistration.agentId,
          role: "worker",
          workspaceId: "workspace",
          cwd: "/fake",
          profileId: "scout",
          isolation: "shared-readonly",
          prompt: "queue test",
          projectBase: "/fake",
          branch: "main",
          env: {},
        }),
      );
      const token = herdr.tokens.get(agentId)!;
      let abortCount = 0;
      let abortParams: Record<string, unknown> | undefined;
      let resolveAbortReceived!: () => void;
      const abortReceived = new Promise<void>((resolve) => {
        resolveAbortReceived = resolve;
      });
      let releaseAbort!: () => void;
      const releaseAbortPromise = new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
      let resolveAbortResponseProcessed!: () => void;
      const abortResponseProcessed = new Promise<void>((resolve) => {
        resolveAbortResponseProcessed = resolve;
      });
      child = await connectManaged(
        paths,
        token,
        agentId,
        "queue-child",
        (frame, socket) => {
          assert.equal(frame.method, "control.abort");
          abortCount++;
          abortParams = frame.params;
          resolveAbortReceived();
          void releaseAbortPromise.then(() => {
            socket.write(
              encodeFrame({
                v: 1,
                type: "server_response",
                id: frame.id,
                ok: true,
                result: { ok: true },
              }),
            );
            void request(socket, "queue.abort-response-processed", {}).then(
              (response) => {
                assert.equal(response.ok, false);
                assert.equal(response.error?.code, "NOT_FOUND");
                resolveAbortResponseProcessed();
              },
            );
          });
        },
      );
      const registration = resultOf(
        await request(child, "agent.register_managed", {
          agentId,
          generation: 1,
          adapterVersion: "0.1.0",
          herdr: {
            paneId: "queue-pane",
            terminalId: "queue-terminal",
            detectedKind: "pi",
            name: "queue-child",
          },
          pi: {
            sessionId: "queue-child",
            sessionName: "queue-child",
            capabilities: {},
            state: {},
          },
        }),
      );
      const task = resultOf(
        await request(parent, "task.create_m3", {
          title: `queue-${order}`,
          objective: "queue",
          parentAgentId: parentRegistration.agentId,
          timeoutAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      let cancelRequestedCount = 0;
      let runCreatedCount = 0;
      let resolveCancelRequested!: () => void;
      const cancelRequested = new Promise<void>((resolve) => {
        resolveCancelRequested = resolve;
      });
      let resolveRunCreated!: () => void;
      const runCreated = new Promise<void>((resolve) => {
        resolveRunCreated = resolve;
      });
      let resolveRunCancelled!: () => void;
      const runCancelled = new Promise<void>((resolve) => {
        resolveRunCancelled = resolve;
      });
      removeEvents = broker.store.onAppend((event) => {
        if (
          event.entityRefs?.taskId !== task.taskId &&
          event.entityRefs?.runId !==
            broker.store.state.tasks[task.taskId]?.currentRunId
        )
          return;
        if (event.type === "task.cancel_requested") {
          cancelRequestedCount++;
          resolveCancelRequested();
          resolveRunCancelled();
        }
        if (event.type === "run.created") {
          runCreatedCount++;
          resolveRunCreated();
        }
        if (
          event.type === "run.state_changed" &&
          (event.payload as Record<string, unknown>).state === "cancelled"
        )
          resolveRunCancelled();
      });
      const provisionCount = herdr.count;
      const runRequest = () =>
        request(parent!, "run.create", {
          taskId: task.taskId,
          agentId,
          assignmentGeneration: 1,
          piSessionId: "queue-child",
          terminalId: "queue-terminal",
        });
      const cancelRequest = () =>
        request(parent!, "task.cancel", {
          taskId: task.taskId,
          reason: `queue_${order}`,
          cascade: true,
        });
      const first = order === "cancel-first" ? cancelRequest() : runRequest();
      const second = order === "cancel-first" ? runRequest() : cancelRequest();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      if (order === "cancel-first") {
        assert.equal(firstResult.ok, true, JSON.stringify(firstResult));
        assert.equal(secondResult.ok, false, JSON.stringify(secondResult));
        assert.equal(secondResult.error?.code, "INVALID_REQUEST");
        await bounded(cancelRequested, "cancel event timeout");
        assert.equal(Object.keys(broker.store.state.runs).length, 0);
        assert.equal(broker.store.state.tasks[task.taskId]?.state, "cancelled");
        assert.equal(cancelRequestedCount, 1);
        assert.equal(runCreatedCount, 0);
      } else {
        assert.equal(firstResult.ok, true, JSON.stringify(firstResult));
        assert.equal(secondResult.ok, true, JSON.stringify(secondResult));
        await bounded(runCreated, "run creation event timeout");
        await bounded(cancelRequested, "cancel event timeout");
        await bounded(abortReceived, "abort request timeout");
        assert.deepEqual(Object.keys(abortParams ?? {}).sort(), [
          "agentId",
          "connectionGeneration",
          "generation",
          "piSessionId",
        ]);
        assert.equal(abortParams?.agentId, agentId);
        assert.equal(abortParams?.generation, 1);
        assert.equal(
          abortParams?.connectionGeneration,
          registration.connectionGeneration,
        );
        assert.equal(abortParams?.piSessionId, "queue-child");
        releaseAbort();
        await bounded(
          abortResponseProcessed,
          "abort response processing timeout",
        );
        await bounded(runCancelled, "run cancellation event timeout");
        assert.equal(Object.keys(broker.store.state.runs).length, 1);
        assert.equal(
          broker.store.state.runs[Object.keys(broker.store.state.runs)[0]!]!
            .state,
          "cancelled",
        );
        assert.equal(broker.store.state.tasks[task.taskId]?.state, "cancelled");
        assert.equal(abortCount, 1);
        assert.equal(cancelRequestedCount, 1);
        assert.equal(runCreatedCount, 1);
      }
      assert.equal(herdr.count, provisionCount);
      assert.deepEqual(herdr.stops, []);
    } finally {
      removeEvents();
      child?.destroy();
      parent?.destroy();
      await broker.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      await rm(runtime, { recursive: true, force: true });
    }
  }
});

test("production managed identity rejects duplicate hello and reconnects exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "domain-managed-identity-"));
  const runtime = await mkdtemp(
    join(tmpdir(), "domain-managed-identity-runtime-"),
  );
  const paths = {
    sessionKey: sessionKey(join(runtime, "broker.sock")),
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
  let first: Socket | undefined;
  let duplicate: Socket | undefined;
  let reconnect: Socket | undefined;
  let removeEvents = () => {};
  try {
    const secret = (await readFile(paths.secret, "utf8")).trim();
    parent = await connect(paths, secret);
    const parentRegistration = resultOf(
      await request(parent, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "root-pane",
          terminalId: "root-terminal",
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
        title: "managed identity",
        steps: [
          {
            key: "one",
            profileId: "scout",
            title: "One",
            objective: "identity",
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
    const token = herdr.tokens.get(item.agentId)!;
    let firstAssignmentCount = 0;
    let reconnectAssignmentCount = 0;
    let resolveFirstAssignment!: () => void;
    const firstAssignment = new Promise<void>((resolve) => {
      resolveFirstAssignment = resolve;
    });
    let resolveReconnectAssignment!: () => void;
    const reconnectAssignment = new Promise<void>((resolve) => {
      resolveReconnectAssignment = resolve;
    });
    let resolveAssignmentAccepted!: () => void;
    const assignmentAccepted = new Promise<void>((resolve) => {
      resolveAssignmentAccepted = resolve;
    });
    removeEvents = broker.store.onAppend((event) => {
      if (
        event.type === "assignment.accepted" &&
        event.entityRefs?.runId === item.runId
      )
        resolveAssignmentAccepted();
    });
    first = await connectManaged(
      paths,
      token,
      item.agentId,
      "managed-identity",
      (frame) => {
        assert.equal(frame.method, "assignment.deliver");
        firstAssignmentCount++;
        resolveFirstAssignment();
      },
    );
    const firstRegistration = resultOf(
      await request(first!, "agent.register_managed", {
        agentId: item.agentId,
        generation: 1,
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "managed-pane",
          terminalId: "managed-terminal",
          detectedKind: "pi",
          name: "managed-identity",
        },
        pi: {
          sessionId: "managed-identity",
          sessionName: "managed-identity",
          capabilities: {},
          state: {},
        },
      }),
    );
    await bounded(firstAssignment, "first assignment timeout");
    assert.ok(firstRegistration.connectionGeneration >= 1);
    let duplicateAssignmentCount = 0;
    const duplicateResult = await connectManagedHello(
      paths,
      token,
      item.agentId,
      "managed-identity",
      (frame, socket) => {
        if (frame.method === "assignment.deliver") duplicateAssignmentCount++;
        socket.write(
          encodeFrame({
            v: 1,
            type: "server_response",
            id: frame.id,
            ok: true,
            result: { status: "accepted" },
          }),
        );
      },
    );
    duplicate = duplicateResult.socket;
    const duplicateHello = duplicateResult.hello;
    assert.equal(duplicateHello.ok, false);
    assert.equal(duplicateHello.error?.code, "AUTH_FAILED");
    await bounded(duplicateResult.close, "duplicate socket close timeout");
    assert.equal(duplicateAssignmentCount, 0);
    const firstClose = new Promise<void>((resolve) => {
      first!.once("close", () => resolve());
    });
    first!.destroy();
    await bounded(firstClose, "first socket close timeout");
    reconnect = await connectManaged(
      paths,
      token,
      item.agentId,
      "managed-identity",
      (frame, socket) => {
        assert.equal(frame.method, "assignment.deliver");
        reconnectAssignmentCount++;
        socket.write(
          encodeFrame({
            v: 1,
            type: "server_response",
            id: frame.id,
            ok: true,
            result: { status: "accepted" },
          }),
        );
        resolveReconnectAssignment();
      },
    );
    const reconnectRegistration = resultOf(
      await request(reconnect, "agent.register_managed", {
        agentId: item.agentId,
        generation: 1,
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "managed-pane",
          terminalId: "managed-terminal",
          detectedKind: "pi",
          name: "managed-identity",
        },
        pi: {
          sessionId: "managed-identity",
          sessionName: "managed-identity",
          capabilities: {},
          state: {},
        },
      }),
    );
    await bounded(reconnectAssignment, "reconnect assignment timeout");
    await bounded(assignmentAccepted, "reconnect acceptance timeout");
    assert.equal(
      reconnectRegistration.connectionGeneration,
      firstRegistration.connectionGeneration + 1,
    );
    assert.equal(firstAssignmentCount, 1);
    assert.equal(reconnectAssignmentCount, 1);
    assert.equal(
      broker.store.state.runs[item.runId]?.assignmentDeliveryState,
      "accepted",
    );
    assert.equal(herdr.stops.length, 0);
  } finally {
    removeEvents();
    duplicate?.destroy();
    first?.destroy();
    reconnect?.destroy();
    parent?.destroy();
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
    sessionKey: sessionKey(join(runtime, "broker.sock")),
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
  let removeAssignmentListener = () => {};
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
    let aborts = 0;
    let resolveAbort!: () => void;
    const abortSeen = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const delivery = new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    });
    let resolveAssignmentAccepted!: () => void;
    const assignmentAccepted = new Promise<void>((resolve) => {
      resolveAssignmentAccepted = resolve;
    });
    removeAssignmentListener = broker.store.onAppend((event) => {
      if (
        event.type === "assignment.accepted" &&
        event.entityRefs?.runId === item.runId
      )
        resolveAssignmentAccepted();
    });
    child = await connectManaged(
      paths,
      herdr.tokens.get(item.agentId)!,
      item.agentId,
      "strict-child",
      (frame, socket) => {
        if (frame.method === "control.abort") {
          aborts++;
          resolveAbort();
          assert.deepEqual(
            Object.keys(frame.params).sort(),
            [
              "agentId",
              "connectionGeneration",
              "generation",
              "piSessionId",
            ].sort(),
          );
          assert.equal(frame.params.agentId, item.agentId);
          assert.equal(frame.params.generation, 1);
          assert.equal(frame.params.piSessionId, "strict-child");
          assert.equal(frame.params.runId, undefined);
          assert.equal(frame.params.expected, undefined);
          socket.write(
            encodeFrame({
              v: 1,
              type: "server_response",
              id: frame.id,
              ok: true,
              result: { ok: true },
            }),
          );
          return;
        }
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
    await bounded(assignmentAccepted, "assignment acceptance timeout");
    removeAssignmentListener();
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
    await bounded(delivery, "delivery timeout");
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
    await bounded(abortSeen, "abort timeout");
    assert.equal(deliveredStates.length, 1);
    assert.equal(aborts, 1);
    const repeatedCancel = resultOf(
      await request(parent, "task.cancel", {
        taskId: item.taskId,
        reason: "repeat_after_terminal",
        cascade: true,
      }),
    );
    assert.deepEqual(Object.keys(repeatedCancel).sort(), ["state", "taskId"]);
    assert.deepEqual(repeatedCancel, {
      taskId: item.taskId,
      state: broker.store.state.tasks[item.taskId]!.state,
    });
    assert.equal(herdr.interrupts.length, 0);
    assert.equal(herdr.stops.length, 0);
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
    removeAssignmentListener();
    child?.destroy();
    parent?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production settled managed run times out without adapter abort", async () => {
  const root = await mkdtemp(join(tmpdir(), "domain-settled-timeout-"));
  const runtime = await mkdtemp(
    join(tmpdir(), "domain-settled-timeout-runtime-"),
  );
  const paths = {
    sessionKey: sessionKey(join(runtime, "broker.sock")),
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
  let removeEvents = () => {};
  try {
    const secret = (await readFile(paths.secret, "utf8")).trim();
    parent = await connect(paths, secret);
    const parentRegistration = resultOf(
      await request(parent, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "root-pane",
          terminalId: "root-terminal",
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
        title: "settled timeout",
        steps: [
          {
            key: "one",
            profileId: "scout",
            title: "One",
            objective: "settle without result",
            dependsOn: [],
          },
        ],
        wait: false,
        waitUntil: [],
        timeoutMs: 2_000,
        failureMode: "collect_all",
        dryRun: false,
      }),
    );
    const item = delegated.tasks[0];
    const token = herdr.tokens.get(item.agentId)!;
    let resolveAssignmentAccepted!: () => void;
    const assignmentAccepted = new Promise<void>((resolve) => {
      resolveAssignmentAccepted = resolve;
    });
    let resolvePiStarted!: () => void;
    const piStarted = new Promise<void>((resolve) => {
      resolvePiStarted = resolve;
    });
    let resolvePiSettled!: () => void;
    const piSettled = new Promise<void>((resolve) => {
      resolvePiSettled = resolve;
    });
    let resolveRunTimedOut!: () => void;
    const runTimedOut = new Promise<void>((resolve) => {
      resolveRunTimedOut = resolve;
    });
    removeEvents = broker.store.onAppend((event) => {
      if (event.entityRefs?.runId !== item.runId) return;
      if (event.type === "assignment.accepted") resolveAssignmentAccepted();
      if (event.type === "run.pi_started") resolvePiStarted();
      if (event.type === "run.pi_settled") resolvePiSettled();
      if (
        event.type === "run.state_changed" &&
        (event.payload as Record<string, unknown>).state === "timed_out"
      )
        resolveRunTimedOut();
    });
    let abortCount = 0;
    child = await connectManaged(
      paths,
      token,
      item.agentId,
      "settled-timeout",
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
        if (frame.method === "control.abort") {
          abortCount++;
          socket.write(
            encodeFrame({
              v: 1,
              type: "server_response",
              id: frame.id,
              ok: true,
              result: { ok: true },
            }),
          );
          return;
        }
        throw new Error(`unexpected adapter request ${frame.method}`);
      },
    );
    const registration = resultOf(
      await request(child, "agent.register_managed", {
        agentId: item.agentId,
        generation: 1,
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "settled-pane",
          terminalId: "settled-terminal",
          detectedKind: "pi",
          name: "settled-timeout",
        },
        pi: {
          sessionId: "settled-timeout",
          sessionName: "settled-timeout",
          capabilities: {},
          state: {},
        },
      }),
    );
    await bounded(assignmentAccepted, "settled assignment acceptance timeout");
    const run = broker.store.state.runs[item.runId]!;
    resultOf(
      await request(child, "agent.lifecycle_event", {
        agentId: item.agentId,
        connectionGeneration: registration.connectionGeneration,
        adapterSeq: 1,
        event: "turn_start",
        piSessionId: "settled-timeout",
        turnIndex: 1,
        agentCycleId: "settled-cycle",
        assignment: {
          assignmentId: run.assignmentId,
          generation: run.assignmentGeneration,
        },
        safeData: { toolName: null, contextPercent: 0 },
      }),
    );
    await bounded(piStarted, "run.pi_started timeout");
    resultOf(
      await request(child, "agent.lifecycle_event", {
        agentId: item.agentId,
        connectionGeneration: registration.connectionGeneration,
        adapterSeq: 2,
        event: "agent_settled",
        piSessionId: "settled-timeout",
        turnIndex: 1,
        agentCycleId: "settled-cycle",
        assignment: {
          assignmentId: run.assignmentId,
          generation: run.assignmentGeneration,
        },
        safeData: { toolName: null, contextPercent: 0 },
      }),
    );
    await bounded(piSettled, "run.pi_settled timeout");
    assert.equal(broker.store.state.runs[item.runId]?.state, "settled");
    await bounded(runTimedOut, "settled wall timeout event timeout", 5_000);
    assert.deepEqual(broker.store.state.runs[item.runId]?.terminalReason, {
      code: "TIMEOUT",
      message: "The task wall deadline expired.",
    });
    assert.deepEqual(broker.store.state.tasks[item.taskId]?.terminalReason, {
      code: "TIMEOUT",
      message: "The task wall deadline expired.",
    });
    assert.equal(broker.store.state.runs[item.runId]?.state, "timed_out");
    assert.equal(broker.store.state.tasks[item.taskId]?.state, "timed_out");
    assert.equal(abortCount, 0);
    assert.deepEqual(herdr.stops, []);
  } finally {
    removeEvents();
    child?.destroy();
    parent?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production strict child receives durable task wall-deadline delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "domain-cancel-delivery-"));
  const runtime = await mkdtemp(
    join(tmpdir(), "domain-cancel-delivery-runtime-"),
  );
  const paths = {
    sessionKey: sessionKey(join(runtime, "broker.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
  let herdr!: DomainHerdr;
  let clock = Date.now();
  let removeAssignmentListener = () => {};
  const timers: Array<() => void> = [];
  const broker = new Broker(paths, {
    now: () => clock,
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
    const delivery = new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    });
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let resolveAssignmentAccepted!: () => void;
    const assignmentAccepted = new Promise<void>((resolve) => {
      resolveAssignmentAccepted = resolve;
    });
    removeAssignmentListener = broker.store.onAppend((event) => {
      if (
        event.type === "assignment.accepted" &&
        event.entityRefs?.runId === item.runId
      )
        resolveAssignmentAccepted();
    });
    let resolveAbort!: () => void;
    const abortSeen = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    child = await connectManaged(
      paths,
      herdr.tokens.get(item.agentId)!,
      item.agentId,
      "strict-child",
      (frame, socket) => {
        if (frame.method === "control.abort") {
          resolveAbort();
          assert.deepEqual(
            Object.keys(frame.params).sort(),
            [
              "agentId",
              "connectionGeneration",
              "generation",
              "piSessionId",
            ].sort(),
          );
          assert.equal(frame.params.agentId, item.agentId);
          assert.equal(frame.params.generation, 1);
          assert.equal(frame.params.piSessionId, "strict-child");
          assert.equal(frame.params.runId, undefined);
          assert.equal(frame.params.expected, undefined);
          socket.write(
            encodeFrame({
              v: 1,
              type: "server_response",
              id: frame.id,
              ok: true,
              result: { ok: true },
            }),
          );
          return;
        }
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
        assert.equal(frame.params.state, "cancelled");
        assert.equal(frame.params.expected.assignmentGeneration, 1);
        assert.equal(frame.params.expected.runId, item.runId);
        assert.equal(
          broker.store.state.questions?.[frame.params.questionId]?.state,
          "cancelled",
        );
        assert.equal(broker.store.state.runs[item.runId]?.state, "timed_out");
        assert.equal(broker.store.state.tasks[item.taskId]?.state, "timed_out");
        void deliveryGate.then(() => {
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
        });
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
    await bounded(assignmentAccepted, "assignment acceptance timeout");
    removeAssignmentListener();
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
    assert.ok(broker.store.state.tasks[item.taskId]?.timeoutAt);
    assert.equal(broker.store.state.agents[item.agentId]?.terminalId, "term-1");
    assert.equal(timers.length >= 2, true);
    clock = Date.parse(broker.store.state.tasks[item.taskId]!.timeoutAt!);
    timers[0]!();
    await bounded(abortSeen, "abort timeout");
    releaseDelivery();
    await bounded(delivery, "delivery timeout");
    assert.deepEqual(herdr.stops, []);
    assert.equal(
      Object.values(broker.store.state.questions ?? {}).filter(
        (q) =>
          q.runId === item.runId &&
          ["answered", "cancelled", "timed_out"].includes(q.state),
      ).length,
      1,
    );
    assert.ok(broker.store.state.lastEventSeq > terminalBefore);
    const terminalRun = { ...broker.store.state.runs[item.runId]! };
    const terminalTask = { ...broker.store.state.tasks[item.taskId]! };
    const terminalSeq = broker.store.state.lastEventSeq;
    const lateTurn = await request(child, "agent.lifecycle_event", {
      agentId: item.agentId,
      connectionGeneration: registered.connectionGeneration,
      adapterSeq: 2,
      event: "turn_start",
      piSessionId: "strict-child",
      turnIndex: 2,
      agentCycleId: "late-cycle",
      assignment: {
        assignmentId: run.assignmentId,
        generation: run.assignmentGeneration,
      },
      safeData: { toolName: null, contextPercent: 0 },
    });
    assert.equal(lateTurn.ok, false);
    assert.equal(lateTurn.error?.code, "RUN_MISMATCH");
    const lateSettled = await request(child, "agent.lifecycle_event", {
      agentId: item.agentId,
      connectionGeneration: registered.connectionGeneration,
      adapterSeq: 3,
      event: "agent_settled",
      piSessionId: "strict-child",
      turnIndex: 2,
      agentCycleId: "late-cycle",
      assignment: {
        assignmentId: run.assignmentId,
        generation: run.assignmentGeneration,
      },
      safeData: { toolName: null, contextPercent: 0 },
    });
    assert.equal(lateSettled.ok, false);
    assert.equal(lateSettled.error?.code, "RUN_MISMATCH");
    const lateResult = await request(child, "result.publish", {
      agentId: item.agentId,
      taskId: item.taskId,
      runId: item.runId,
      assignmentGeneration: run.assignmentGeneration,
      result: { ...body, summary: "late" },
    });
    assert.equal(lateResult.ok, false);
    assert.equal(lateResult.error?.code, "RUN_MISMATCH");
    assert.equal(broker.store.state.lastEventSeq, terminalSeq);
    assert.deepEqual(broker.store.state.runs[item.runId], terminalRun);
    assert.deepEqual(broker.store.state.tasks[item.taskId], terminalTask);
  } finally {
    removeAssignmentListener();
    child?.destroy();
    parent?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production managed socket accepts abort without a current Herdr resource", async () => {
  for (const resourceCase of ["absent", "stale"] as const) {
    const root = await mkdtemp(join(tmpdir(), `domain-abort-${resourceCase}-`));
    const runtime = await mkdtemp(
      join(tmpdir(), `domain-abort-${resourceCase}-runtime-`),
    );
    const paths = {
      sessionKey: sessionKey(join(runtime, "broker.sock")),
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
    let removeAssignmentListener = () => {};
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
          title: `abort-${resourceCase}`,
          steps: [
            {
              key: "one",
              profileId: "scout",
              title: "One",
              objective: "abort",
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
      let registeredConnectionGeneration!: number;
      let resolveAssignmentAccepted!: () => void;
      const assignmentAccepted = new Promise<void>((resolve) => {
        resolveAssignmentAccepted = resolve;
      });
      removeAssignmentListener = broker.store.onAppend((event) => {
        if (
          event.type === "assignment.accepted" &&
          event.entityRefs?.runId === item.runId
        )
          resolveAssignmentAccepted();
      });
      let abortAttempts = 0;
      let resolveAbortReceived!: () => void;
      const abortReceived = new Promise<void>((resolve) => {
        resolveAbortReceived = resolve;
      });
      child = await connectManaged(
        paths,
        herdr.tokens.get(item.agentId)!,
        item.agentId,
        "abort-child",
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
          assert.equal(frame.method, "control.abort");
          abortAttempts++;
          assert.deepEqual(Object.keys(frame.params).sort(), [
            "agentId",
            "connectionGeneration",
            "generation",
            "piSessionId",
          ]);
          assert.equal(frame.params.agentId, item.agentId);
          assert.equal(frame.params.generation, 1);
          assert.equal(
            frame.params.connectionGeneration,
            registeredConnectionGeneration,
          );
          assert.equal(frame.params.piSessionId, "abort-child");
          assert.equal(frame.params.runId, undefined);
          assert.equal(frame.params.expected, undefined);
          socket.write(
            encodeFrame({
              v: 1,
              type: "server_response",
              id: frame.id,
              ok: true,
              result: { ok: true },
            }),
          );
          resolveAbortReceived();
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
            name: "abort-child",
          },
          pi: {
            sessionId: "abort-child",
            sessionName: "abort-child",
            capabilities: {},
            state: {},
          },
        }),
      );
      registeredConnectionGeneration = registered.connectionGeneration;
      const run = broker.store.state.runs[item.runId]!;
      await bounded(assignmentAccepted, "assignment acceptance timeout");
      removeAssignmentListener();
      resultOf(
        await request(child, "agent.lifecycle_event", {
          agentId: item.agentId,
          connectionGeneration: registered.connectionGeneration,
          adapterSeq: 1,
          event: "turn_start",
          piSessionId: "abort-child",
          turnIndex: 1,
          agentCycleId: `abort-${resourceCase}`,
          assignment: {
            assignmentId: run.assignmentId,
            generation: run.assignmentGeneration,
          },
          safeData: { toolName: null, contextPercent: 0 },
        }),
      );
      const resource = broker.store.state.herdrResources?.[item.agentId];
      assert.ok(resource);
      if (resourceCase === "absent") {
        const resources = broker.store.state.herdrResources;
        assert.ok(resources);
        delete resources[item.agentId];
      } else {
        resource.paneId = "stale-pane";
      }
      const cancelResponse = request(parent, "task.cancel", {
        taskId: item.taskId,
        reason: `test_${resourceCase}`,
        cascade: true,
      });
      assert.deepEqual(
        resultOf(await bounded(cancelResponse, "task cancellation timeout")),
        { taskId: item.taskId, state: "cancelled" },
      );
      await bounded(abortReceived, "adapter abort timeout");
      assert.equal(abortAttempts, 1);
      assert.equal(herdr.stops.length, 0);
      assert.equal(broker.store.state.tasks[item.taskId]?.state, "cancelled");
      assert.equal(broker.store.state.runs[item.runId]?.state, "cancelled");
    } finally {
      removeAssignmentListener();
      child?.destroy();
      parent?.destroy();
      await broker.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      await rm(runtime, { recursive: true, force: true });
    }
  }
});

test("production managed cancellation falls back to one exact Herdr stop", async () => {
  for (const failureMode of [
    "invalid-result",
    "rejected",
    "disconnect",
  ] as const) {
    const root = await mkdtemp(
      join(tmpdir(), `domain-abort-fallback-${failureMode}-`),
    );
    const runtime = await mkdtemp(
      join(tmpdir(), `domain-abort-fallback-${failureMode}-runtime-`),
    );
    const paths = {
      sessionKey: sessionKey(join(runtime, "broker.sock")),
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
    let removeAssignmentListener = () => {};
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
          title: `abort-fallback-${failureMode}`,
          steps: [
            {
              key: "one",
              profileId: "scout",
              title: "One",
              objective: "abort fallback",
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
      const agentBeforeConnection = broker.store.state.agents[item.agentId];
      assert.ok(agentBeforeConnection);
      let registeredConnectionGeneration!: number;
      let resolveAssignmentAccepted!: () => void;
      const assignmentAccepted = new Promise<void>((resolve) => {
        resolveAssignmentAccepted = resolve;
      });
      removeAssignmentListener = broker.store.onAppend((event) => {
        if (
          event.type === "assignment.accepted" &&
          event.entityRefs?.runId === item.runId
        )
          resolveAssignmentAccepted();
      });
      let abortAttempts = 0;
      let resolveAbortReceived!: () => void;
      const abortReceived = new Promise<void>((resolve) => {
        resolveAbortReceived = resolve;
      });
      child = await connectManaged(
        paths,
        herdr.tokens.get(item.agentId)!,
        item.agentId,
        "fallback-child",
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
          assert.equal(frame.method, "control.abort");
          abortAttempts++;
          assert.deepEqual(Object.keys(frame.params).sort(), [
            "agentId",
            "connectionGeneration",
            "generation",
            "piSessionId",
          ]);
          assert.equal(frame.params.agentId, item.agentId);
          assert.equal(frame.params.generation, 1);
          assert.equal(
            frame.params.connectionGeneration,
            registeredConnectionGeneration,
          );
          assert.equal(frame.params.piSessionId, "fallback-child");
          assert.equal(frame.params.runId, undefined);
          assert.equal(frame.params.expected, undefined);
          resolveAbortReceived();
          if (failureMode === "invalid-result") {
            socket.write(
              encodeFrame({
                v: 1,
                type: "server_response",
                id: frame.id,
                ok: true,
                result: { ok: true, extra: true },
              }),
            );
          } else if (failureMode === "rejected") {
            socket.write(
              encodeFrame({
                v: 1,
                type: "server_response",
                id: frame.id,
                ok: false,
                error: {
                  code: "PI_COMMAND_REJECTED",
                  message: "Adapter rejected abort.",
                  retryable: false,
                },
              }),
            );
          } else {
            socket.destroy();
          }
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
            name: "fallback-child",
          },
          pi: {
            sessionId: "fallback-child",
            sessionName: "fallback-child",
            capabilities: {},
            state: {},
          },
        }),
      );
      registeredConnectionGeneration = registered.connectionGeneration;
      const run = broker.store.state.runs[item.runId]!;
      await bounded(assignmentAccepted, "assignment acceptance timeout");
      removeAssignmentListener();
      resultOf(
        await request(child, "agent.lifecycle_event", {
          agentId: item.agentId,
          connectionGeneration: registered.connectionGeneration,
          adapterSeq: 1,
          event: "turn_start",
          piSessionId: "fallback-child",
          turnIndex: 1,
          agentCycleId: `fallback-${failureMode}`,
          assignment: {
            assignmentId: run.assignmentId,
            generation: run.assignmentGeneration,
          },
          safeData: { toolName: null, contextPercent: 0 },
        }),
      );
      const capturedResource =
        broker.store.state.herdrResources?.[item.agentId];
      assert.ok(capturedResource);
      const resourceBeforeCancel = structuredClone(capturedResource);
      const expectedStop = {
        paneId: "pane-1",
        terminalId: "term-1",
        sessionId: "fallback-child",
        generation: 1,
      };
      const cancelResponse = request(parent, "task.cancel", {
        taskId: item.taskId,
        reason: `test_${failureMode}`,
        cascade: true,
      });
      assert.deepEqual(
        resultOf(await bounded(cancelResponse, "task cancellation timeout")),
        { taskId: item.taskId, state: "cancelled" },
      );
      await bounded(abortReceived, "adapter abort timeout");
      await bounded(herdr.stopCompleted, "Herdr stop timeout");
      assert.equal(abortAttempts, 1);
      assert.deepEqual(
        broker.store.state.herdrResources?.[item.agentId],
        resourceBeforeCancel,
      );
      assert.deepEqual(herdr.stops, [expectedStop]);
      assert.equal(herdr.stops.length, 1);
      assert.deepEqual(
        broker.store.state.tasks[item.taskId]?.state,
        "cancelled",
      );
      assert.deepEqual(broker.store.state.runs[item.runId]?.state, "cancelled");
    } finally {
      removeAssignmentListener();
      child?.destroy();
      parent?.destroy();
      await broker.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      await rm(runtime, { recursive: true, force: true });
    }
  }
});

test("held adapter abort skips stop after replacement or resource-byte mutation", async () => {
  for (const heldCase of ["replacement", "resource-bytes"] as const) {
    const root = await mkdtemp(
      join(tmpdir(), `domain-held-abort-${heldCase}-`),
    );
    const runtime = await mkdtemp(
      join(tmpdir(), `domain-held-abort-${heldCase}-runtime-`),
    );
    const paths = {
      sessionKey: sessionKey(join(runtime, "broker.sock")),
      root,
      runtime,
      events: join(root, "events.jsonl"),
      snapshot: join(root, "snapshot.json"),
      lock: join(runtime, "lock"),
      socket: join(runtime, "broker.sock"),
      secret: join(runtime, "secret"),
    };
    let unexpectedStop = false;
    let resolveUnexpectedStop!: () => void;
    const unexpectedStopSeen = new Promise<void>((resolve) => {
      resolveUnexpectedStop = resolve;
    });
    let herdr!: DomainHerdr;
    const broker = new Broker(paths, {
      herdrFactory: async (store) =>
        (herdr = new DomainHerdr(store, () => {
          unexpectedStop = true;
          resolveUnexpectedStop();
        })) as any,
    });
    await broker.start();
    let parent: Socket | undefined;
    let child: Socket | undefined;
    let removeAssignmentListener = () => {};
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
          title: `held-abort-${heldCase}`,
          steps: [
            {
              key: "one",
              profileId: "scout",
              title: "One",
              objective: "held abort",
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
      let registeredConnectionGeneration!: number;
      let resolveAssignmentAccepted!: () => void;
      const assignmentAccepted = new Promise<void>((resolve) => {
        resolveAssignmentAccepted = resolve;
      });
      removeAssignmentListener = broker.store.onAppend((event) => {
        if (
          event.type === "assignment.accepted" &&
          event.entityRefs?.runId === item.runId
        )
          resolveAssignmentAccepted();
      });
      let abortParams: Record<string, unknown> | undefined;
      let resolveAbortReceived!: () => void;
      const abortReceived = new Promise<void>((resolve) => {
        resolveAbortReceived = resolve;
      });
      let releaseResponse!: () => void;
      const responseRelease = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      child = await connectManaged(
        paths,
        herdr.tokens.get(item.agentId)!,
        item.agentId,
        "held-child",
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
          assert.equal(frame.method, "control.abort");
          abortParams = frame.params;
          assert.deepEqual(Object.keys(frame.params).sort(), [
            "agentId",
            "connectionGeneration",
            "generation",
            "piSessionId",
          ]);
          assert.equal(frame.params.agentId, item.agentId);
          assert.equal(frame.params.generation, 1);
          assert.equal(frame.params.piSessionId, "held-child");
          assert.equal(frame.params.runId, undefined);
          assert.equal(frame.params.expected, undefined);
          resolveAbortReceived();
          void responseRelease.then(() => {
            socket.write(
              encodeFrame({
                v: 1,
                type: "server_response",
                id: frame.id,
                ok: true,
                result: { ok: true, extra: true },
              }),
            );
          });
        },
      );
      const registered = resultOf(
        await request(child, "agent.register_managed", {
          agentId: item.agentId,
          generation: 1,
          adapterVersion: "0.1.0",
          herdr: {
            paneId: "pane-old",
            terminalId: "term-old",
            detectedKind: "pi",
            name: "held-child",
          },
          pi: {
            sessionId: "held-child",
            sessionName: "held-child",
            capabilities: {},
            state: {},
          },
        }),
      );
      registeredConnectionGeneration = registered.connectionGeneration;
      const run = broker.store.state.runs[item.runId]!;
      await bounded(assignmentAccepted, "assignment acceptance timeout");
      removeAssignmentListener();
      resultOf(
        await request(child, "agent.lifecycle_event", {
          agentId: item.agentId,
          connectionGeneration: registeredConnectionGeneration,
          adapterSeq: 1,
          event: "turn_start",
          piSessionId: "held-child",
          turnIndex: 1,
          agentCycleId: `held-${heldCase}`,
          assignment: {
            assignmentId: run.assignmentId,
            generation: run.assignmentGeneration,
          },
          safeData: { toolName: null, contextPercent: 0 },
        }),
      );
      const resourceBefore = structuredClone(
        broker.store.state.herdrResources?.[item.agentId],
      );
      assert.ok(resourceBefore);
      const agentBefore = structuredClone(
        broker.store.state.agents[item.agentId],
      );
      assert.ok(agentBefore);
      const cancelResponse = request(parent, "task.cancel", {
        taskId: item.taskId,
        reason: `held_${heldCase}`,
        cascade: true,
      });
      await bounded(abortReceived, "abort receipt timeout");
      assert.ok(abortParams);
      assert.equal(
        abortParams.connectionGeneration,
        registeredConnectionGeneration,
      );
      let mutationComplete!: () => void;
      const mutationDone = new Promise<void>((resolve) => {
        mutationComplete = resolve;
      });
      const actor = {
        principalId: "prn_00000000000000000000000000",
        kind: "system" as const,
      };
      if (heldCase === "replacement") {
        await broker.store.append({
          type: "agent.replaced",
          actor,
          entityRefs: { agentId: item.agentId },
          payload: {
            agentId: item.agentId,
            state: "starting",
            generation: 2,
            connectionGeneration: 2,
            paneId: "pane-new",
            terminalId: "term-new",
            piSessionId: "session-new",
          },
        });
        await broker.store.append({
          type: "herdr.provision.intent",
          actor,
          entityRefs: { agentId: item.agentId },
          payload: { agentId: item.agentId },
        });
        await broker.store.append({
          type: "herdr.provision.outcome",
          actor,
          entityRefs: { agentId: item.agentId },
          payload: {
            agentId: item.agentId,
            state: "registered",
            generation: 2,
            paneId: "pane-new",
            terminalId: "term-new",
            sessionId: "session-new",
            ownerId: item.agentId,
          },
        });
      } else {
        await broker.store.append({
          type: "herdr.provision.outcome",
          actor,
          entityRefs: { agentId: item.agentId },
          payload: {
            agentId: item.agentId,
            state: "registered",
            generation: resourceBefore.generation,
            paneId: resourceBefore.paneId,
            terminalId: resourceBefore.terminalId,
            sessionId: resourceBefore.sessionId,
            cleanupOutcome: "held-abort-mutation",
          },
        });
      }
      mutationComplete();
      await bounded(mutationDone, "mutation completion timeout");
      const replacementAgent = structuredClone(
        broker.store.state.agents[item.agentId],
      );
      const replacementResource = structuredClone(
        broker.store.state.herdrResources?.[item.agentId],
      );
      assert.ok(replacementAgent);
      assert.ok(replacementResource);
      if (heldCase === "replacement") {
        assert.deepEqual(
          {
            connectionGeneration: replacementAgent.connectionGeneration,
            paneId: replacementAgent.paneId,
            terminalId: replacementAgent.terminalId,
            piSessionId: replacementAgent.piSessionId,
            generation: replacementAgent.generation,
            resourceGeneration: replacementResource.generation,
          },
          {
            connectionGeneration: 2,
            paneId: "pane-new",
            terminalId: "term-new",
            piSessionId: "session-new",
            generation: 2,
            resourceGeneration: 2,
          },
        );
      } else {
        assert.equal(replacementResource.cleanupOutcome, "held-abort-mutation");
        assert.equal(replacementResource.paneId, resourceBefore.paneId);
        assert.equal(replacementResource.terminalId, resourceBefore.terminalId);
        assert.equal(replacementResource.sessionId, resourceBefore.sessionId);
        assert.equal(replacementResource.generation, resourceBefore.generation);
      }
      releaseResponse();
      await bounded(
        Promise.race([responseRelease, unexpectedStopSeen]),
        "response release timeout",
      );
      assert.deepEqual(
        resultOf(await bounded(cancelResponse, "task cancellation timeout")),
        { taskId: item.taskId, state: "cancelled" },
      );
      assert.equal(unexpectedStop, false);
      assert.deepEqual(herdr.stops, []);
      assert.deepEqual(
        broker.store.state.agents[item.agentId],
        replacementAgent,
      );
      assert.deepEqual(
        broker.store.state.herdrResources?.[item.agentId],
        replacementResource,
      );
      if (heldCase === "resource-bytes")
        assert.deepEqual(broker.store.state.agents[item.agentId], agentBefore);
      assert.notDeepEqual(
        broker.store.state.herdrResources?.[item.agentId],
        resourceBefore,
      );
    } finally {
      removeAssignmentListener();
      child?.destroy();
      parent?.destroy();
      await broker.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      await rm(runtime, { recursive: true, force: true });
    }
  }
});

type HeldGuardCase =
  | {
      scope: "agent";
      field:
        | "generation"
        | "connectionGeneration"
        | "paneId"
        | "terminalId"
        | "piSessionId";
      value: unknown;
    }
  | {
      scope: "resource";
      field:
        | "paneId"
        | "terminalId"
        | "sessionId"
        | "generation"
        | "replaced"
        | "orphaned";
      value: unknown;
    };

const heldGuardCases: HeldGuardCase[] = [
  { scope: "agent", field: "generation", value: 2 },
  { scope: "agent", field: "connectionGeneration", value: 2 },
  { scope: "agent", field: "paneId", value: "guard-pane" },
  { scope: "agent", field: "terminalId", value: "guard-terminal" },
  { scope: "agent", field: "piSessionId", value: "guard-session" },
  { scope: "resource", field: "paneId", value: "guard-resource-pane" },
  { scope: "resource", field: "terminalId", value: "guard-resource-terminal" },
  { scope: "resource", field: "sessionId", value: "guard-resource-session" },
  { scope: "resource", field: "generation", value: 2 },
  { scope: "resource", field: "replaced", value: true },
  { scope: "resource", field: "orphaned", value: true },
];

async function runHeldGuardCase(guardCase: HeldGuardCase): Promise<void> {
  const root = await mkdtemp(
    join(tmpdir(), `domain-held-guard-${guardCase.scope}-${guardCase.field}-`),
  );
  const runtime = await mkdtemp(
    join(
      tmpdir(),
      `domain-held-guard-${guardCase.scope}-${guardCase.field}-runtime-`,
    ),
  );
  const paths = {
    sessionKey: sessionKey(join(runtime, "broker.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
  let unexpectedStop = false;
  let resolveUnexpectedStop!: () => void;
  const unexpectedStopSeen = new Promise<void>((resolve) => {
    resolveUnexpectedStop = resolve;
  });
  let herdr!: DomainHerdr;
  const broker = new Broker(paths, {
    herdrFactory: async (store) =>
      (herdr = new DomainHerdr(store, () => {
        unexpectedStop = true;
        resolveUnexpectedStop();
      })) as any,
  });
  await broker.start();
  let parent: Socket | undefined;
  let child: Socket | undefined;
  let removeAssignmentListener = () => {};
  try {
    const secret = (await readFile(paths.secret, "utf8")).trim();
    parent = await connect(paths, secret);
    const parentRegistration = resultOf(
      await request(parent, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "root-pane",
          terminalId: "root-terminal",
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
        title: `guard-${guardCase.scope}-${guardCase.field}`,
        steps: [
          {
            key: "one",
            profileId: "scout",
            title: "One",
            objective: "guard",
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
    let resolveAssignmentAccepted!: () => void;
    const assignmentAccepted = new Promise<void>((resolve) => {
      resolveAssignmentAccepted = resolve;
    });
    removeAssignmentListener = broker.store.onAppend((event) => {
      if (
        event.type === "assignment.accepted" &&
        event.entityRefs?.runId === item.runId
      )
        resolveAssignmentAccepted();
    });
    let registeredConnectionGeneration!: number;
    let abortParams: Record<string, unknown> | undefined;
    let resolveAbortReceived!: () => void;
    const abortReceived = new Promise<void>((resolve) => {
      resolveAbortReceived = resolve;
    });
    let releaseResponse!: () => void;
    const responseRelease = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    child = await connectManaged(
      paths,
      herdr.tokens.get(item.agentId)!,
      item.agentId,
      "guard-child",
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
        assert.equal(frame.method, "control.abort");
        abortParams = frame.params;
        assert.deepEqual(Object.keys(frame.params).sort(), [
          "agentId",
          "connectionGeneration",
          "generation",
          "piSessionId",
        ]);
        assert.equal(frame.params.agentId, item.agentId);
        assert.equal(frame.params.generation, 1);
        assert.equal(frame.params.piSessionId, "guard-child");
        assert.equal(frame.params.runId, undefined);
        assert.equal(frame.params.expected, undefined);
        resolveAbortReceived();
        void responseRelease.then(() => {
          socket.write(
            encodeFrame({
              v: 1,
              type: "server_response",
              id: frame.id,
              ok: true,
              result: { ok: true, extra: true },
            }),
          );
        });
      },
    );
    const registered = resultOf(
      await request(child, "agent.register_managed", {
        agentId: item.agentId,
        generation: 1,
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "guard-pane-old",
          terminalId: "guard-terminal-old",
          detectedKind: "pi",
          name: "guard-child",
        },
        pi: {
          sessionId: "guard-child",
          sessionName: "guard-child",
          capabilities: {},
          state: {},
        },
      }),
    );
    registeredConnectionGeneration = registered.connectionGeneration;
    const run = broker.store.state.runs[item.runId]!;
    await bounded(assignmentAccepted, "assignment acceptance timeout");
    removeAssignmentListener();
    resultOf(
      await request(child, "agent.lifecycle_event", {
        agentId: item.agentId,
        connectionGeneration: registeredConnectionGeneration,
        adapterSeq: 1,
        event: "turn_start",
        piSessionId: "guard-child",
        turnIndex: 1,
        agentCycleId: `guard-${guardCase.field}`,
        assignment: {
          assignmentId: run.assignmentId,
          generation: run.assignmentGeneration,
        },
        safeData: { toolName: null, contextPercent: 0 },
      }),
    );
    const agentBefore = structuredClone(
      broker.store.state.agents[item.agentId],
    );
    const resourceBefore = structuredClone(
      broker.store.state.herdrResources?.[item.agentId],
    );
    assert.ok(agentBefore);
    assert.ok(resourceBefore);
    const cancelResponse = request(parent, "task.cancel", {
      taskId: item.taskId,
      reason: `guard_${guardCase.scope}_${guardCase.field}`,
      cascade: true,
    });
    await bounded(abortReceived, "abort receipt timeout");
    assert.ok(abortParams);
    assert.equal(
      abortParams.connectionGeneration,
      registeredConnectionGeneration,
    );
    const actor = {
      principalId: "prn_00000000000000000000000000",
      kind: "system" as const,
    };
    if (guardCase.scope === "agent") {
      await broker.store.append({
        type: "agent.replaced",
        actor,
        entityRefs: { agentId: item.agentId },
        payload: {
          agentId: item.agentId,
          [guardCase.field]: guardCase.value,
        },
      });
    } else {
      await broker.store.append({
        type: "herdr.provision.outcome",
        actor,
        entityRefs: { agentId: item.agentId },
        payload: {
          agentId: item.agentId,
          state: "registered",
          [guardCase.field]: guardCase.value,
        },
      });
    }
    const mutatedAgent = structuredClone(
      broker.store.state.agents[item.agentId],
    );
    const mutatedResource = structuredClone(
      broker.store.state.herdrResources?.[item.agentId],
    );
    assert.ok(mutatedAgent);
    assert.ok(mutatedResource);
    const stripField = (value: unknown, field: string) => {
      const copy = { ...(value as Record<string, unknown>) };
      delete copy[field];
      return copy;
    };
    assert.deepEqual(
      stripField(
        mutatedAgent,
        guardCase.scope === "agent" ? guardCase.field : "__no_agent_field__",
      ),
      stripField(
        agentBefore,
        guardCase.scope === "agent" ? guardCase.field : "__no_agent_field__",
      ),
    );
    assert.deepEqual(
      stripField(
        mutatedResource,
        guardCase.scope === "resource"
          ? guardCase.field
          : "__no_resource_field__",
      ),
      stripField(
        resourceBefore,
        guardCase.scope === "resource"
          ? guardCase.field
          : "__no_resource_field__",
      ),
    );
    assert.equal(
      (mutatedAgent as unknown as Record<string, unknown>)[guardCase.field],
      guardCase.scope === "agent"
        ? guardCase.value
        : (agentBefore as unknown as Record<string, unknown>)[guardCase.field],
    );
    assert.equal(
      (mutatedResource as Record<string, unknown>)[guardCase.field],
      guardCase.scope === "resource"
        ? guardCase.value
        : (resourceBefore as Record<string, unknown>)[guardCase.field],
    );
    releaseResponse();
    await bounded(
      Promise.race([responseRelease, unexpectedStopSeen]),
      "response release timeout",
    );
    assert.deepEqual(
      resultOf(await bounded(cancelResponse, "task cancellation timeout")),
      { taskId: item.taskId, state: "cancelled" },
    );
    assert.equal(unexpectedStop, false);
    assert.deepEqual(herdr.stops, []);
    assert.deepEqual(broker.store.state.agents[item.agentId], mutatedAgent);
    assert.deepEqual(
      broker.store.state.herdrResources?.[item.agentId],
      mutatedResource,
    );
  } finally {
    removeAssignmentListener();
    child?.destroy();
    parent?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
}

test("held abort skips stop for each individual guarded identity mutation", async () => {
  for (const guardCase of heldGuardCases) await runHeldGuardCase(guardCase);
});
