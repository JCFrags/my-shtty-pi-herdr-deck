import assert from "node:assert/strict";
import { createConnection, createServer, type Socket } from "node:net";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EventStore } from "../../src/state/event-store.js";
import { SnapshotStore } from "../../src/state/snapshot-store.js";
import { createId } from "../../src/shared/ids.js";
import { Broker, safeStaleSocket } from "../../src/broker/broker.js";
import { authenticate } from "../../src/broker/authentication.js";
import { sessionKey } from "../../src/shared/paths.js";

function paths(root: string) {
  return {
    root,
    runtime: join(root, "runtime"),
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(root, "broker.lock"),
    socket: join(root, "broker.sock"),
    secret: join(root, "secret"),
  };
}

type Frame = Record<string, unknown>;
class TestClient {
  readonly socket: Socket;
  #buffer = "";
  #frames: Frame[] = [];
  #waiters: Array<{
    match: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (data) => {
      this.#buffer += data.toString("utf8");
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const frame = JSON.parse(this.#buffer.slice(0, newline)) as Frame;
        this.#buffer = this.#buffer.slice(newline + 1);
        const waiter = this.#waiters.find((item) => item.match(frame));
        if (waiter) {
          clearTimeout(waiter.timer);
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        } else this.#frames.push(frame);
        newline = this.#buffer.indexOf("\n");
      }
    });
  }
  static async connect(
    broker: Broker,
    kind: "cli" | "observer" = "cli",
  ): Promise<TestClient> {
    const socket = createConnection(broker.paths.socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = new TestClient(socket);
    socket.write(
      `${JSON.stringify({
        v: 1,
        type: "hello",
        id: "hello_1",
        client: { kind, name: "test", version: "0.1.0", capabilities: [] },
        sessionKey: broker.paths.sessionKey,
        auth: { kind: "client_secret", secret: broker.secret },
      })}\n`,
    );
    const hello = await client.next((frame) => frame.type === "hello_result");
    assert.equal(hello.ok, true);
    return client;
  }
  next(match: (frame: Frame) => boolean): Promise<Frame> {
    const index = this.#frames.findIndex(match);
    if (index >= 0) return Promise.resolve(this.#frames.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((item) => item.timer === timer);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("frame timeout"));
      }, 2_000);
      this.#waiters.push({ match, resolve, reject, timer });
    });
  }
  async request(
    id: string,
    method: string,
    params: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<Frame> {
    this.socket.write(
      `${JSON.stringify({
        v: 1,
        type: "request",
        id,
        method,
        params,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      })}\n`,
    );
    return await this.next(
      (frame) => frame.type === "response" && frame.id === id,
    );
  }
  close(): void {
    this.socket.destroy();
  }
}

test("broker preserves a legacy snapshot when its persistent key is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-snapshot-legacy-"));
  const p = paths(root);
  const legacySecret = "a".repeat(43);
  await writeFile(p.secret, `${legacySecret}\n`, { mode: 0o600 });
  const state = new EventStore(p.events);
  await state.open();
  await state.append({
    type: "audit.action",
    actor: {
      principalId: "prn_00000000000000000000000000",
      kind: "system",
    },
    payload: { action: "legacy_snapshot" },
  });
  const snapshot = new SnapshotStore(p.snapshot);
  await snapshot.write(state.state, legacySecret);
  const before = await readFile(p.snapshot);

  const broker = new Broker(p);
  await broker.start();
  assert.equal(broker.store.readOnly, true);
  assert.match(
    broker.store.corruption ?? "",
    /Snapshot authentication key is missing/u,
  );
  await broker.stop();
  assert.deepEqual(await readFile(p.snapshot), before);
  await assert.rejects(lstat(join(root, "snapshot-authentication.key")), {
    code: "ENOENT",
  });
});

