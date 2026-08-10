import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Socket } from "node:net";
import { BrokerClient } from "../../src/deck/broker-client.js";
import type { DeckSnapshot } from "../../src/deck/types.js";

class FakeSocket extends EventEmitter {
  readonly writes: Record<string, unknown>[] = [];
  destroyed = false;

  write(value: Uint8Array, callback?: (error?: Error) => void): boolean {
    const frame = JSON.parse(Buffer.from(value).toString("utf8")) as Record<
      string,
      unknown
    >;
    this.writes.push(frame);
    callback?.();
    return true;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  deliver(value: unknown): void {
    this.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  }

  close(): void {
    this.destroy();
  }
}

const asSocket = (socket: FakeSocket): Socket => socket as unknown as Socket;
const wait = (ms = 5): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const snapshot = (seq: number): DeckSnapshot => ({
  seq,
  agents: [],
  tasks: [
    {
      id: "tsk_1",
      title: "Build",
      objective: "x",
      state: "running",
      createdAt: "now",
    },
  ],
  workflows: [],
});

function hello(socket: FakeSocket, ok = true): void {
  const frame = socket.writes[0];
  socket.deliver({ type: "hello_result", id: frame?.id, ok });
}

function subscribeResult(socket: FakeSocket, value: DeckSnapshot): void {
  const request = socket.writes.find(
    (frame) => frame.type === "request" && frame.method === "events.subscribe",
  );
  socket.deliver({
    type: "response",
    id: request?.id,
    ok: true,
    result: { snapshot: value },
  });
}

test("broker client authenticates, correlates requests, and does not queue offline work", async () => {
  const sockets: FakeSocket[] = [];
  const client = new BrokerClient({
    socketPath: "/tmp/m6-client.sock",
    secret: "secret",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return asSocket(socket);
    },
    reconnectDelaysMs: [0],
  });

  await client.start();
  const socket = sockets[0]!;
  assert.equal(socket.writes[0]?.type, "hello");
  assert.deepEqual(socket.writes[0]?.auth, {
    kind: "client_secret",
    secret: "secret",
  });
  hello(socket);
  subscribeResult(socket, snapshot(3));
  await wait();
  assert.equal(client.status, "connected");

  const pending = client.request("task.list");
  const request = socket.writes.at(-1)!;
  socket.deliver({
    type: "response",
    id: "wrong-id",
    ok: true,
    result: { wrong: true },
  });
  await wait();
  socket.deliver({
    type: "response",
    id: request.id,
    ok: true,
    result: { items: [] },
  });
  assert.deepEqual(await pending, { items: [] });

  socket.close();
  await assert.rejects(
    client.request("task.list"),
    /disconnected; request was not queued/,
  );
  client.stop();
});

test("replay and stale events are applied once by sequence", async () => {
  const socket = new FakeSocket();
  const client = new BrokerClient({
    socketPath: "/tmp/m6-replay.sock",
    secret: "secret",
    socketFactory: () => asSocket(socket),
  });
  await client.start();
  hello(socket);
  subscribeResult(socket, snapshot(10));
  await wait();

  const event = {
    type: "event",
    seq: 11,
    id: "evt_11",
    event: "task.state_changed",
    refs: { taskId: "tsk_1" },
    data: { to: "blocked" },
  };
  socket.deliver(event);
  socket.deliver(event);
  socket.deliver({ ...event, seq: 10, id: "evt_old", data: { to: "failed" } });
  await wait();

  assert.equal(client.store.state.seq, 11);
  assert.equal(client.store.state.tasks.get("tsk_1")?.state, "blocked");
  assert.equal(client.store.notifications.length, 0);
  client.stop();
});

test("reconnect attempts are bounded and old sockets cannot apply events", async () => {
  const sockets: FakeSocket[] = [];
  const client = new BrokerClient({
    socketPath: "/tmp/m6-bound.sock",
    secret: "secret",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return asSocket(socket);
    },
    reconnectDelaysMs: [0, 0],
  });
  await client.start();
  hello(sockets[0]!);
  subscribeResult(sockets[0]!, snapshot(2));
  await wait();

  sockets[0]!.close();
  await wait();
  assert.equal(sockets.length, 2);
  hello(sockets[1]!, false);
  await wait();
  assert.equal(sockets.length, 3);
  hello(sockets[2]!, false);
  await wait();
  assert.equal(client.status, "disconnected");
  assert.equal(sockets.length, 3);

  sockets[0]!.deliver({
    type: "event",
    seq: 99,
    id: "stale",
    event: "task.state_changed",
    refs: { taskId: "tsk_1" },
    data: { to: "failed" },
  });
  assert.equal(client.store.state.seq, 2);
  client.stop();
});
