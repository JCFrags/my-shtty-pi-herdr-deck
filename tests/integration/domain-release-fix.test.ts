import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import {
  HerdrService,
  ProvisionOutcomeRecordingError,
} from "../../src/herdr/service.js";
import { digest } from "../../src/broker/authentication.js";
import { createId } from "../../src/shared/ids.js";
import { sessionKey } from "../../src/shared/paths.js";
import { encodeFrame, NdjsonDecoder } from "../../src/shared/protocol/codec.js";
import type { EventStore } from "../../src/state/event-store.js";

type Frame = {
  type?: string;
  id?: string;
  method?: string;
  params?: any;
  ok?: boolean;
  result?: any;
  error?: any;
};
const actor = { principalId: "prn_00000000000000000000000000", kind: "system" };

function pathsFor(root: string, runtime: string) {
  return {
    sessionKey: sessionKey(join(runtime, "broker.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
}
function bounded<T>(
  promise: Promise<T>,
  label: string,
  ms = 5_000,
): Promise<T> {
  let timer: NodeJS.Timeout;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
function request(
  socket: Socket,
  method: string,
  params: Record<string, unknown>,
) {
  const id = createId("evt");
  socket.write(encodeFrame({ v: 1, type: "request", id, method, params }));
  return new Promise<Frame>((resolve, reject) => {
    const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
    const timer = setTimeout(
      () => reject(new Error(`request timeout: ${method}`)),
      5_000,
    );
    const onData = (chunk: Buffer) => {
      for (const item of decoder.push(chunk)) {
        if (!item.ok || item.value.type !== "response" || item.value.id !== id)
          continue;
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(item.value);
      }
    };
    socket.on("data", onData);
  });
}
function resultOf(frame: Frame): any {
  assert.equal(frame.ok, true, JSON.stringify(frame.error));
  return frame.result;
}
async function connect(
  paths: ReturnType<typeof pathsFor>,
  secret: string,
  kind = "pi_parent",
) {
  const socket = createConnection(paths.socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve).once("error", reject);
  });
  const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
  const hello = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hello timeout")), 5_000);
    socket.on("data", (chunk) => {
      for (const item of decoder.push(chunk)) {
        if (!item.ok || item.value.type !== "hello_result") continue;
        clearTimeout(timer);
        if (item.value.ok) resolve();
        else reject(new Error("hello rejected"));
      }
    });
  });
  socket.write(
    encodeFrame({
      v: 1,
      type: "hello",
      id: createId("evt"),
      client: {
        kind,
        name: "release-fix-test",
        version: "0.1.0",
        capabilities: [],
      },
      sessionKey: paths.sessionKey!,
      auth: { kind: "client_secret", secret },
    }),
  );
  await hello;
  return socket;
}
async function connectChild(
  paths: ReturnType<typeof pathsFor>,
  token: string,
  agentId: string,
  sessionId: string,
  onServer: (frame: Frame, socket: Socket) => void,
) {
  const socket = createConnection(paths.socket);
  await new Promise<void>((resolve, reject) =>
    socket.once("connect", resolve).once("error", reject),
  );
  const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
  const hello = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("child hello timeout")),
      5_000,
    );
    socket.on("data", (chunk) => {
      for (const item of decoder.push(chunk)) {
        if (!item.ok) continue;
        if (item.value.type === "hello_result") {
          clearTimeout(timer);
          if (item.value.ok) resolve();
          else reject(new Error("child hello rejected"));
        } else if (item.value.type === "server_request")
          onServer(item.value, socket);
      }
    });
  });
  socket.write(
    encodeFrame({
      v: 1,
      type: "hello",
      id: createId("evt"),
      client: {
        kind: "pi_child",
        name: "release-fix-child",
        version: "0.1.0",
        capabilities: ["pi.lifecycle"],
      },
      sessionKey: paths.sessionKey!,
      auth: {
        kind: "agent_token",
        token,
        agentId,
        generation: 1,
        piSessionId: sessionId,
      },
    }),
  );
  await hello;
  return socket;
}