test("broker snapshot authentication survives runtime-secret rotation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-snapshot-restart-"));
  const runtime = join(root, "runtime");
  const p = {
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "broker.lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "client.secret"),
  };
  const first = new Broker(p);
  await first.start();
  await first.store.append({
    type: "audit.action",
    actor: {
      principalId: "prn_00000000000000000000000000",
      kind: "system",
    },
    payload: { action: "before_runtime_restart" },
  });
  const expectedSeq = first.store.state.lastEventSeq;
  const firstClientSecret = await readFile(p.secret, "utf8");
  await first.stop();
  const snapshotAuthentication = join(root, "snapshot-authentication.key");
  const retainedKey = await readFile(snapshotAuthentication, "utf8");
  assert.equal((await lstat(snapshotAuthentication)).mode & 0o777, 0o600);
  await rename(runtime, join(root, "runtime-before-restart"));

  const second = new Broker(p);
  await second.start();
  assert.equal(second.store.readOnly, false);
  assert.equal(second.store.corruption, undefined);
  assert.equal(second.store.state.lastEventSeq, expectedSeq);
  assert.notEqual(await readFile(p.secret, "utf8"), firstClientSecret);
  assert.equal(await readFile(snapshotAuthentication, "utf8"), retainedKey);
  await second.stop();
});

test("broker refuses to delete a regular socket path", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-safe-"));
  const p = paths(root);
  await writeFile(p.socket, "sentinel");
  await assert.rejects(safeStaleSocket(p.socket), /non-socket/);
  const broker = new Broker(p);
  await assert.rejects(broker.start(), /non-socket/);
  assert.equal(await lstat(p.socket).then((s) => s.isFile()), true);
});

test("event append serializes concurrent canonical mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-queue-"));
  const store = new EventStore(join(root, "events.jsonl"));
  await store.open();
  await Promise.all(
    Array.from({ length: 32 }, (_, index) => {
      const id = createId("tsk");
      return store.append({
        type: "task.created",
        actor: { principalId: "prn_00000000000000000000000001", kind: "human" },
        entityRefs: { taskId: id },
        payload: {
          id,
          title: `t${index}`,
          objective: "bounded",
          createdAt: new Date().toISOString(),
        },
      });
    }),
  );
  assert.equal(store.events.length, 32);
  assert.equal(store.verify().valid, true);
});

test("broker lock records nonce and Linux process-start identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-lock-"));
  const broker = new Broker(paths(root));
  await broker.start();
  try {
    const lock = JSON.parse(await readFile(broker.paths.lock, "utf8")) as {
      pid: number;
      nonce: string;
      startIdentity: string;
    };
    assert.equal(lock.pid, process.pid);
    assert.match(lock.nonce, /^[0-9a-f]{32}$/);
    assert.notEqual(lock.startIdentity, "unknown");
  } finally {
    await broker.stop();
  }
});

test("broker restart preserves the owner-only secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-restart-"));
  const first = new Broker(paths(root));
  await first.start();
  const secret = first.secret;
  await first.stop();
  const second = new Broker(paths(root));
  await second.start();
  assert.equal(second.secret, secret);
  await second.stop();
});

test("M3 Pi parent authentication accepts the operator secret and rejects wrong secrets", () => {
  const principal = authenticate(
    "operator-secret",
    "operator-secret",
    "pi_parent",
  );
  assert.equal(principal.kind, "pi_parent");
  assert.ok(principal.permissions.includes("delegate"));
  assert.throws(
    () => authenticate("operator-secret", "wrong-secret", "pi_parent"),
    /Client authentication failed/,
  );
});

test("M3 managed Pi authentication fails closed for wrong token, generation, or session", () => {
  const credential = {
    agentId: "agt_01J00000000000000000000000",
    generation: 2,
    tokenHash: "token-hash",
    piSessionId: "pi-session-2",
  };
  assert.throws(
    () =>
      authenticate(
        "unused",
        "wrong-token",
        "pi_child",
        credential,
        "wrong-token",
        2,
        "pi-session-2",
      ),
    /Managed agent identity is not valid/,
  );
  assert.throws(
    () =>
      authenticate(
        "unused",
        "unused",
        "pi_child",
        credential,
        "token",
        1,
        "pi-session-2",
      ),
    /Managed agent identity is not valid/,
  );
  assert.throws(
    () =>
      authenticate(
        "unused",
        "unused",
        "pi_child",
        credential,
        "token",
        2,
        "other-session",
      ),
    /Managed agent identity is not valid/,
  );
});

