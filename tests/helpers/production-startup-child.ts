import assert from "node:assert/strict";
import { link, lstat, open, readFile, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ensureBroker,
  brokerStatus,
  stopBroker,
  linuxProcessStart,
} from "../../src/broker/startup.js";
import { PARENT_TOOL_NAMES } from "../../src/pi/parent-tool-schema.js";
import { createFakePiHarness } from "../helpers.js";
import piHerdrOrchestrator from "../../extensions/pi-herdr-orchestrator.js";
import { PiBrokerClient } from "../../src/pi/broker-client.js";
import { resolvePaths } from "../../src/shared/paths.js";

function finiteReceipt<T>(label: string): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  let timer: NodeJS.Timeout;
  const promise = new Promise<T>((accept, reject) => {
    resolve = (value) => {
      clearTimeout(timer);
      accept(value);
    };
    timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label}.`)),
      15_000,
    );
    timer.unref?.();
  });
  return { promise, resolve };
}

async function starter(): Promise<void> {
  const paths = await ensureBroker();
  const pid = JSON.parse(await readFile(paths.pid, "utf8")) as {
    pid: number;
    startIdentity: string;
    sessionKey: string;
  };
  assert.equal(pid.sessionKey, paths.sessionKey);
  process.stdout.write(
    `${JSON.stringify({
      event: "starter-ready",
      pid: pid.pid,
      startIdentity: pid.startIdentity,
      sessionKey: paths.sessionKey,
      runtime: paths.runtime,
    })}\n`,
  );
}

async function crashStartupPublisher(): Promise<void> {
  const herdrSocket = process.env.HERDR_SOCKET_PATH;
  assert.ok(herdrSocket);
  const paths = resolvePaths(herdrSocket);
  const commandPath = fileURLToPath(
    new URL("../../../bin/pi-herdr-orchestrator", import.meta.url),
  );
  assert.equal(await realpath(commandPath), commandPath);
  const command = await lstat(commandPath);
  const startIdentity = linuxProcessStart(process.pid);
  assert.ok(startIdentity);
  const nonce = randomBytes(16).toString("hex");
  const companion = `${paths.startup}.create.${nonce}`;
  const record = {
    version: 1,
    nonce,
    pid: process.pid,
    startIdentity,
    sessionKey: paths.sessionKey,
    brokerSocket: paths.socket,
    commandPath,
    commandDev: command.dev,
    commandIno: command.ino,
  };
  const handle = await open(companion, "wx", 0o600);
  await handle.writeFile(`${JSON.stringify(record)}\n`);
  await handle.sync();
  await handle.close();
  await link(companion, paths.startup);
  process.stdout.write(
    `${JSON.stringify({
      event: "startup-publisher-crashed",
      pid: process.pid,
      startIdentity,
      companion,
      record,
    })}\n`,
    () => process.exit(86),
  );
}

async function extensionClient(): Promise<void> {
  const before = await brokerStatus();
  assert.equal(before.status, "running");
  const herdrSocket = process.env.HERDR_SOCKET_PATH;
  assert.ok(herdrSocket);
  const resolved = resolvePaths(herdrSocket);
  const harness = createFakePiHarness();
  const handlers = new Map<
    string,
    Array<(event: unknown, context: unknown) => void | Promise<void>>
  >();
  const tools = new Map<
    string,
    {
      execute(
        id: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
      ): Promise<{ isError?: boolean; details?: unknown; content?: unknown }>;
    }
  >();
  const entries: Array<{ type: string; data: unknown }> = [];
  const connected = finiteReceipt<string>("adopted extension registration");
  harness.context.ui.setStatus = (_key, value) => {
    if (value === "Adopted Pi connected") connected.resolve(value);
  };
  const api = {
    ...harness.pi,
    on: (
      name: string,
      handler: (event: unknown, context: unknown) => void | Promise<void>,
    ) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: () => undefined,
    registerTool: (tool: {
      name: string;
      execute(
        id: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
      ): Promise<{ isError?: boolean; details?: unknown; content?: unknown }>;
    }) => tools.set(tool.name, tool),
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
  };
  await piHerdrOrchestrator(api as never);
  for (const handler of handlers.get("session_start") ?? [])
    await handler({}, harness.context);
  await connected.promise;
  assert.deepEqual(new Set(tools.keys()), new Set(PARENT_TOOL_NAMES));
  assert.equal(tools.size, PARENT_TOOL_NAMES.length);
  assert.equal(
    entries.some((entry) => entry.type === "pi-herdr-orchestrator-adopted"),
    false,
  );

  const spawn = tools.get("agent_spawn");
  assert.ok(spawn);
  const spawnResult = await spawn.execute(
    "production-managed-spawn",
    {
      task: { title: "managed production proof", objective: "register once" },
      profileId: "scout",
      project: { cwd: process.cwd() },
      isolation: { mode: "shared-readonly" },
      budget: { wallTimeMs: 60_000 },
      wait: false,
    },
    new AbortController().signal,
  );
  assert.notEqual(spawnResult.isError, true, JSON.stringify(spawnResult));
  const fakeStatePath = process.env.HERDR_CONFIG_PATH;
  assert.ok(fakeStatePath);
  const fakeState = JSON.parse(await readFile(fakeStatePath, "utf8")) as {
    provisions: Array<{
      env: Record<string, string>;
      agentId: string;
      paneId: string;
      terminalId: string;
      sessionId: string;
    }>;
  };
  assert.equal(fakeState.provisions.length, 1);
  const provision = fakeState.provisions[0]!;
  assert.equal(provision.env.PI_HERDR_ORCH_BROKER_SOCKET, resolved.socket);
  assert.equal(provision.env.PI_HERDR_ORCH_SESSION_KEY, before.sessionKey);
  assert.equal("PI_HERDR_ORCH_AGENT_TOKEN" in provision.env, false);
  assert.equal(
    Object.keys(provision.env).some((key) => /secret/iu.test(key)),
    false,
  );
  const tokenFile = provision.env.PI_HERDR_ORCH_TOKEN_FILE;
  assert.ok(tokenFile);
  const token = (await readFile(tokenFile, "utf8")).trim();
  process.env.HERDR_PANE_ID = provision.paneId;
  process.env.HERDR_TERMINAL_ID = provision.terminalId;
  const managed = new PiBrokerClient({
    socketPath: provision.env.PI_HERDR_ORCH_BROKER_SOCKET!,
    sessionKey: provision.env.PI_HERDR_ORCH_SESSION_KEY!,
    agentId: provision.agentId,
    generation: 1,
    piSessionId: provision.sessionId,
    token,
  });
  await managed.connect();
  const registered = await managed.register({
    agentId: provision.agentId,
    generation: 1,
    sessionId: provision.sessionId,
    idle: true,
    pendingMessages: 0,
    activity: "idle",
    activeTools: [],
    capabilities: {
      core: true,
      prompt: true,
      steer: true,
      followUp: true,
      abort: true,
      compact: true,
      model: true,
      thinking: true,
      tools: true,
      toolExpansion: true,
    },
  });
  assert.equal(registered.agentId, provision.agentId);
  assert.equal(registered.generation, 1);
  await managed.close();
  const wrongSession = new PiBrokerClient({
    socketPath: provision.env.PI_HERDR_ORCH_BROKER_SOCKET!,
    sessionKey: `${provision.env.PI_HERDR_ORCH_SESSION_KEY!.startsWith("0") ? "1" : "0"}${provision.env.PI_HERDR_ORCH_SESSION_KEY!.slice(1)}`,
    agentId: provision.agentId,
    generation: 1,
    piSessionId: provision.sessionId,
    token,
  });
  await assert.rejects(
    wrongSession.connect(),
    (error: unknown) =>
      error instanceof Error && error.message === "BROKER_SOCKET_ERROR",
  );
  assert.equal(wrongSession.connected, false);
  process.env.HERDR_PANE_ID = "pane-root";
  process.env.HERDR_TERMINAL_ID = "terminal-root";

  for (const handler of handlers.get("session_shutdown") ?? [])
    await handler({ reason: "quit" }, harness.context);
  const stopped = await stopBroker();
  assert.equal(stopped, "stopped");
  process.stdout.write(
    `${JSON.stringify({
      event: "extension-stopped",
      tools: tools.size,
      adopted: true,
      managedRegistered: true,
      sessionKey: before.sessionKey,
    })}\n`,
  );
}

const action = process.argv[2];
if (action === "starter") await starter();
else if (action === "crash-startup-publisher") await crashStartupPublisher();
else if (action === "extension") await extensionClient();
else throw new Error("Unknown production startup child action.");
