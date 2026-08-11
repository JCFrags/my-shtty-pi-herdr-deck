import assert from "node:assert/strict";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import { EventStore } from "../../src/state/event-store.js";
import { encodeFrame, NdjsonDecoder } from "../../src/shared/protocol/codec.js";
import { sessionKey } from "../../src/shared/paths.js";
import { createId } from "../../src/shared/ids.js";

const actor = {
  principalId: "prn_00000000000000000000000000",
  kind: "system" as const,
};

interface Frame {
  type: string;
  id?: string;
  method?: string;
  ok?: boolean;
  result?: any;
  error?: any;
}

function resultOf<T extends Frame>(frame: T): any {
  assert.equal(frame.ok, true, JSON.stringify(frame.error));
  return frame.result;
}

async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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
    const onClose = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      reject(new Error(`closed during ${method}`));
    };
    const onData = (chunk: Buffer) => {
      for (const item of decoder.push(chunk)) {
        if (!item.ok || item.value.id !== id) continue;
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("close", onClose);
        resolve(item.value);
      }
    };
    socket.on("data", onData);
    socket.once("close", onClose);
  });
}

async function connect(
  socketPath: string,
  secret: string,
  kind: "pi_parent" | "pi_child" = "pi_parent",
  auth: Record<string, unknown> = { kind: "client_secret", secret },
): Promise<Socket> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
  const hello = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hello timeout")), 2_000);
    const onData = (chunk: Buffer) => {
      for (const item of decoder.push(chunk)) {
        if (!item.ok || item.value.type !== "hello_result") continue;
        clearTimeout(timer);
        socket.off("data", onData);
        if (item.value.ok === true) resolve();
        else reject(new Error("hello rejected"));
      }
    };
    socket.on("data", onData);
  });
  socket.write(
    encodeFrame({
      v: 1,
      type: "hello",
      id: createId("evt"),
      client: {
        kind,
        name: "shutdown-test",
        version: "0.1.0",
        capabilities: ["pi.lifecycle"],
      },
      sessionKey: sessionKey(socketPath),
      auth,
    }),
  );
  await hello;
  return socket;
}

class ControlledHerdr {
  readonly tokens = new Map<string, string>();
  readonly provisions: any[] = [];
  readonly stops: any[] = [];
  provisionGate: Promise<void> | undefined;
  stopGate: Promise<void> | undefined;
  stopError: unknown = undefined;
  onProvisionEntered?: (input: any) => void;
  onProvisionFinished?: (input: any) => void;
  onStopEntered?: (guard: any) => void;
  #count = 0;
  constructor(readonly store: EventStore) {}
  async startupReconcile() {
    return [];
  }
  async verifyRoot(identity: any) {
    return {
      paneId: identity.paneId,
      terminalId: identity.terminalId,
      workspaceId: "shutdown-workspace",
      cwd: "/shutdown-project",
    };
  }
  async provision(input: any) {
    const token = `shutdown-token-${++this.#count}`;
    this.tokens.set(input.agentId, token);
    this.provisions.push(input);
    this.onProvisionEntered?.(input);
    if (this.provisionGate) await this.provisionGate;
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
        paneId: `shutdown-pane-${this.#count}`,
        terminalId: `shutdown-terminal-${this.#count}`,
        tokenDigest: await import("node:crypto").then(({ createHash }) =>
          createHash("sha256").update(token).digest("hex"),
        ),
        generation: 1,
        parentAgentId: input.parentAgentId,
        ownerId: input.agentId,
      },
    });
    this.onProvisionFinished?.(input);
    return {
      name: `shutdown-child-${this.#count}`,
      token: { token, generation: 1, digest: "unused-in-test" },
      paneId: `shutdown-pane-${this.#count}`,
    };
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
    this.onStopEntered?.(guard);
    if (this.stopGate) await this.stopGate;
    if (this.stopError !== undefined) throw this.stopError;
  }
}