test("broker fails closed and audits managed Pi registration before M3", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-managed-deferred-"));
  const broker = new Broker(paths(root));
  await broker.start();
  const socket = createConnection(broker.paths.socket);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      `${JSON.stringify({
        v: 1,
        type: "hello",
        id: "managed_1",
        client: {
          kind: "pi_child",
          name: "deferred",
          version: "0.1.0",
          capabilities: [],
        },
        sessionKey: broker.paths.sessionKey,
        auth: {
          kind: "agent_token",
          token: "not-accepted-before-m3",
          agentId: createId("agt"),
          generation: 1,
          piSessionId: "pi-session",
        },
      })}\n`,
    );
    const frame = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("managed handshake timeout")),
        2_000,
      );
      socket.once("data", (data) => {
        clearTimeout(timer);
        resolve(data.toString("utf8"));
      });
      socket.once("error", reject);
    });
    assert.match(frame, /AUTH_FAILED/);
    assert.deepEqual(broker.store.events.at(-1)?.payload, {
      action: "authentication_failed_pi_child",
    });
  } finally {
    socket.destroy();
    await broker.stop();
  }
});

test("broker rejects a broker-socket hash when an explicit Herdr session key exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-session-"));
  const broker = new Broker({
    ...paths(root),
    sessionKey: "0123456789abcdef01234567",
    herdrSocket: join(root, "canonical-herdr.sock"),
  });
  await broker.start();
  const socket = createConnection(broker.paths.socket);
  const result = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("handshake timeout")),
      2_000,
    );
    socket.once("data", (data) => {
      clearTimeout(timer);
      resolve(data.toString("utf8"));
    });
    socket.once("error", reject);
  });
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      `${JSON.stringify({
        v: 1,
        type: "hello",
        id: "req_1",
        client: {
          kind: "cli",
          name: "test",
          version: "0.1.0",
          capabilities: [],
        },
        sessionKey: sessionKey(broker.paths.socket),
        auth: { kind: "client_secret", secret: broker.secret },
      })}\n`,
    );
    const frame = await result;
    assert.match(frame, /AUTH_FAILED/);
    assert.deepEqual(broker.store.events.at(-1)?.payload, {
      action: "authentication_failed_cli",
    });
    await Promise.race([
      closed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("close timeout")), 2_000),
      ),
    ]);
  } finally {
    socket.destroy();
    await broker.stop();
  }
});

test("event append rejects a forced canonical-path replacement race", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-event-race-"));
  const path = join(root, "events.jsonl");
  const displaced = join(root, "events.displaced.jsonl");
  const store = new EventStore(path, undefined, async () => {
    await rename(path, displaced);
    await writeFile(path, "", { mode: 0o600 });
    await chmod(path, 0o600);
  });
  await store.open();
  await assert.rejects(
    store.append({
      type: "audit.action",
      actor: {
        principalId: "prn_00000000000000000000000001",
        kind: "human",
      },
      payload: { action: "forced_replacement" },
    }),
    /read-only/,
  );
  assert.equal(store.state.lastEventSeq, 0);
  assert.equal(await readFile(path, "utf8"), "");
  assert.match(await readFile(displaced, "utf8"), /forced_replacement/);
});

test("event validation rejects noncanonical M1 payloads before append", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-event-schema-"));
  const store = new EventStore(join(root, "events.jsonl"));
  await store.open();
  const id = createId("tsk");
  await assert.rejects(
    store.append({
      type: "task.created",
      actor: {
        principalId: "prn_00000000000000000000000001",
        kind: "human",
      },
      entityRefs: { taskId: id },
      payload: {
        id,
        title: "invalid",
        objective: "extra key",
        createdAt: new Date().toISOString(),
        unexpected: true,
      },
    }),
    /payload is invalid/,
  );
  assert.equal(store.state.lastEventSeq, 0);
  assert.equal((await readFile(store.path, "utf8")).length, 0);
});

