import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NdjsonDecoder, encodeFrame } from "../../src/shared/protocol/codec.js";
import {
  TERMINAL_RESULT_MESSAGE_TYPE,
  TERMINAL_RESULT_STATE_TYPE,
} from "../../src/pi/terminal-result-delivery.js";
import { createFakePiHarness, waitFor } from "../helpers.js";

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("parent extension wakes on terminal result and replays a disconnected suffix", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-terminal-extension-"));
  const socketPath = join(root, "broker.sock");
  const tokenPath = join(root, "token");
  const previous = new Map<string, string | undefined>();
  for (const key of [
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "PI_HERDR_ORCH_MANAGED",
    "PI_HERDR_ORCH_BROKER_SOCKET",
    "PI_HERDR_ORCH_SESSION_KEY",
    "PI_HERDR_ORCH_TOKEN_FILE",
    "PI_HERDR_ORCH_AGENT_ID",
    "PI_HERDR_ORCH_GENERATION",
  ])
    previous.set(key, process.env[key]);

  await writeFile(
    tokenPath,
    "managed-token-value-abcdefghijklmnopqrstuvwxyz\n",
    {
      mode: 0o600,
    },
  );
  const sockets: Socket[] = [];
  const subscriptions: number[] = [];
  const tasks = new Map<string, Record<string, unknown>>();
  let brokerHead = 10;
  let activeSocket: Socket | undefined;
  const server = createServer((socket) => {
    sockets.push(socket);
    activeSocket = socket;
    const decoder = new NdjsonDecoder<unknown>((value) => value);
    socket.on("data", (data) => {
      for (const decoded of decoder.push(data)) {
        if (!decoded.ok) throw decoded.error;
        const frame = decoded.value as Record<string, unknown>;
        if (frame.type === "hello") {
          socket.write(
            encodeFrame({
              v: 1,
              type: "hello_result",
              id: frame.id,
              ok: true,
              broker: {
                version: "test",
                status: "healthy",
                lastEventSeq: brokerHead,
              },
              principal: {
                id: "prn_parent",
                kind: "pi_child",
                permissions: ["read:state", "delegate"],
                agentId: "agt_parent",
                generation: 1,
                piSessionId: "session-1",
              },
              limits: { maxLineBytes: 1_048_576 },
            }),
          );
          continue;
        }
        if (frame.type !== "request") continue;
        const method = String(frame.method);
        let result: unknown = {};
        if (method === "agent.register_managed")
          result = {
            agentId: "agt_parent",
            generation: 1,
            connectionGeneration: sockets.length,
            heartbeatMs: 100,
            permissions: ["read:state", "delegate"],
          };
        else if (method === "events.subscribe") {
          const params = frame.params as Record<string, unknown>;
          subscriptions.push(Number(params.fromSeq));
          result = { subscriptionId: `sub_${subscriptions.length}` };
        } else if (method === "task.get") {
          const params = frame.params as Record<string, unknown>;
          result = tasks.get(String(params.taskId));
        }
        socket.write(
          encodeFrame({
            v: 1,
            type: "response",
            id: frame.id,
            method,
            ok: true,
            result,
          }),
        );
      }
    });
    socket.on("error", () => undefined);
  });

  const harness = createFakePiHarness();
  const handlers = new Map<
    string,
    Array<(event: unknown, context: unknown) => void | Promise<void>>
  >();
  const sessionEntries: Record<string, unknown>[] = [];
  const messages: Array<{
    message: Record<string, unknown>;
    options: Record<string, unknown>;
  }> = [];
  harness.context.sessionManager.getEntries = () => sessionEntries;
  const api = {
    ...harness.pi,
    on: (
      name: string,
      handler: (event: unknown, context: unknown) => void | Promise<void>,
    ) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: () => undefined,
    registerTool: () => undefined,
    appendEntry: (customType: string, data: unknown) => {
      sessionEntries.push({ type: "custom", customType, data });
    },
    sendMessage: (
      message: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => {
      messages.push({ message, options });
      sessionEntries.push({ type: "custom_message", ...message });
    },
  };

  const emit = async (name: string, event: unknown): Promise<void> => {
    for (const handler of handlers.get(name) ?? [])
      await handler(event, harness.context);
  };
  const sendEvent = (
    seq: number,
    taskId: string,
    state: string,
    socket = activeSocket,
  ): void => {
    socket?.write(
      encodeFrame({
        v: 1,
        type: "event",
        seq,
        id: `evt_${seq}`,
        event: "task.state_changed",
        timestamp: "2026-08-27T00:00:00.000Z",
        refs: { taskId },
        data: { to: state },
      }),
    );
  };

  t.after(async () => {
    for (const handler of handlers.get("session_shutdown") ?? [])
      await handler({ reason: "quit" }, harness.context);
    for (const socket of sockets) socket.destroy();
    await close(server);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  await listen(server, socketPath);
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "pane-parent",
    PI_HERDR_ORCH_MANAGED: "1",
    PI_HERDR_ORCH_BROKER_SOCKET: socketPath,
    PI_HERDR_ORCH_SESSION_KEY: "session-key",
    PI_HERDR_ORCH_TOKEN_FILE: tokenPath,
    PI_HERDR_ORCH_AGENT_ID: "agt_parent",
    PI_HERDR_ORCH_GENERATION: "1",
  });
  const extension = (
    await import(
      `../../extensions/pi-herdr-orchestrator.js?terminal=${Date.now()}`
    )
  ).default;
  await extension(api as never);
  await emit("session_start", {});
  await waitFor(() => subscriptions.length === 1);
  assert.deepEqual(subscriptions, [10]);

  tasks.set("tsk_first", {
    id: "tsk_first",
    title: "First result",
    parentAgentId: "agt_parent",
    state: "succeeded",
    resultId: "res_first",
  });
  sendEvent(11, "tsk_first", "blocked");
  sendEvent(12, "tsk_first", "succeeded");
  await waitFor(() => messages.length === 1);
  assert.equal(messages[0]?.message.customType, TERMINAL_RESULT_MESSAGE_TYPE);
  assert.deepEqual(messages[0]?.options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
  assert.equal(
    sessionEntries.some(
      (entry) => entry.customType === TERMINAL_RESULT_STATE_TYPE,
    ),
    true,
  );

  brokerHead = 13;
  tasks.set("tsk_missed", {
    id: "tsk_missed",
    title: "Missed while disconnected",
    parentAgentId: "agt_parent",
    state: "succeeded",
    resultId: "res_missed",
  });
  activeSocket?.destroy();
  await waitFor(() => subscriptions.length === 2, 5_000);
  assert.equal(subscriptions[1], 12);
  sendEvent(13, "tsk_missed", "succeeded");
  await waitFor(() => messages.length === 2);
  assert.equal(
    (messages[1]?.message.details as Record<string, unknown>).resultId,
    "res_missed",
  );
});