class ShutdownTimers {
  readonly entries = new Map<
    NodeJS.Timeout,
    { due: number; order: number; callback: () => void; active: boolean }
  >();
  now: number;
  dispatchCount = 0;
  callbackCount = 0;
  #order = 0;
  #bodyGate: Promise<void> | undefined;
  #resolveBodyStarted!: () => void;
  readonly bodyStarted = new Promise<void>((resolve) => {
    this.#resolveBodyStarted = resolve;
  });
  constructor(now: number) {
    this.now = now;
  }
  setBodyGate(gate: Promise<void>): void {
    this.#bodyGate = gate;
  }
  setTimeout = (callback: () => void, delayMs: number): NodeJS.Timeout => {
    const handle = {
      timer: Symbol("shutdown-timer"),
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
  dispatchNextDue(until: number): boolean {
    this.now = until;
    const due = [...this.entries.entries()]
      .filter(([, entry]) => entry.active && entry.due <= until)
      .sort(
        ([, left], [, right]) =>
          left.due - right.due || left.order - right.order,
      );
    const [handle, entry] = due[0] ?? [];
    if (!handle || !entry) return false;
    this.clearTimeout(handle);
    this.dispatchCount++;
    this.#resolveBodyStarted();
    void (this.#bodyGate ?? Promise.resolve()).then(() => {
      this.callbackCount++;
      entry.callback();
    });
    return true;
  }
  activeCount(): number {
    return [...this.entries.values()].filter((entry) => entry.active).length;
  }
}

async function registerParent(socket: Socket): Promise<any> {
  return resultOf(
    await request(socket, "agent.register_adopted", {
      adapterVersion: "0.1.0",
      herdr: {
        paneId: "shutdown-root",
        terminalId: "shutdown-root",
        detectedKind: "pi",
        name: "shutdown-root",
      },
      pi: {
        sessionId: "shutdown-root",
        sessionName: "shutdown-root",
        capabilities: {},
        state: {},
      },
    }),
  );
}

async function provisionParams(agentId: string, parentAgentId: string) {
  return {
    agentId,
    parentAgentId,
    role: "scout",
    workspaceId: "shutdown-workspace",
    cwd: "/shutdown-project",
    profileId: "scout",
    isolation: "shared-readonly",
    prompt: "shutdown test",
    projectBase: "/shutdown-project",
    branch: "main",
    env: {},
  };
}

test("committed response survives snapshot failure and stop reports the sentinel", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "shutdown-snapshot-"));
  const runtime = await mkdtemp(join(tmpdir(), "shutdown-snapshot-runtime-"));
  const paths = pathsFor(root, runtime);
  const broker = new Broker(paths, {
    herdrFactory: async (store) => new ControlledHerdr(store) as any,
  });
  let parent: Socket | undefined;
  try {
    await broker.start();
    const secret = (await readFile(paths.secret, "utf8")).trim();
    parent = await connect(paths.socket, secret);
    const rootAgent = await registerParent(parent);
    const beforeBytes = await readFile(paths.events, "utf8");
    const beforeCount = broker.store.events.length;
    const sentinel = new Error("snapshot sentinel failure");
    const snapshotStore = broker.snapshotStore as unknown as {
      write: (...args: unknown[]) => Promise<void>;
    };
    snapshotStore.write = async () => {
      throw sentinel;
    };
    const response = resultOf(
      await request(parent, "task.create_m3", {
        title: "snapshot failure",
        objective: "snapshot failure",
        parentAgentId: rootAgent.agentId,
        timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    assert.equal(response.state, "queued");
    assert.notEqual(await readFile(paths.events, "utf8"), beforeBytes);
    assert.equal(broker.store.events.length - beforeCount, 1);
    const stop = broker.stop();
    await assert.rejects(stop, (error: unknown) => error === sentinel);
    await assert.rejects(access(paths.socket));
    await assert.rejects(access(paths.lock));
  } finally {
    parent?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("failed start attempts lock release after process-record cleanup rejects", async () => {
  const root = await mkdtemp(join(tmpdir(), "shutdown-start-cleanup-"));
  const runtime = await mkdtemp(
    join(tmpdir(), "shutdown-start-cleanup-runtime-"),
  );
  const paths = pathsFor(root, runtime);
  const pid = `${paths.lock}.pid`;
  const retained = `${pid}.owned-retained`;
  const replacement = "replacement process record\n";
  const primary = new Error("START_PRIMARY_FAILURE");
  const broker = new Broker(paths, {
    herdrFactory: async () => {
      await rename(pid, retained);
      await writeFile(pid, replacement, { mode: 0o600 });
      throw primary;
    },
  });
  try {
    await assert.rejects(broker.start(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0], primary);
      assert.match(String(error.errors[1]), /identity changed before removal/u);
      return true;
    });
    assert.equal(await readFile(pid, "utf8"), replacement);
    assert.equal((await lstat(retained)).isFile(), true);
    await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
    assert.equal(
      (await readdir(runtime)).filter(
        (name) =>
          name === "lock" ||
          name.startsWith("lock.create.") ||
          name.startsWith("lock.release."),
      ).length,
      0,
    );
    await assert.rejects(broker.stop(), /identity changed before removal/u);
    await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("server-created failed start retries retained exact lifecycle cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "shutdown-stop-retry-"));
  const runtime = await mkdtemp(join(tmpdir(), "shutdown-stop-retry-runtime-"));
  const paths = pathsFor(root, runtime);
  const pid = `${paths.lock}.pid`;
  const pidRetained = `${pid}.owned-retained`;
  const lockRetained = `${paths.lock}.owned-retained`;
  const pidReplacement = `${pid}.replacement-preserved`;
  const lockReplacement = `${paths.lock}.replacement-preserved`;
  let competitor: Server | undefined;
  const herdr = {
    startupReconcile: async () => {
      await rename(pid, pidRetained);
      await writeFile(pid, "pid replacement\n", { mode: 0o600 });
      await rename(paths.lock, lockRetained);
      await writeFile(paths.lock, "lock replacement\n", { mode: 0o600 });
      competitor = createServer();
      await new Promise<void>((resolve, reject) =>
        competitor!.once("error", reject).listen(paths.socket, resolve),
      );
      return [];
    },
    shutdown: () => undefined,
  };
  const broker = new Broker(paths, {
    herdrFactory: async () => herdr as any,
  });
  try {
    await assert.rejects(broker.start(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[0]), /EADDRINUSE/u);
      assert.ok(error.errors[1] instanceof AggregateError);
      assert.equal(error.errors[1].errors.length, 2);
      assert.match(
        String(error.errors[1].errors[0]),
        /process record identity changed/u,
      );
      assert.match(
        String(error.errors[1].errors[1]),
        /Lock path identity changed/u,
      );
      return true;
    });
    assert.equal(await readFile(pid, "utf8"), "pid replacement\n");
    assert.equal(await readFile(paths.lock, "utf8"), "lock replacement\n");
    await rename(pid, pidReplacement);
    await rename(pidRetained, pid);
    await rename(paths.lock, lockReplacement);
    await rename(lockRetained, paths.lock);
    await new Promise<void>((resolve, reject) =>
      competitor!.close((error) => (error ? reject(error) : resolve())),
    );
    competitor = undefined;

    await broker.stop();
    await assert.rejects(lstat(pid), { code: "ENOENT" });
    await assert.rejects(lstat(paths.lock), { code: "ENOENT" });
    assert.equal(await readFile(pidReplacement, "utf8"), "pid replacement\n");
    assert.equal(await readFile(lockReplacement, "utf8"), "lock replacement\n");
    assert.equal(
      (await readdir(runtime)).filter(
        (name) =>
          name === "lock" ||
          name === "lock.pid" ||
          name.startsWith("lock.create.") ||
          name.startsWith("lock.release.") ||
          name.startsWith("lock.pid.create.") ||
          name.startsWith("lock.pid.remove."),
      ).length,
      0,
    );
  } finally {
    const failures: unknown[] = [];
    if (competitor?.listening)
      try {
        await new Promise<void>((resolve, reject) =>
          competitor!.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        failures.push(error);
      }
    try {
      await rm(root, { recursive: true, force: true });
      await rm(runtime, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Stop retry test cleanup failed.");
  }
});

test("a failed first start cannot be retried on the same Broker", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "shutdown-start-attempt-"));
  const runtime = await mkdtemp(
    join(tmpdir(), "shutdown-start-attempt-runtime-"),
  );
  const paths = pathsFor(root, runtime);
  const owner = new Broker(paths);
  const contender = new Broker(paths);
  try {
    await owner.start();
    await assert.rejects(contender.start());
    await assert.rejects(contender.start(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INVALID_REQUEST");
      return true;
    });
  } finally {
    await contender.stop().catch(() => undefined);
    await owner.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production shutdown drains an admitted provision and coalesces stop", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "shutdown-drain-")),
  );
  const runtime = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "shutdown-drain-runtime-")),
  );
  const paths = pathsFor(root, runtime);
  let herdr!: ControlledHerdr;
  const broker = new Broker(paths, {
    herdrFactory: async (store) => (herdr = new ControlledHerdr(store)) as any,
  });
  let parent: Socket | undefined;
  try {
    await broker.start();
    const secret = (await readFile(paths.secret, "utf8")).trim();
    parent = await connect(paths.socket, secret);
    const rootAgent = await registerParent(parent);
    let releaseProvision!: () => void;
    herdr.provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    let resolveProvisionEntered!: () => void;
    const provisionEntered = new Promise<void>((resolve) => {
      resolveProvisionEntered = resolve;
    });
    let resolveProvisionFinished!: () => void;
    const provisionFinished = new Promise<void>((resolve) => {
      resolveProvisionFinished = resolve;
    });
    herdr.onProvisionEntered = () => resolveProvisionEntered();
    herdr.onProvisionFinished = () => resolveProvisionFinished();
    const provisionRequest = request(
      parent,
      "herdr.provision",
      await provisionParams(createId("agt"), rootAgent.agentId),
    );
    const provisionClosed = assert.rejects(
      provisionRequest,
      (error: unknown) => {
        assert.equal((error as Error).message, "closed during herdr.provision");
        return true;
      },
    );
    await bounded(provisionEntered, "provision was not admitted");
    const beforeBytes = await readFile(paths.events, "utf8");
    const beforeCount = broker.store.events.length;
    const stopOne = broker.stop();
    const stopTwo = broker.stop();
    assert.equal(stopOne, stopTwo);
    const resolvedBeforeRelease = await Promise.race([
      stopOne.then(() => true),
      nextImmediate().then(() => false),
    ]);
    assert.equal(resolvedBeforeRelease, false);
    releaseProvision();
    await bounded(provisionFinished, "provision did not drain");
    const drainedBytes = await readFile(paths.events, "utf8");
    const drainedCount = broker.store.events.length;
    await stopOne;
    await provisionClosed;
    const afterBytes = await readFile(paths.events, "utf8");
    assert.equal(afterBytes, drainedBytes);
    assert.equal(broker.store.events.length, drainedCount);
    assert.notEqual(afterBytes, beforeBytes);
    assert.equal(
      drainedCount - beforeCount,
      2,
      "one intent and one outcome must drain exactly once",
    );
    const stableBytes = afterBytes;
    const stableCount = broker.store.events.length;
    await nextImmediate();
    assert.equal(await readFile(paths.events, "utf8"), stableBytes);
    assert.equal(broker.store.events.length, stableCount);
    await assert.rejects(access(paths.socket));
    await assert.rejects(access(paths.lock));
    await assert.rejects(broker.start(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INVALID_REQUEST");
      return true;
    });
  } finally {
    parent?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production shutdown waits for cancellation fallback", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "shutdown-cancel-"));
  const runtime = await mkdtemp(join(tmpdir(), "shutdown-cancel-runtime-"));
  const paths = pathsFor(root, runtime);
  let herdr!: ControlledHerdr;
  const broker = new Broker(paths, {
    herdrFactory: async (store) => (herdr = new ControlledHerdr(store)) as any,
  });
  let parent: Socket | undefined;
  let child: Socket | undefined;
  try {
    await broker.start();
    const secret = (await readFile(paths.secret, "utf8")).trim();
    parent = await connect(paths.socket, secret);
    const rootAgent = await registerParent(parent);
    const agentId = createId("agt");
    resultOf(
      await request(
        parent,
        "herdr.provision",
        await provisionParams(agentId, rootAgent.agentId),
      ),
    );
    const token = herdr.tokens.get(agentId)!;
    let resolveAbort!: () => void;
    const abortReceived = new Promise<void>(
      (resolve) => (resolveAbort = resolve),
    );
    child = await connect(paths.socket, secret, "pi_child", {
      kind: "agent_token",
      token,
      agentId,
      generation: 1,
      piSessionId: "shutdown-child",
    });
    child.on("data", (chunk) => {
      const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
      for (const item of decoder.push(chunk)) {
        if (!item.ok || item.value.type !== "server_request") continue;
        if (item.value.method === "assignment.deliver")
          child!.write(
            encodeFrame({
              v: 1,
              type: "server_response",
              id: item.value.id,
              ok: true,
              result: { status: "accepted" },
            }),
          );
        else if (item.value.method === "control.abort") resolveAbort();
      }
    });
    resultOf(
      await request(child, "agent.register_managed", {
        agentId,
        generation: 1,
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "shutdown-child",
          terminalId: "shutdown-child",
          detectedKind: "pi",
          name: "shutdown-child",
        },
        pi: {
          sessionId: "shutdown-child",
          sessionName: "shutdown-child",
          capabilities: {},
          state: {},
        },
      }),
    );
    const task = resultOf(
      await request(parent, "task.create_m3", {
        title: "shutdown cancellation",
        objective: "shutdown cancellation",
        parentAgentId: rootAgent.agentId,
        timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    resultOf(
      await request(parent, "run.create", {
        taskId: task.taskId,
        agentId,
        assignmentGeneration: 1,
        piSessionId: "shutdown-child",
        terminalId: "shutdown-child",
      }),
    );
    const cancelResponse = request(parent, "task.cancel", {
      taskId: task.taskId,
      reason: "shutdown_cancel",
      cascade: true,
    });
    await bounded(abortReceived, "abort was not dispatched");
    let releaseStop!: () => void;
    herdr.stopGate = new Promise<void>((resolve) => (releaseStop = resolve));
    let resolveStopEntered!: () => void;
    const stopEntered = new Promise<void>(
      (resolve) => (resolveStopEntered = resolve),
    );
    herdr.onStopEntered = () => resolveStopEntered();
    await cancelResponse;
    const stopOne = broker.stop();
    const stopTwo = broker.stop();
    assert.equal(stopOne, stopTwo);
    await bounded(stopEntered, "fallback stop was not admitted");
    const heldFallbackBytes = await readFile(paths.events, "utf8");
    const heldFallbackCount = broker.store.events.length;
    const resolvedBeforeRelease = await Promise.race([
      stopOne.then(() => true),
      nextImmediate().then(() => false),
    ]);
    assert.equal(resolvedBeforeRelease, false);
    releaseStop();
    await stopOne;
    assert.equal(herdr.stops.length, 1);
    assert.equal(await readFile(paths.events, "utf8"), heldFallbackBytes);
    assert.equal(broker.store.events.length, heldFallbackCount);
    await nextImmediate();
    assert.equal(herdr.stops.length, 1);
    assert.equal(await readFile(paths.events, "utf8"), heldFallbackBytes);
    await assert.rejects(access(paths.socket));
    await assert.rejects(access(paths.lock));
  } finally {
    child?.destroy();
    parent?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production shutdown reports an unexpected deferred fallback after cleanup", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "shutdown-error-"));
  const runtime = await mkdtemp(join(tmpdir(), "shutdown-error-runtime-"));
  const paths = pathsFor(root, runtime);
  let herdr!: ControlledHerdr;
  const broker = new Broker(paths, {
    herdrFactory: async (store) => (herdr = new ControlledHerdr(store)) as any,
  });
  let parent: Socket | undefined;
  let child: Socket | undefined;
  try {
    await broker.start();
    const secret = (await readFile(paths.secret, "utf8")).trim();
    parent = await connect(paths.socket, secret);
    const rootAgent = await registerParent(parent);
    const agentId = createId("agt");
    resultOf(
      await request(
        parent,
        "herdr.provision",
        await provisionParams(agentId, rootAgent.agentId),
      ),
    );
    child = await connect(paths.socket, secret, "pi_child", {
      kind: "agent_token",
      token: herdr.tokens.get(agentId)!,
      agentId,
      generation: 1,
      piSessionId: "shutdown-error-child",
    });
    let resolveAbort!: () => void;
    const abortReceived = new Promise<void>(
      (resolve) => (resolveAbort = resolve),
    );
    child.on("data", (chunk) => {
      const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
      for (const item of decoder.push(chunk)) {
        if (!item.ok || item.value.type !== "server_request") continue;
        if (item.value.method === "assignment.deliver")
          child!.write(
            encodeFrame({
              v: 1,
              type: "server_response",
              id: item.value.id,
              ok: true,
              result: { status: "accepted" },
            }),
          );
        else if (item.value.method === "control.abort") resolveAbort();
      }
    });
    resultOf(
      await request(child, "agent.register_managed", {
        agentId,
        generation: 1,
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "shutdown-error-child",
          terminalId: "shutdown-error-child",
          detectedKind: "pi",
          name: "shutdown-error-child",
        },
        pi: {
          sessionId: "shutdown-error-child",
          sessionName: "shutdown-error-child",
          capabilities: {},
          state: {},
        },
      }),
    );
    const task = resultOf(
      await request(parent, "task.create_m3", {
        title: "shutdown error",
        objective: "shutdown error",
        parentAgentId: rootAgent.agentId,
        timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    resultOf(
      await request(parent, "run.create", {
        taskId: task.taskId,
        agentId,
        assignmentGeneration: 1,
        piSessionId: "shutdown-error-child",
        terminalId: "shutdown-error-child",
      }),
    );
    const cancelResponse = request(parent, "task.cancel", {
      taskId: task.taskId,
      reason: "shutdown_error",
      cascade: true,
    });
    await bounded(abortReceived, "error-case abort was not dispatched");
    await cancelResponse;
    const sentinel = new Error("sentinel deferred fallback failure");
    herdr.stopError = sentinel;
    const beforeBytes = await readFile(paths.events, "utf8");
    const beforeCount = broker.store.events.length;
    const stop = broker.stop();
    await assert.rejects(stop, (error: unknown) => error === sentinel);
    assert.equal(await readFile(paths.events, "utf8"), beforeBytes);
    assert.equal(broker.store.events.length, beforeCount);
    assert.equal(herdr.stops.length, 1);
    await assert.rejects(access(paths.socket));
    await assert.rejects(access(paths.lock));
    await nextImmediate();
    assert.equal(await readFile(paths.events, "utf8"), beforeBytes);
    assert.equal(broker.store.events.length, beforeCount);
  } finally {
    child?.destroy();
    parent?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("shutdown tracks a held assignment finalization without late durable append", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "shutdown-assignment-"));
  const runtime = await mkdtemp(join(tmpdir(), "shutdown-assignment-runtime-"));
  const paths = pathsFor(root, runtime);
  let herdr!: ControlledHerdr;
  const broker = new Broker(paths, {
    herdrFactory: async (store) => (herdr = new ControlledHerdr(store)) as any,
  });
  let parent: Socket | undefined;
  let child: Socket | undefined;
  try {
    await broker.start();
    const secret = (await readFile(paths.secret, "utf8")).trim();
    parent = await connect(paths.socket, secret);
    const rootAgent = await registerParent(parent);
    const agentId = createId("agt");
    resultOf(
      await request(
        parent,
        "herdr.provision",
        await provisionParams(agentId, rootAgent.agentId),
      ),
    );
    const task = resultOf(
      await request(parent, "task.create_m3", {
        title: "held assignment",
        objective: "held assignment",
        parentAgentId: rootAgent.agentId,
        timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    child = await connect(paths.socket, secret, "pi_child", {
      kind: "agent_token",
      token: herdr.tokens.get(agentId)!,
      agentId,
      generation: 1,
      piSessionId: "shutdown-assignment-child",
    });
    resultOf(
      await request(child, "agent.register_managed", {
        agentId,
        generation: 1,
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "shutdown-assignment-child",
          terminalId: "shutdown-assignment-child",
          detectedKind: "pi",
          name: "shutdown-assignment-child",
        },
        pi: {
          sessionId: "shutdown-assignment-child",
          sessionName: "shutdown-assignment-child",
          capabilities: {},
          state: {},
        },
      }),
    );
    resultOf(
      await request(parent, "run.create", {
        taskId: task.taskId,
        agentId,
        assignmentGeneration: 1,
        piSessionId: "shutdown-assignment-child",
        terminalId: "shutdown-assignment-child",
      }),
    );
    const firstChild = child;
    const firstClosed = new Promise<void>((resolve) =>
      firstChild!.once("close", () => resolve()),
    );
    firstChild!.destroy();
    await firstClosed;
    child = await connect(paths.socket, secret, "pi_child", {
      kind: "agent_token",
      token: herdr.tokens.get(agentId)!,
      agentId,
      generation: 1,
      piSessionId: "shutdown-assignment-child",
    });
    let resolveAssignment!: () => void;
    const assignmentSent = new Promise<void>(
      (resolve) => (resolveAssignment = resolve),
    );
    let assignmentRequestId: string | undefined;
    child.on("data", (chunk) => {
      const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
      for (const item of decoder.push(chunk)) {
        if (!item.ok || item.value.type !== "server_request") continue;
        if (item.value.method === "assignment.deliver") {
          assignmentRequestId = item.value.id;
          resolveAssignment();
        }
      }
    });
    resultOf(
      await request(child, "agent.register_managed", {
        agentId,
        generation: 1,
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "shutdown-assignment-child",
          terminalId: "shutdown-assignment-child",
          detectedKind: "pi",
          name: "shutdown-assignment-child",
        },
        pi: {
          sessionId: "shutdown-assignment-child",
          sessionName: "shutdown-assignment-child",
          capabilities: {},
          state: {},
        },
      }),
    );
    await bounded(assignmentSent, "assignment was not dispatched");
    const beforeBytes = await readFile(paths.events, "utf8");
    const beforeCount = broker.store.events.length;
    assert.equal(typeof assignmentRequestId, "string");
    const secondClosed = new Promise<void>((resolve) =>
      child!.once("close", () => resolve()),
    );
    const stop = broker.stop();
    await Promise.all([stop, secondClosed]);
    const afterBytes = await readFile(paths.events, "utf8");
    assert.equal(afterBytes, beforeBytes);
    assert.equal(broker.store.events.length, beforeCount);
    const events = broker.store.events.slice(beforeCount);
    assert.equal(
      events.some((event) =>
        ["assignment.accepted", "assignment.delivery_failed"].includes(
          event.type,
        ),
      ),
      false,
    );
    await assert.rejects(access(paths.socket));
    await assert.rejects(access(paths.lock));
  } finally {
    child?.destroy();
    parent?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production shutdown rejects a dispatched timer after the boundary", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "shutdown-timer-"));
  const runtime = await mkdtemp(join(tmpdir(), "shutdown-timer-runtime-"));
  const paths = pathsFor(root, runtime);
  const base = Date.now();
  const timers = new ShutdownTimers(base);
  let releaseTimerBody!: () => void;
  timers.setBodyGate(
    new Promise<void>((resolve) => {
      releaseTimerBody = resolve;
    }),
  );
  let broker = new Broker(paths, {
    now: () => timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    herdrFactory: async (store) => new ControlledHerdr(store) as any,
  });
  let parent: Socket | undefined;
  try {
    await broker.start();
    const secret = (await readFile(paths.secret, "utf8")).trim();
    parent = await connect(paths.socket, secret);
    const rootAgent = await registerParent(parent);
    const timeoutAt = new Date(base + 60_000).toISOString();
    resultOf(
      await request(parent, "task.create_m3", {
        title: "timer one",
        objective: "timer one",
        parentAgentId: rootAgent.agentId,
        timeoutAt,
      }),
    );
    resultOf(
      await request(parent, "task.create_m3", {
        title: "timer two",
        objective: "timer two",
        parentAgentId: rootAgent.agentId,
        timeoutAt,
      }),
    );
    assert.equal(timers.activeCount(), 2);
    const beforeBytes = await readFile(paths.events, "utf8");
    const beforeCount = broker.store.events.length;
    timers.dispatchNextDue(Date.parse(timeoutAt));
    await bounded(timers.bodyStarted, "timer was not dispatched");
    assert.equal(timers.dispatchCount, 1);
    const stopOne = broker.stop();
    assert.equal(
      timers.activeCount(),
      0,
      "stop must clear undispatched timers",
    );
    releaseTimerBody();
    await stopOne;
    await nextImmediate();
    assert.equal(timers.callbackCount, 1);
    assert.equal(timers.activeCount(), 0);
    assert.equal(timers.dispatchCount, 1);
    assert.equal(await readFile(paths.events, "utf8"), beforeBytes);
    assert.equal(broker.store.events.length, beforeCount);
    assert.equal(timers.dispatchNextDue(Date.parse(timeoutAt) + 60_000), false);
    assert.equal(timers.dispatchCount, 1);
    await assert.rejects(access(paths.socket));
    await assert.rejects(access(paths.lock));
  } finally {
    parent?.destroy();
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});
