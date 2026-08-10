import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtemp, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EventStore } from "../../src/state/event-store.js";
import { createId } from "../../src/shared/ids.js";
import { Broker, safeStaleSocket } from "../../src/broker/broker.js";

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
        actor: { principalId: "prn_test", kind: "human" },
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

test("broker rejects a mismatched session key at the authenticated boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-session-"));
  const broker = new Broker(paths(root));
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
        sessionKey: "wrong",
        auth: { kind: "client_secret", secret: broker.secret },
      })}\n`,
    );
    const frame = await result;
    assert.match(frame, /AUTH_FAILED/);
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