test("secret symlinks fail closed without changing the target", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-secret-link-"));
  const target = join(root, "target");
  const p = paths(root);
  await writeFile(target, "sentinel\n");
  await chmod(target, 0o600);
  await symlink(target, p.secret);
  const broker = new Broker(p);
  await assert.rejects(broker.start());
  assert.equal(await readFile(target, "utf8"), "sentinel\n");
  assert.equal((await lstat(p.secret)).isSymbolicLink(), true);
});

test("broker stop preserves a live replacement socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-stop-replace-"));
  const p = paths(root);
  const broker = new Broker(p);
  await broker.start();
  await unlink(p.socket);
  const replacement = createServer();
  await new Promise<void>((resolve, reject) =>
    replacement.once("error", reject).listen(p.socket, resolve),
  );
  try {
    await assert.rejects(broker.stop(), /already live|identity/);
    assert.equal((await lstat(p.socket)).isSocket(), true);
  } finally {
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
    await unlink(p.socket).catch(() => undefined);
  }
});

test("task idempotency, subscriptions, and authorization survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-api-"));
  const p = paths(root);
  const first = new Broker(p);
  await first.start();
  const operator = await TestClient.connect(first);
  const observer = await TestClient.connect(first, "observer");
  const key = "retry-key";
  const created = await operator.request(
    "create_1",
    "task.create",
    { title: "one", objective: "durable" },
    key,
  );
  assert.equal(created.ok, true);
  const result = created.result as { taskId: string; state: string };
  const seq = first.store.state.lastEventSeq;
  const retried = await operator.request(
    "create_2",
    "task.create",
    { title: "one", objective: "durable" },
    key,
  );
  assert.deepEqual(retried.result, result);
  assert.equal(first.store.state.lastEventSeq, seq);
  const conflict = await operator.request(
    "create_3",
    "task.create",
    { title: "different", objective: "durable" },
    key,
  );
  assert.equal(
    (conflict.error as { code: string }).code,
    "IDEMPOTENCY_CONFLICT",
  );

  const denied = await observer.request("deny_1", "task.create", {
    title: "denied",
    objective: "no permission",
  });
  assert.equal((denied.error as { code: string }).code, "PERMISSION_DENIED");
  assert.equal(first.store.events.at(-1)?.type, "audit.authorization_denied");

  const subscribed = await operator.request("sub_1", "events.subscribe", {
    fromSeq: 0,
    includeSnapshot: false,
    filters: { events: ["task.*"] },
  });
  assert.equal(subscribed.ok, true);
  const subscription = (subscribed.result as { subscriptionId: string })
    .subscriptionId;
  assert.match(subscription, /^sub_[0-9A-HJKMNP-TV-Z]{26}$/);
  const replay = await operator.next(
    (frame) => frame.type === "event" && frame.event === "task.created",
  );
  assert.equal((replay.refs as { taskId: string }).taskId, result.taskId);
  const invalidCursor = await operator.request("sub_2", "events.subscribe", {
    fromSeq: 999_999,
  });
  assert.equal(
    (invalidCursor.error as { code: string }).code,
    "CURSOR_INVALID",
  );
  const wrongUnsubscribe = await operator.request(
    "unsub_1",
    "events.unsubscribe",
    { subscriptionId: "sub_00000000000000000000000000" },
  );
  assert.equal(wrongUnsubscribe.ok, false);
  const unsubscribed = await operator.request("unsub_2", "events.unsubscribe", {
    subscriptionId: subscription,
  });
  assert.equal(unsubscribed.ok, true);

  operator.close();
  observer.close();
  await first.stop();
  const second = new Broker(p);
  await second.start();
  const afterRestart = await TestClient.connect(second);
  try {
    const retriedAfterRestart = await afterRestart.request(
      "create_4",
      "task.create",
      { title: "one", objective: "durable" },
      key,
    );
    assert.deepEqual(retriedAfterRestart.result, result);
    const fetched = await afterRestart.request("get_1", "task.get", {
      taskId: result.taskId,
    });
    assert.equal((fetched.result as { id: string }).id, result.taskId);
  } finally {
    afterRestart.close();
    await second.stop();
  }
});