class AbortHerdr {
  readonly tokens = new Map<string, string>();
  readonly stops: any[] = [];
  stopError: Error | undefined;
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
    const token = `abort-token-${++this.count}`;
    this.tokens.set(input.agentId, token);
    await this.store.append({
      type: "herdr.provision.intent",
      actor,
      entityRefs: { agentId: input.agentId },
      payload: { agentId: input.agentId },
    });
    await this.store.append({
      type: "herdr.provision.outcome",
      actor,
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
  async verifyManagedPane(agentId: string, identity: any) {
    const resource = this.store.state.herdrResources?.[agentId];
    return {
      paneId: identity.paneId,
      terminalId: identity.terminalId ?? resource?.terminalId,
      workspaceId: "w",
      cwd: "/fake",
    };
  }
  async recordRegistrationMismatch(agentId: string) {
    await this.store.append({
      type: "herdr.provision.outcome",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId },
      payload: {
        agentId,
        state: "replaced",
        reason: "registration_identity_mismatch",
        cleanupOutcome: "retained",
        unknown: true,
      },
    });
  }
  async register(agentId: string, identity: any) {
    const resource = this.store.state.herdrResources?.[agentId];
    await this.store.append({
      type: "herdr.provision.outcome",
      actor,
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
  async stop(guard: any) {
    this.stops.push(guard);
    if (this.stopError) throw this.stopError;
  }
}

async function setupAbortCase(
  resourceCase: "orphaned" | "stale" | "safe",
  fallbackError?: Error,
) {
  const root = await mkdtemp(join(tmpdir(), `release-abort-${resourceCase}-`));
  const runtime = await mkdtemp(
    join(tmpdir(), `release-abort-runtime-${resourceCase}-`),
  );
  const paths = pathsFor(root, runtime);
  let herdr!: AbortHerdr;
  const timerRecords = new Map<
    NodeJS.Timeout,
    { delay: number; clears: number; fired: number }
  >();
  const setTimer = (callback: () => void, delay: number) => {
    let record!: { delay: number; clears: number; fired: number };
    const timer = setTimeout(() => {
      record.fired++;
      callback();
    }, delay);
    record = { delay, clears: 0, fired: 0 };
    timerRecords.set(timer, record);
    return timer;
  };
  const clearTimer = (timer: NodeJS.Timeout) => {
    const record = timerRecords.get(timer);
    if (record) record.clears++;
    clearTimeout(timer);
  };
  const broker = new Broker(paths, {
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    herdrFactory: async (store) => (herdr = new AbortHerdr(store)) as any,
  });
  let parent: Socket | undefined;
  let child: Socket | undefined;
  let teardownRestore = () => {};
  let stopAttempted = false;
  try {
    await broker.start();
    const secret = (await readFile(paths.secret, "utf8")).trim();
    parent = await connect(paths, secret);
    const parentAgent = resultOf(
      await request(parent, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "root-pane",
          terminalId: "root-term",
          detectedKind: "pi",
          sessionReference: {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: "integration-session",
          },
          name: "parent",
        },
        pi: {
          sessionId: "parent-session",
          sessionName: "parent",
          capabilities: {},
          state: {
            model: { provider: "openai-codex", modelId: "gpt-5.6-luna" },
            thinkingLevel: "medium",
          },
        },
      }),
    );
    const delegated = resultOf(
      await request(parent, "delegate.execute", {
        mode: "single",
        parentAgentId: parentAgent.agentId,
        title: "abort regression",
        steps: [
          {
            key: "one",
            profileId: "scout",
            title: "one",
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
    let assignmentAccepted!: () => void;
    const accepted = new Promise<void>(
      (resolve) => (assignmentAccepted = resolve),
    );
    const listener = broker.store.onAppend((event) => {
      if (
        event.type === "assignment.accepted" &&
        event.entityRefs?.runId === item.runId
      )
        assignmentAccepted();
    });
    child = await connectChild(
      paths,
      herdr.tokens.get(item.agentId)!,
      item.agentId,
      "abort-session",
      (frame, socket) => {
        if (frame.method === "assignment.deliver")
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
    const registered = resultOf(
      await request(child, "agent.register_managed", {
        agentId: item.agentId,
        generation: 1,
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "pane-1",
          terminalId: "term-1",
          detectedKind: "pi",
          sessionReference: {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: "integration-session",
          },
          name: "child",
        },
        pi: {
          sessionId: "abort-session",
          sessionName: "child",
          capabilities: {},
          state: {
            model: { provider: "openai-codex", modelId: "gpt-5.6-luna" },
            thinkingLevel: "medium",
          },
        },
      }),
    );
    await bounded(accepted, "assignment acceptance timeout");
    listener();
    const run = broker.store.state.runs[item.runId]!;
    resultOf(
      await request(child, "agent.lifecycle_event", {
        agentId: item.agentId,
        connectionGeneration: registered.connectionGeneration,
        adapterSeq: 1,
        event: "turn_start",
        piSessionId: "abort-session",
        turnIndex: 1,
        agentCycleId: "abort-cycle",
        assignment: {
          assignmentId: run.assignmentId,
          generation: run.assignmentGeneration,
        },
        safeData: { toolName: null, contextPercent: 0 },
      }),
    );
    if (resourceCase === "orphaned")
      await broker.store.append({
        type: "herdr.provision.outcome",
        actor,
        entityRefs: { agentId: item.agentId },
        payload: { agentId: item.agentId, state: "orphaned", orphaned: true },
      });
    if (resourceCase === "stale")
      await broker.store.append({
        type: "herdr.provision.outcome",
        actor,
        entityRefs: { agentId: item.agentId },
        payload: {
          agentId: item.agentId,
          state: "pending",
          paneId: "stale-pane",
          terminalId: "term-1",
          sessionId: "abort-session",
          generation: 1,
        },
      });
    herdr.stopError = fallbackError;
    const sentinel = Object.assign(new Error("exact abort EBADF"), {
      code: "EBADF",
    });
    const timersBeforeAbort = new Set(timerRecords.keys());
    let resolveAbortWrite!: () => void;
    const abortWrite = new Promise<void>(
      (resolve) => (resolveAbortWrite = resolve),
    );
    const prototype = Object.getPrototypeOf(child!);
    const write = prototype.write;
    const restoreSocketWrite = () => {
      prototype.write = write;
      assert.equal(prototype.write, write);
    };
    teardownRestore = restoreSocketWrite;
    prototype.write = function (this: Socket, chunk: any, ...rest: any[]) {
      const parsed = JSON.parse(Buffer.from(chunk).toString("utf8"));
      if (
        parsed.type === "server_request" &&
        parsed.method === "control.abort"
      ) {
        resolveAbortWrite();
        throw sentinel;
      }
      return write.call(this, chunk, ...rest);
    } as typeof prototype.write;
    try {
      assert.deepEqual(
        resultOf(
          await bounded(
            request(parent, "task.cancel", {
              taskId: item.taskId,
              reason: "ebadf",
              cascade: true,
            }),
            "cancel response timeout",
          ),
        ),
        { taskId: item.taskId, state: "cancelled" },
      );
      assert.equal(broker.store.state.tasks[item.taskId]?.state, "cancelled");
      assert.equal(broker.store.state.runs[item.runId]?.state, "cancelled");
      await bounded(abortWrite, "abort write boundary timeout");
      const abortTimers = [...timerRecords.entries()].filter(
        ([timer, record]) =>
          record.delay === 10_000 && !timersBeforeAbort.has(timer),
      );
      assert.equal(abortTimers.length, 1);
      assert.equal(abortTimers[0]![1].clears, 1);
      assert.equal(abortTimers[0]![1].fired, 0);
    } finally {
      restoreSocketWrite();
      assert.equal(prototype.write, write);
    }
    stopAttempted = true;
    await assert.rejects(broker.stop(), (error: any) =>
      resourceCase === "safe" && fallbackError
        ? error instanceof AggregateError &&
          error.errors[0] === sentinel &&
          error.errors[1] === fallbackError
        : error === sentinel,
    );
    assert.equal(herdr.stops.length, resourceCase === "safe" ? 1 : 0);
    assert.equal(prototype.write, write);
    assert.equal(
      [...timerRecords.values()].filter(
        (record) => record.delay === 10_000 && record.clears > 1,
      ).length,
      0,
    );
    if (resourceCase === "safe")
      assert.deepEqual(herdr.stops, [
        {
          paneId: "pane-1",
          terminalId: "term-1",
          sessionId: "abort-session",
          generation: 1,
        },
      ]);
    await assert.rejects(access(paths.socket));
    await assert.rejects(access(paths.lock));
  } finally {
    teardownRestore();
    child?.destroy();
    parent?.destroy();
    if (!stopAttempted) await broker.stop();
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
}

test("R1 production abort EBADF is retained through orphaned, stale, safe, and fallback-error paths", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await setupAbortCase("orphaned");
    await setupAbortCase("stale");
    await setupAbortCase("safe");
    const fallback = new Error("exact fallback failure");
    await setupAbortCase("safe", fallback);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

class WorkflowCli {
  async snapshot() {
    return {
      panes: [
        {
          id: "root-pane",
          workspaceId: "w",
          tabId: "t",
          cwd: "/fake",
          terminalId: "root-term",
          occupant: {
            kind: "pi",
            terminalId: "root-term",
            sessionId: "parent-session",
            sessionReference: {
              source: "herdr:pi",
              agent: "pi",
              kind: "id",
              value: "integration-session",
            },
            generation: 1,
          },
        },
      ],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    };
  }
  requireMutationCapabilities() {}
}
class HeldProvisioner {
  readonly entered: Promise<void>;
  readonly secondEntered: Promise<void>;
  readonly thirdEntered: Promise<void>;
  #resolveEntered!: () => void;
  #resolveSecondEntered!: () => void;
  #resolveThirdEntered!: () => void;
  readonly released: Promise<void>;
  readonly secondReleased: Promise<void>;
  readonly thirdReleased: Promise<void>;
  #resolveReleased!: () => void;
  #resolveSecondReleased!: () => void;
  #resolveThirdReleased!: () => void;
  readonly #released = new Set<number>();
  #calls = 0;
  readonly agentIds: string[] = [];
  get calls(): number {
    return this.#calls;
  }
  get entries(): number {
    return this.#calls;
  }
  get releases(): number {
    return this.#released.size;
  }
  constructor(
    readonly errors: readonly Error[],
    readonly failureCalls: ReadonlySet<number> = new Set([1]),
  ) {
    this.entered = new Promise<void>(
      (resolve) => (this.#resolveEntered = resolve),
    );
    this.secondEntered = new Promise<void>(
      (resolve) => (this.#resolveSecondEntered = resolve),
    );
    this.thirdEntered = new Promise<void>(
      (resolve) => (this.#resolveThirdEntered = resolve),
    );
    this.released = new Promise<void>(
      (resolve) => (this.#resolveReleased = resolve),
    );
    this.secondReleased = new Promise<void>(
      (resolve) => (this.#resolveSecondReleased = resolve),
    );
    this.thirdReleased = new Promise<void>(
      (resolve) => (this.#resolveThirdReleased = resolve),
    );
  }
  release(call = 1): void {
    if (this.#released.has(call))
      throw new Error(`provision release called twice: ${call}`);
    this.#released.add(call);
    if (call === 1) this.#resolveReleased();
    else if (call === 2) this.#resolveSecondReleased();
    else if (call === 3) this.#resolveThirdReleased();
    else throw new Error(`unexpected provision call: ${call}`);
  }
  async provision(input: any) {
    const call = ++this.#calls;
    if (call === 1) {
      this.agentIds[0] = input.agentId;
      this.#resolveEntered();
      await this.released;
      if (this.failureCalls.has(call)) throw this.errors[call - 1]!;
    }
    this.agentIds[call - 1] = input.agentId;
    if (call === 2) {
      this.#resolveSecondEntered();
      await this.secondReleased;
    } else if (call === 3) {
      this.#resolveThirdEntered();
      await this.thirdReleased;
    } else throw new Error(`unexpected provision call: ${call}`);
    if (this.failureCalls.has(call)) throw this.errors[call - 1]!;
    const token = `ready-token-${call}`;
    return {
      name: `ready-${call}`,
      token: { token, digest: digest(token), generation: 1 },
      paneId: `ready-pane-${call}`,
    };
  }
}
async function setupProvisionCase(
  recordOutcome: boolean,
  capacityProbe = false,
) {
  const root = await mkdtemp(
    join(tmpdir(), `release-provision-${recordOutcome}-${capacityProbe}-`),
  );
  const runtime = await mkdtemp(
    join(
      tmpdir(),
      `release-provision-runtime-${recordOutcome}-${capacityProbe}-`,
    ),
  );
  const paths = pathsFor(root, runtime);
  const provisionErrors = [
    new Error("exact provision failure one"),
    new Error("exact provision failure two"),
  ];
  const outcomeErrors = [
    Object.assign(new Error("exact outcome append failure one"), {
      code: "EOUTCOME_ONE",
    }),
    Object.assign(new Error("exact outcome append failure two"), {
      code: "EOUTCOME_TWO",
    }),
  ];
  const provisioner = new HeldProvisioner(
    provisionErrors,
    capacityProbe ? new Set([1, 2]) : new Set([1]),
  );
  const broker = new Broker(paths, {
    herdrFactory: async (store) =>
      new HerdrService({
        store,
        cli: new WorkflowCli() as any,
        provisioner: provisioner as any,
      }),
  });
  let parent: Socket | undefined;
  let stopAttempted = false;
  let primaryFailure: unknown;
  try {
    await broker.start();
    const secret = (await readFile(paths.secret, "utf8")).trim();
    parent = await connect(paths, secret);
    const parentAgent = resultOf(
      await request(parent, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "root-pane",
          terminalId: "root-term",
          detectedKind: "pi",
          sessionReference: {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: "integration-session",
          },
          name: "parent",
        },
        pi: {
          sessionId: "parent-session",
          sessionName: "parent",
          capabilities: {},
          state: {
            model: { provider: "openai-codex", modelId: "gpt-5.6-luna" },
            thinkingLevel: "medium",
          },
        },
      }),
    );
    const runCreatedReceipts: any[] = [];
    let resolveFirstRunCreated!: () => void;
    let resolveSecondRunCreated!: () => void;
    const firstRunCreated = new Promise<void>(
      (resolve) => (resolveFirstRunCreated = resolve),
    );
    const secondRunCreated = new Promise<void>(
      (resolve) => (resolveSecondRunCreated = resolve),
    );
    const removeRunCreated = broker.store.onAppend((event) => {
      if (event.type !== "run.created") return;
      runCreatedReceipts.push(event);
      if (runCreatedReceipts.length === 1) resolveFirstRunCreated();
      if (runCreatedReceipts.length === 2) resolveSecondRunCreated();
    });
    const delegatedRequest = request(parent, "delegate.execute", {
      mode: "parallel",
      parentAgentId: parentAgent.agentId,
      title: "provision regression",
      steps: [
        {
          key: "one",
          profileId: "scout",
          title: "one",
          objective: "fail provision",
          dependsOn: [],
        },
        {
          key: "two",
          profileId: "scout",
          title: "two",
          objective: "fail provision two",
          dependsOn: [],
        },
        {
          key: "three",
          profileId: "scout",
          title: "three",
          objective: "ready provision three",
          dependsOn: [],
        },
      ],
      wait: false,
      waitUntil: [],
      timeoutMs: 10_000,
      failureMode: "collect_all",
      dryRun: false,
    });
    await Promise.all([
      bounded(firstRunCreated, "first run-created receipt timeout"),
      bounded(provisioner.entered, "first provision entry timeout"),
    ]);
    const firstReceipt = runCreatedReceipts[0]!;
    const firstIds = {
      taskId: firstReceipt.entityRefs.taskId,
      runId: firstReceipt.entityRefs.runId,
      agentId: firstReceipt.entityRefs.agentId,
    };
    assert.ok(firstIds.taskId && firstIds.runId && firstIds.agentId);
    assert.deepEqual(
      {
        taskId: firstReceipt.payload.taskId,
        runId: firstReceipt.payload.runId,
        agentId: firstReceipt.payload.agentId,
      },
      firstIds,
    );
    assert.deepEqual(
      {
        taskId: firstReceipt.entityRefs.taskId,
        runId: firstReceipt.entityRefs.runId,
        agentId: firstReceipt.entityRefs.agentId,
      },
      firstIds,
    );
    assert.equal(firstIds.agentId, provisioner.agentIds[0]);
    assert.equal(broker.store.state.tasks[firstIds.taskId]?.title, "one");
    assert.equal(
      broker.store.state.tasks[firstIds.taskId]?.workflowId !== undefined,
      true,
    );

    const targetIds = [firstIds];
    const outcomeAttempts = new Map<string, number>();
    const durableOutcomes = new Map<string, number>();
    const append = broker.store.append.bind(broker.store);
    (broker.store as any).append = async (event: any) => {
      const index = targetIds.findIndex(
        (target) =>
          event.type === "herdr.provision.outcome" &&
          event.entityRefs?.agentId === target.agentId,
      );
      if (index >= 0) {
        const agentId = targetIds[index]!.agentId;
        outcomeAttempts.set(agentId, (outcomeAttempts.get(agentId) ?? 0) + 1);
        if (!recordOutcome) throw outcomeErrors[index]!;
        const result = await append(event);
        durableOutcomes.set(agentId, (durableOutcomes.get(agentId) ?? 0) + 1);
        return result;
      }
      return append(event);
    };

    const runFailedCounts = new Map<string, number>();
    const agentReplacedCounts = new Map<string, number>();
    const resolvedRuns = new Set<string>();
    const resolvedAgents = new Set<string>();
    const resolveRun = new Map<string, () => void>();
    const resolveAgent = new Map<string, () => void>();
    const runWaits = new Map<string, Promise<void>>();
    const agentWaits = new Map<string, Promise<void>>();
    const addTarget = (target: typeof firstIds) => {
      runWaits.set(
        target.runId,
        new Promise<void>((resolve) => resolveRun.set(target.runId, resolve)),
      );
      agentWaits.set(
        target.agentId,
        new Promise<void>((resolve) =>
          resolveAgent.set(target.agentId, resolve),
        ),
      );
    };
    addTarget(firstIds);
    const removeReceipts = broker.store.onAppend((event) => {
      if (
        event.type === "run.state_changed" &&
        (event.payload as any)?.state === "failed"
      ) {
        const runId = event.entityRefs?.runId;
        if (
          typeof runId === "string" &&
          targetIds.some((target) => target.runId === runId)
        ) {
          runFailedCounts.set(runId, (runFailedCounts.get(runId) ?? 0) + 1);
          if (!resolvedRuns.has(runId)) {
            resolvedRuns.add(runId);
            resolveRun.get(runId)?.();
          }
        }
      }
      if (
        event.type === "agent.state_changed" &&
        (event.payload as any)?.state === "replaced"
      ) {
        const agentId = event.entityRefs?.agentId;
        if (
          typeof agentId === "string" &&
          targetIds.some((target) => target.agentId === agentId)
        ) {
          agentReplacedCounts.set(
            agentId,
            (agentReplacedCounts.get(agentId) ?? 0) + 1,
          );
          if (!resolvedAgents.has(agentId)) {
            resolvedAgents.add(agentId);
            resolveAgent.get(agentId)?.();
          }
        }
      }
    });

    provisioner.release(1);
    if (capacityProbe) {
      await Promise.all([
        bounded(secondRunCreated, "second run-created receipt timeout"),
        bounded(provisioner.secondEntered, "second provision entry timeout"),
      ]);
      const secondReceipt = runCreatedReceipts[1]!;
      const secondIds = {
        taskId: secondReceipt.entityRefs.taskId,
        runId: secondReceipt.entityRefs.runId,
        agentId: secondReceipt.entityRefs.agentId,
      };
      assert.ok(secondIds.taskId && secondIds.runId && secondIds.agentId);
      assert.deepEqual(
        {
          taskId: secondReceipt.payload.taskId,
          runId: secondReceipt.payload.runId,
          agentId: secondReceipt.payload.agentId,
        },
        secondIds,
      );
      assert.deepEqual(
        {
          taskId: secondReceipt.entityRefs.taskId,
          runId: secondReceipt.entityRefs.runId,
          agentId: secondReceipt.entityRefs.agentId,
        },
        secondIds,
      );
      assert.equal(secondIds.agentId, provisioner.agentIds[1]);
      assert.equal(broker.store.state.tasks[secondIds.taskId]?.title, "two");
      targetIds.push(secondIds);
      addTarget(secondIds);
      provisioner.release(2);
      await bounded(provisioner.thirdEntered, "third provision entry timeout");
      provisioner.release(3);
    } else {
      await bounded(
        provisioner.secondEntered,
        "second provision entry timeout",
      );
      provisioner.release(2);
      await bounded(provisioner.thirdEntered, "third provision entry timeout");
      provisioner.release(3);
    }
    const delegated = resultOf(
      await bounded(delegatedRequest, "delegate response timeout"),
    );
    for (const [index, target] of targetIds.entries()) {
      const item = delegated.tasks[index];
      assert.equal(item.taskId, target.taskId);
      assert.equal(item.runId, target.runId);
      assert.equal(item.agentId, target.agentId);
      assert.equal(item.state, "failed");
    }
    await Promise.all(
      targetIds.flatMap((target) => [
        bounded(runWaits.get(target.runId)!, "run failed receipt timeout"),
        bounded(
          agentWaits.get(target.agentId)!,
          "agent replaced receipt timeout",
        ),
      ]),
    );
    removeReceipts();
    removeRunCreated();
    assert.equal(provisioner.calls, 3);
    assert.equal(provisioner.entries, 3);
    assert.equal(provisioner.releases, 3);
    for (const target of targetIds) {
      assert.equal(outcomeAttempts.get(target.agentId), 1);
      assert.equal(
        durableOutcomes.get(target.agentId) ?? 0,
        recordOutcome ? 1 : 0,
      );
      assert.equal(runFailedCounts.get(target.runId), 1);
      assert.equal(agentReplacedCounts.get(target.agentId), 1);
      assert.equal(broker.store.state.tasks[target.taskId]?.state, "failed");
      assert.equal(broker.store.state.runs[target.runId]?.state, "failed");
      assert.equal(
        broker.store.state.agents[target.agentId]?.state,
        "replaced",
      );
    }
    stopAttempted = true;
    if (recordOutcome) {
      await broker.stop();
    } else {
      let stopError: unknown;
      try {
        await broker.stop();
        assert.fail("stop unexpectedly resolved");
      } catch (error) {
        stopError = error;
      }
      assert.ok(stopError instanceof ProvisionOutcomeRecordingError);
      assert.equal(stopError.provisionError, provisionErrors[0]);
      assert.equal(stopError.outcomeError, outcomeErrors[0]);
      assert.equal(stopError.cause, provisionErrors[0]);
      assert.deepEqual(stopError.errors, [
        provisionErrors[0],
        outcomeErrors[0],
      ]);
      if (capacityProbe) {
        assert.notEqual(stopError.provisionError, provisionErrors[1]);
        assert.notEqual(stopError.outcomeError, outcomeErrors[1]);
      }
    }
    await assert.rejects(access(paths.socket));
    await assert.rejects(access(paths.lock));
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    parent?.destroy();
    if (!stopAttempted) {
      try {
        await broker.stop();
      } catch (error) {
        if (primaryFailure === undefined) throw error;
      }
    }
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
}

test("R2 production provisioning outcome recording failure is stop-observable", async () => {
  await setupProvisionCase(false, true);
});
test("R2 ordinary durable provision failure does not poison stop", async () => {
  await setupProvisionCase(true);
});
