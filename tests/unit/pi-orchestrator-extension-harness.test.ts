import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { chmod, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NdjsonDecoder, encodeFrame } from "../../src/shared/protocol/codec.js";
import { createFakePiHarness } from "../helpers.js";

function apiFor(harness: ReturnType<typeof createFakePiHarness>) {
  const handlers = new Map<
    string,
    Array<(event: unknown, context: unknown) => void | Promise<void>>
  >();
  const tools: unknown[] = [];
  const commands: Array<{
    name: string;
    command: { handler: (...args: any[]) => unknown };
  }> = [];
  const toolWaiters = new Map<
    number,
    {
      resolve: (value: number) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const api = {
    ...harness.pi,
    on: (
      name: string,
      handler: (event: unknown, context: unknown) => void | Promise<void>,
    ) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand: (
      name: string,
      command: { handler: (...args: any[]) => unknown },
    ) => {
      commands.push({ name, command });
    },
    registerTool: (tool: unknown) => {
      tools.push(tool);
      const waiter = toolWaiters.get(tools.length);
      if (waiter) {
        toolWaiters.delete(tools.length);
        clearTimeout(waiter.timer);
        waiter.resolve(tools.length);
      }
    },
  };
  const waitForToolRegistration = (expected: number): Promise<number> => {
    if (tools.length >= expected) return Promise.resolve(tools.length);
    assert.equal(toolWaiters.has(expected), false);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        toolWaiters.delete(expected);
        reject(
          new Error(`Timed out waiting for tool registration ${expected}.`),
        );
      }, 3000);
      timer.unref?.();
      toolWaiters.set(expected, { resolve, timer });
    });
  };
  return { api, handlers, tools, commands, waitForToolRegistration };
}
async function emit(
  h: ReturnType<typeof apiFor>,
  name: string,
  context: unknown,
  event: unknown = {},
): Promise<void> {
  for (const handler of h.handlers.get(name) ?? [])
    await handler(event, context);
}

