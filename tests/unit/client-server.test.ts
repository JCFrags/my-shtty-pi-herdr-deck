import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeClient, BridgeDisconnectedError } from "../../src/bridge/client.js";
import { BridgeServer, CompatibilityRejectionServer } from "../../src/bridge/server.js";
import { encodeFrame, NdjsonDecoder, PROTOCOL_VERSION, type ServerFrame, validateServerFrame } from "../../src/bridge/protocol.js";
import { baseState, FakeController, waitFor } from "../helpers.js";

async function temporaryRuntime(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "pi-deck-client-"));
}

async function readFrames(socket: Socket, count: number): Promise<ServerFrame[]> {
  const decoder = new NdjsonDecoder(validateServerFrame);
  return await new Promise<ServerFrame[]>((resolve, reject) => {
    const frames: ServerFrame[] = [];
    const onData = (chunk: Buffer | string): void => {
      for (const item of decoder.push(chunk)) {
        if (item.ok) frames.push(item.value);
        else reject(item.error);
      }
      if (frames.length >= count) {
        socket.off("data", onData);
        resolve(frames);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

test("client receives hello then initial state and sends commands", async () => {
  const controller = new FakeController();
  const server = new BridgeServer({ controller, runtimeDirectory: await temporaryRuntime(), statePushIntervalMs: 5 });
  await server.start();
  const client = new BridgeClient({ socketPath: server.socketPath, reconnectDelaysMs: [10] });
  client.start();
  await waitFor(() => client.connected && Boolean(client.state));
  assert.equal(client.status.kind, "connected");
  assert.equal(client.state?.sessionId, "session-1");
  await client.send("refreshState", {});
  assert.equal(controller.commands.at(-1)?.name, "refreshState");
  client.stop();
  await server.close();
});

test("client ignores stale state sequence frames", async () => {
  const runtime = await temporaryRuntime();
  const path = join(runtime, "fake.sock");
  const server = createServer((socket) => {
    socket.write(encodeFrame({
      v: PROTOCOL_VERSION,
      type: "hello",
      seq: 1,
      payload: {
        accepted: true,
        controller: true,
        readOnly: false,
        paneId: "pane",
        capabilities: { mouse: true, perToolExpansion: true, bulkToolExpansion: true, expansionSubscription: true },
      },
    }));
    socket.write(encodeFrame({ v: PROTOCOL_VERSION, type: "state", seq: 3, payload: baseState({ sessionId: "new" }) }));
    socket.write(encodeFrame({ v: PROTOCOL_VERSION, type: "state", seq: 2, payload: baseState({ sessionId: "stale" }) }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const client = new BridgeClient({ socketPath: path, reconnectDelaysMs: [10] });
  client.start();
  await waitFor(() => client.state?.sessionId === "new");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client.state?.sessionId, "new");
  client.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("a second client is explicitly rejected while one controller is attached", async () => {
  const server = new BridgeServer({ controller: new FakeController(), runtimeDirectory: await temporaryRuntime() });
  await server.start();
  const first = new BridgeClient({ socketPath: server.socketPath, reconnectDelaysMs: [10] });
  const second = new BridgeClient({ socketPath: server.socketPath, reconnectDelaysMs: [10] });
  first.start();
  await waitFor(() => first.connected);
  second.start();
  await waitFor(() => second.status.kind === "disconnected" && second.status.reason.includes("already attached"));
  assert.equal(first.connected, true);
  assert.equal(second.connected, false);
  first.stop();
  second.stop();
  await server.close();
});

test("malformed commands receive errors and do not terminate the server", async () => {
  const server = new BridgeServer({ controller: new FakeController(), runtimeDirectory: await temporaryRuntime() });
  await server.start();
  const socket = createConnection(server.socketPath);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const initial = await readFrames(socket, 2);
  assert.deepEqual(initial.map((frame) => frame.type), ["hello", "state"]);
  socket.write("{bad-json}\n");
  const malformed = await readFrames(socket, 1);
  assert.equal(malformed[0]?.type, "result");
  if (malformed[0]?.type === "result") assert.equal(malformed[0].ok, false);
  socket.write(encodeFrame({ type: "command", id: "ok", name: "refreshState", args: {} }));
  const after = await readFrames(socket, 2);
  assert.ok(after.some((frame) => frame.type === "result" && frame.id === "ok" && frame.ok));
  assert.ok(after.some((frame) => frame.type === "state"));
  socket.destroy();
  await server.close();
});

test("client reconnects with bounded backoff and never queues commands while disconnected", async () => {
  const runtime = await temporaryRuntime();
  const path = join(runtime, "late.sock");
  const client = new BridgeClient({ socketPath: path, reconnectDelaysMs: [10, 20, 30, 40] });
  client.start();
  await assert.rejects(client.send("abort", {}), (error: unknown) => error instanceof BridgeDisconnectedError && /not queued/.test(error.message));
  await new Promise((resolve) => setTimeout(resolve, 15));
  const raw = createServer((socket) => {
    socket.write(encodeFrame({
      v: PROTOCOL_VERSION,
      type: "hello",
      seq: 1,
      payload: {
        accepted: true,
        controller: true,
        readOnly: false,
        paneId: "late",
        capabilities: { mouse: true, perToolExpansion: true, bulkToolExpansion: true, expansionSubscription: true },
      },
    }));
    socket.write(encodeFrame({ v: PROTOCOL_VERSION, type: "state", seq: 2, payload: baseState({ herdrPaneId: "late" }) }));
  });
  await new Promise<void>((resolve, reject) => { raw.once("error", reject); raw.listen(path, resolve); });
  await waitFor(() => client.connected, 2000);
  assert.equal(client.state?.herdrPaneId, "late");
  client.stop();
  await new Promise<void>((resolve) => raw.close(() => resolve()));
});


test("compatibility endpoint rejects once with the shared explicit message", async () => {
  const reason = "Pi Deck requires Pi with component mouse events, per-tool expansion state and bulk selectors, and expansion-change subscription. The installed Pi API is incompatible.";
  const server = new CompatibilityRejectionServer({ paneId: "incompatible", reason, runtimeDirectory: await temporaryRuntime() });
  await server.start();
  const client = new BridgeClient({ socketPath: server.socketPath, reconnectDelaysMs: [10, 20] });
  client.start();
  await waitFor(() => client.status.kind === "disconnected" && client.status.reason === reason);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.status.kind, "disconnected");
  assert.equal(client.status.reason, reason);
  client.stop();
  await server.close();
});

test("an invalid Pi snapshot closes only the client connection and logs a concise diagnostic", async () => {
  const controller = new FakeController();
  controller.snapshot = () => { throw new Error("invalid snapshot"); };
  const diagnostics: string[] = [];
  const server = new BridgeServer({
    controller,
    runtimeDirectory: await temporaryRuntime(),
    log: (message) => diagnostics.push(message),
  });
  await server.start();
  const socket = createConnection(server.socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("close", resolve);
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET") resolve();
      else reject(error);
    });
  });
  assert.ok(diagnostics.some((message) => message === "initial Pi state snapshot failed: invalid snapshot"));
  assert.equal(server.started, true);
  await server.close();
});