test("orchestrator extension reload transfers runtime credential and registers tools once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-orch-extension-"));
  const socketPath = join(root, "broker.sock");
  const tokenPath = join(root, "token");
  const previous = {
    herdr: process.env.HERDR_ENV,
    managed: process.env.PI_HERDR_ORCH_MANAGED,
    pane: process.env.HERDR_PANE_ID,
    bin: process.env.HERDR_BIN_PATH,
    socket: process.env.PI_HERDR_ORCH_BROKER_SOCKET,
    session: process.env.PI_HERDR_ORCH_SESSION_KEY,
    token: process.env.PI_HERDR_ORCH_TOKEN_FILE,
    agent: process.env.PI_HERDR_ORCH_AGENT_ID,
    generation: process.env.PI_HERDR_ORCH_GENERATION,
  };
  const envKeys = {
    herdr: "HERDR_ENV",
    managed: "PI_HERDR_ORCH_MANAGED",
    pane: "HERDR_PANE_ID",
    bin: "HERDR_BIN_PATH",
    socket: "PI_HERDR_ORCH_BROKER_SOCKET",
    session: "PI_HERDR_ORCH_SESSION_KEY",
    token: "PI_HERDR_ORCH_TOKEN_FILE",
    agent: "PI_HERDR_ORCH_AGENT_ID",
    generation: "PI_HERDR_ORCH_GENERATION",
  } as const;
  const connections: Socket[] = [];
  const closedSockets = new WeakSet<Socket>();
  const pendingRegistrationWrites = new Set<Socket>();
  const activeHarnesses: Array<{
    api: ReturnType<typeof apiFor>;
    context: ReturnType<typeof createFakePiHarness>["context"];
  }> = [];
  const server = createServer();
  let registrationCount = 0;
  let registrationResponseCount = 0;
  let serverFailure: Error | undefined;
  const registrationWaiters = new Map<
    number,
    {
      resolve: (value: number) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const failServer = (error: Error): void => {
    serverFailure ??= error;
    for (const waiter of registrationWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(serverFailure);
    }
    registrationWaiters.clear();
  };
  const waitForRegistrationResponse = (expected: number): Promise<number> => {
    if (serverFailure) return Promise.reject(serverFailure);
    if (registrationResponseCount >= expected)
      return Promise.resolve(registrationResponseCount);
    assert.equal(registrationWaiters.has(expected), false);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        registrationWaiters.delete(expected);
        reject(
          new Error(`Timed out waiting for registration response ${expected}.`),
        );
      }, 3000);
      timer.unref?.();
      registrationWaiters.set(expected, { resolve, reject, timer });
    });
  };
  const waitForConnectedBinding = async (): Promise<void> => {
    const key = Symbol.for("pi-herdr-orchestrator.tools.v1");
    for (let attempt = 0; attempt < 300; attempt++) {
      const binding = (globalThis as Record<PropertyKey, unknown>)[key] as
        { client?: { connected?: boolean } } | undefined;
      if (binding?.client?.connected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for the connected tool binding.");
  };
  const observeRegistrationResponse = (count: number): void => {
    if (count !== registrationResponseCount + 1) {
      failServer(new Error("Registration responses completed out of order."));
      return;
    }
    registrationResponseCount = count;
    const waiter = registrationWaiters.get(count);
    if (!waiter) return;
    registrationWaiters.delete(count);
    clearTimeout(waiter.timer);
    waiter.resolve(count);
  };
  const isClosedStream = (socket: Socket, error?: unknown): boolean => {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    return (
      closedSockets.has(socket) ||
      socket.destroyed ||
      socket.writable === false ||
      code === "EPIPE" ||
      code === "ERR_STREAM_DESTROYED"
    );
  };
  const writeResponse = (
    socket: Socket,
    frame: unknown,
    onWritten?: () => void,
  ): void => {
    if (isClosedStream(socket)) return;
    try {
      socket.write(encodeFrame(frame), (error) => {
        if (error) {
          if (!isClosedStream(socket, error)) failServer(error);
        } else onWritten?.();
      });
    } catch (error) {
      if (!isClosedStream(socket, error))
        failServer(
          error instanceof Error
            ? error
            : new Error("Test server response write failed."),
        );
    }
  };
  const shutdown = async (
    item: (typeof activeHarnesses)[number],
    reason: "reload" | "quit",
  ): Promise<void> => {
    await emit(item.api, "session_shutdown", item.context, { reason });
    const index = activeHarnesses.indexOf(item);
    if (index >= 0) activeHarnesses.splice(index, 1);
  };
  t.after(async () => {
    const errors: unknown[] = [];
    for (const item of [...activeHarnesses].reverse()) {
      try {
        await shutdown(item, "quit");
      } catch (error) {
        errors.push(error);
      }
    }
    for (const waiter of registrationWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Test teardown started before registration."));
    }
    registrationWaiters.clear();
    for (const socket of connections) {
      socket.removeAllListeners();
      socket.destroy();
    }
    pendingRegistrationWrites.clear();
    if (server.listening) {
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        errors.push(error);
      }
    }
    server.removeAllListeners();
    if (serverFailure && !errors.includes(serverFailure))
      errors.push(serverFailure);
    for (const [key, value] of Object.entries(previous)) {
      const envKey = envKeys[key as keyof typeof envKeys];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
    try {
      await unlink(tokenPath);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        errors.push(error);
    }
    try {
      await rmdir(root);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0)
      throw new AggregateError(errors, "Extension harness teardown failed.");
  });

  await writeFile(
    tokenPath,
    "managed-token-value-abcdefghijklmnopqrstuvwxyz\n",
    { mode: 0o600 },
  );
  await chmod(tokenPath, 0o600);
  server.on("error", failServer);
  server.on("connection", (socket) => {
    connections.push(socket);
    socket.on("close", () => {
      closedSockets.add(socket);
      pendingRegistrationWrites.delete(socket);
    });
    socket.on("error", (error) => {
      if (isClosedStream(socket, error)) return;
      if (pendingRegistrationWrites.has(socket)) failServer(error);
      else if (!("code" in error) || error.code !== "ECONNRESET")
        failServer(error);
    });
    const decoder = new NdjsonDecoder<unknown>((value) => value);
    socket.on("data", (data) => {
      for (const item of decoder.push(data)) {
        if (!item.ok) {
          failServer(item.error);
          socket.destroy();
          return;
        }
        if (!item.value || typeof item.value !== "object") {
          failServer(new Error("Test server received a non-object frame."));
          socket.destroy();
          return;
        }
        const frame = item.value as Record<string, unknown>;
        if (frame.type === "hello")
          writeResponse(socket, {
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
          });
        else if (frame.type === "request") {
          const count =
            frame.method === "agent.register_managed"
              ? ++registrationCount
              : registrationCount;
          if (frame.method === "agent.register_managed")
            pendingRegistrationWrites.add(socket);
          writeResponse(
            socket,
            {
              v: 1,
              type: "response",
              id: frame.id,
              method: frame.method,
              ok: true,
              result:
                frame.method === "agent.register_managed"
                  ? {
                      agentId: "agt_child",
                      generation: 1,
                      connectionGeneration: count,
                      heartbeatMs: 5000,
                      permissions: ["read:state"],
                    }
                  : {},
            },
            frame.method === "agent.register_managed"
              ? () => {
                  pendingRegistrationWrites.delete(socket);
                  observeRegistrationResponse(count);
                }
              : undefined,
          );
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
  Object.assign(process.env, {
    HERDR_ENV: "1",
    PI_HERDR_ORCH_MANAGED: "1",
    HERDR_PANE_ID: "pane",
    HERDR_BIN_PATH: "/bin/true",
    PI_HERDR_ORCH_BROKER_SOCKET: socketPath,
    PI_HERDR_ORCH_SESSION_KEY: "session-key",
    PI_HERDR_ORCH_TOKEN_FILE: tokenPath,
    PI_HERDR_ORCH_AGENT_ID: "agt_child",
    PI_HERDR_ORCH_GENERATION: "1",
  });

  const extension = (
    await import(
      `../../extensions/pi-herdr-orchestrator.js?harness=${Date.now()}`
    )
  ).default;
  const firstHarness = createFakePiHarness();
  const first = apiFor(firstHarness);
  const firstActive = { api: first, context: firstHarness.context };
  activeHarnesses.push(firstActive);
  await extension(first.api as never);
  assert.equal(await first.waitForToolRegistration(2), 2);
  assert.deepEqual(
    (first.tools as Array<{ name: string }>).map((tool) => tool.name).sort(),
    ["orchestrator_ask", "orchestrator_result"],
  );
  assert.deepEqual(
    first.commands.map((item) => item.name),
    ["agent-board", "pi-herd", "orchestrator-status"],
  );
  assert.equal(
    first.commands[0]?.command.handler,
    first.commands[1]?.command.handler,
  );
  await emit(first, "session_start", firstHarness.context);
  assert.deepEqual(firstHarness.activeTools.sort(), [
    "orchestrator_ask",
    "orchestrator_result",
    "read",
  ]);
  assert.equal(await waitForRegistrationResponse(1), 1);
  await waitForConnectedBinding();
  assert.deepEqual(firstHarness.activeTools.sort(), [
    "orchestrator_ask",
    "orchestrator_result",
    "read",
  ]);
  assert.equal(registrationCount, 1);
  await shutdown(firstActive, "reload");
  await unlink(tokenPath);
  const secondHarness = createFakePiHarness();
  const second = apiFor(secondHarness);
  const secondActive = { api: second, context: secondHarness.context };
  activeHarnesses.push(secondActive);
  await extension(second.api as never);
  assert.equal(await second.waitForToolRegistration(2), 2);
  await emit(second, "session_start", secondHarness.context);
  assert.deepEqual(secondHarness.activeTools.sort(), [
    "orchestrator_ask",
    "orchestrator_result",
    "read",
  ]);
  assert.equal(await waitForRegistrationResponse(2), 2);
  await waitForConnectedBinding();
  assert.deepEqual(secondHarness.activeTools.sort(), [
    "orchestrator_ask",
    "orchestrator_result",
    "read",
  ]);
  assert.equal(registrationCount, 2);
  assert.equal(first.tools.length, 2);
  assert.equal(second.tools.length, 2);
  assert.deepEqual(
    second.commands.map((item) => item.name),
    ["agent-board", "pi-herd", "orchestrator-status"],
  );
  assert.equal(
    second.commands[0]?.command.handler,
    second.commands[1]?.command.handler,
  );
  assert.equal(new Set(second.commands.map((item) => item.name)).size, 3);
  assert.equal(
    new Set((second.tools as Array<{ name: string }>).map((tool) => tool.name))
      .size,
    2,
  );
  assert.equal(connections[0]?.destroyed, true);
  await shutdown(secondActive, "quit");
  assert.equal(registrationCount, 2);
  assert.equal(
    (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("pi-herdr-orchestrator.credential.v1")
    ],
    undefined,
  );
});
