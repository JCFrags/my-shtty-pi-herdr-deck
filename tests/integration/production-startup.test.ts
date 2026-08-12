import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  readFileSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveHerdrPaths,
  resolvePaths,
  sessionKey,
} from "../../src/shared/paths.js";
import { ensureBroker, linuxProcessStart } from "../../src/broker/startup.js";
import { Broker } from "../../src/broker/broker.js";
import { createProductionHerdrService } from "../../src/herdr/service.js";

const root = process.cwd();

function fakeHerdrProgram(): string {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const path = process.env.HERDR_CONFIG_PATH;
if (!path) throw new Error("missing fake state");
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
const command = args.slice(0, 2).join(" ");
const option = (name) => args[args.indexOf(name) + 1];
if (command === "api schema") console.log(JSON.stringify(state.schema));
else if (command === "api snapshot") console.log(JSON.stringify({ id: "cli:api:snapshot", result: { type: "session_snapshot", snapshot: state.snapshot } }));
else if (command === "tab create") {
  const index = state.provisions.length + 1;
  const paneId = "pane-managed-" + index;
  const terminalId = "terminal-managed-" + index;
  const tabId = "tab-managed-" + index;
  const env = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--env") continue;
    const value = args[++i];
    const split = value.indexOf("=");
    env[value.slice(0, split)] = value.slice(split + 1);
  }
  const agentId = env.PI_HERDR_ORCH_AGENT_ID;
  const sessionId = "session-" + agentId;
  state.provisions.push({ env, agentId, paneId, terminalId, sessionId, tabArgs: args });
  state.snapshot.tabs.push({ id: tabId, workspaceId: option("--workspace"), cwd: option("--cwd") });
  state.snapshot.panes.push({ id: paneId, terminalId, workspaceId: option("--workspace"), tabId, cwd: option("--cwd") });
  console.log(JSON.stringify({ id: "cli:tab:create", result: { type: "tab_created", tab: { tab_id: tabId }, root_pane: { pane_id: paneId } } }));
} else if (command === "agent start") {
  const paneId = option("--pane");
  const provision = state.provisions.find((item) => item.paneId === paneId);
  if (!provision) throw new Error("unknown managed pane");
  provision.agentArgs = args;
  const pane = state.snapshot.panes.find((item) => item.id === paneId);
  pane.occupant = { kind: "pi", terminalId: provision.terminalId, sessionId: provision.sessionId, generation: 1 };
  state.snapshot.agents.push({
    agentId: provision.agentId,
    paneId,
    terminalId: provision.terminalId,
    workspaceId: pane.workspaceId,
    tabId: pane.tabId,
    kind: "pi",
    sessionReference: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: provision.sessionId,
    },
  });
  console.log(JSON.stringify({ id: "cli:agent:start", result: { type: "agent_started", agent: { pane_id: paneId } } }));
} else { console.error("unsupported fake Herdr command"); process.exitCode = 31; }
writeFileSync(path, JSON.stringify(state));
`;
}

function heldHerdrProgram(): string {
  return `#!/usr/bin/env node
import { createConnection } from "node:net";
const receiptPath = process.env.HERDR_CONFIG_PATH;
if (!receiptPath) throw new Error("missing held receipt socket");
const socket = createConnection(receiptPath);
socket.once("connect", () => {
  socket.write(JSON.stringify({ event: "schema-held", pid: process.pid }) + "\\n");
});
let pending = "";
socket.on("data", (chunk) => {
  pending += chunk.toString("utf8");
  if (pending.includes("release\\n")) socket.end(() => process.exit(0));
});
`;
}

function runChild(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...argv], {
      cwd: root,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Child timed out: ${argv.at(-1) ?? "unknown"}`));
    }, 30_000);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? 1,
      });
    });
  });
}

function mode(value: number): number {
  return value & 0o777;
}

async function waitExactProcessGone(
  pid: number,
  startIdentity: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (linuxProcessStart(pid) === startIdentity) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for exact test process exit.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function terminateExactTestProcess(identity: {
  pid: number;
  startIdentity: string;
}): Promise<void> {
  if (linuxProcessStart(identity.pid) !== identity.startIdentity) return;
  try {
    process.kill(identity.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await waitExactProcessGone(identity.pid, identity.startIdentity);
}

async function collectTerminalOutcome(
  primary: unknown,
  actions: Array<() => void | Promise<void>>,
  message: string,
): Promise<void> {
  const teardownErrors: unknown[] = [];
  for (const action of actions)
    try {
      await action();
    } catch (error) {
      teardownErrors.push(error);
    }
  if (primary !== undefined && teardownErrors.length)
    throw new AggregateError([primary, ...teardownErrors], message);
  if (primary !== undefined) throw primary;
  if (teardownErrors.length === 1) throw teardownErrors[0];
  if (teardownErrors.length > 1)
    throw new AggregateError(teardownErrors, message);
}

async function missing(path: string): Promise<void> {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

async function noStartupLinks(runtime: string): Promise<void> {
  assert.deepEqual(
    (await readdir(runtime)).filter((name) => name.startsWith("startup.lock")),
    [],
  );
}

test("built separate processes start, reuse, adopt, expose tools, and stop the packaged broker", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "orch-production-startup-"));
  const herdrSocket = join(temporary, "herdr.sock");
  const fakeBinary = join(temporary, "fake-herdr.mjs");
  const fakeState = join(temporary, "fake-herdr-state.json");
  const runtimeBase = join(temporary, "runtime");
  const stateBase = join(temporary, "state");
  const fixture = {
    methods: [
      "session.snapshot",
      "events.subscribe",
      "workspace.list",
      "workspace.get",
      "workspace.focus",
      "workspace.close",
      "tab.create",
      "tab.get",
      "tab.close",
      "pane.list",
      "pane.get",
      "pane.focus",
      "pane.close",
      "agent.list",
      "agent.get",
      "agent.start",
      "agent.focus",
      "worktree.list",
      "worktree.create",
      "worktree.open",
      "worktree.remove",
    ],
  };
  const snapshot = {
    workspaces: [{ id: "workspace-root", cwd: root }],
    tabs: [
      {
        id: "tab-root",
        workspaceId: "workspace-root",
        cwd: root,
      },
    ],
    panes: [
      {
        id: "pane-root",
        terminalId: "terminal-root",
        workspaceId: "workspace-root",
        tabId: "tab-root",
        cwd: root,
        occupant: {
          kind: "pi",
          terminalId: "terminal-root",
          sessionId: "session-1",
          generation: 1,
        },
      },
    ],
    agents: [
      {
        agentId: "agent-root",
        paneId: "pane-root",
        terminalId: "terminal-root",
        workspaceId: "workspace-root",
        tabId: "tab-root",
        kind: "pi",
        sessionReference: {
          source: "herdr:pi",
          agent: "pi",
          kind: "path",
          value: "/tmp/session.jsonl",
        },
      },
    ],
    worktrees: [],
  };
  await writeFile(fakeBinary, fakeHerdrProgram(), { mode: 0o700 });
  await writeFile(
    fakeState,
    JSON.stringify({ schema: fixture, snapshot, calls: [], provisions: [] }),
    { mode: 0o600 },
  );

  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.type === "hello")
          socket.write(`${JSON.stringify({ id: frame.id, ok: true })}\n`);
        else if (frame.method === "session.snapshot")
          socket.write(
            `${JSON.stringify({ id: frame.id, ok: true, result: snapshot })}\n`,
          );
        else if (frame.method === "events.subscribe")
          socket.write(
            `${JSON.stringify({ id: frame.id, ok: true, result: {} })}\n`,
          );
      }
    });
    socket.once("close", () => connections.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(herdrSocket, resolve);
  });
  await chmod(herdrSocket, 0o600);

  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: "C.UTF-8",
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: herdrSocket,
    HERDR_BIN_PATH: fakeBinary,
    HERDR_CONFIG_PATH: fakeState,
    HERDR_PANE_ID: "pane-root",
    HERDR_TERMINAL_ID: "terminal-root",
    HERDR_WORKSPACE_ID: "workspace-root",
    HERDR_TAB_ID: "tab-root",
    PI_HERDR_ORCH_RUNTIME_ROOT: runtimeBase,
    PI_HERDR_ORCH_STATE_ROOT: stateBase,
  };
  const childModule = join(
    root,
    "dist",
    "tests",
    "helpers",
    "production-startup-child.js",
  );
  const key = sessionKey(herdrSocket);
  const paths = {
    ...resolvePaths(herdrSocket),
    root: join(stateBase, key),
    runtime: join(runtimeBase, key),
    events: join(stateBase, key, "events-v1.jsonl"),
    snapshot: join(stateBase, key, "snapshot-v1.json"),
    lock: join(runtimeBase, key, "broker.lock"),
    startup: join(runtimeBase, key, "startup.lock"),
    pid: join(runtimeBase, key, "broker.pid"),
    socket: join(runtimeBase, key, "broker.sock"),
    secret: join(runtimeBase, key, "client.secret"),
    log: join(runtimeBase, key, "broker.log"),
  };
  let stopped = false;
  t.after(async () => {
    const errors: unknown[] = [];
    if (!stopped) {
      const result = await runChild(
        [join(root, "bin", "pi-herdr-orchestrator"), "broker", "stop"],
        environment,
      );
      if (result.code !== 0) errors.push(new Error(result.stderr));
    }
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ).catch((error) => errors.push(error));
    await rm(temporary, { recursive: true, force: true }).catch((error) =>
      errors.push(error),
    );
    if (errors.length)
      throw new AggregateError(errors, "Production startup teardown failed.");
  });

  const [startupHook, started, concurrent] = await Promise.all([
    runChild(
      [join(root, "bin", "pi-herdr-orchestrator"), "broker", "startup"],
      environment,
    ),
    runChild([childModule, "starter"], environment),
    runChild([childModule, "starter"], environment),
  ]);
  assert.equal(startupHook.code, 0, startupHook.stderr);
  assert.equal(startupHook.stdout, "");
  assert.equal(startupHook.stderr, "");
  for (const result of [started, concurrent])
    assert.equal(
      result.code,
      0,
      `${result.stderr}\n${await readFile(paths.log, "utf8").catch(() => "no broker log")}`,
    );
  const receipts = [started, concurrent].map(
    (result) =>
      JSON.parse(result.stdout) as {
        event: string;
        pid: number;
        startIdentity: string;
        sessionKey: string;
      },
  );
  const startReceipt = receipts[0]!;
  assert.equal(startReceipt.event, "starter-ready");
  assert.equal(startReceipt.sessionKey, paths.sessionKey);
  assert.equal(receipts[1]?.pid, startReceipt.pid);
  assert.equal(receipts[1]?.startIdentity, startReceipt.startIdentity);
  const publicStart = await runChild(
    [join(root, "bin", "pi-herdr-orchestrator"), "broker", "start"],
    environment,
  );
  assert.equal(publicStart.code, 0, publicStart.stderr);
  assert.deepEqual(JSON.parse(publicStart.stdout), {
    status: "running",
    sessionKey: paths.sessionKey,
  });
  assert.equal(mode((await lstat(paths.runtime)).mode), 0o700);
  assert.equal(mode((await lstat(paths.root)).mode), 0o700);
  assert.equal(mode((await lstat(paths.socket)).mode), 0o600);
  assert.equal(mode((await lstat(paths.lock)).mode), 0o600);
  assert.equal(mode((await lstat(paths.pid)).mode), 0o600);
  assert.equal(mode((await lstat(paths.secret)).mode), 0o600);
  assert.equal(mode((await lstat(paths.log)).mode), 0o600);
  await missing(paths.startup);
  await noStartupLinks(paths.runtime);

  const commandPath = join(root, "bin", "pi-herdr-orchestrator");
  const command = await lstat(commandPath);
  const parentStart = linuxProcessStart(process.pid);
  assert.ok(parentStart);
  const liveStartup = `${JSON.stringify({
    version: 1,
    nonce: "8".repeat(32),
    pid: process.pid,
    startIdentity: parentStart,
    sessionKey: paths.sessionKey,
    brokerSocket: paths.socket,
    commandPath,
    commandDev: command.dev,
    commandIno: command.ino,
  })}\n`;
  await writeFile(paths.startup, liveStartup, { mode: 0o600 });
  const liveReuse = await runChild([childModule, "starter"], environment);
  assert.equal(liveReuse.code, 0, liveReuse.stderr);
  assert.equal(await readFile(paths.startup, "utf8"), liveStartup);
  await unlink(paths.startup);

  const liveTwoLinkNonce = "6".repeat(32);
  const liveTwoLink = `${JSON.stringify({
    version: 1,
    nonce: liveTwoLinkNonce,
    pid: process.pid,
    startIdentity: parentStart,
    sessionKey: paths.sessionKey,
    brokerSocket: paths.socket,
    commandPath,
    commandDev: command.dev,
    commandIno: command.ino,
  })}\n`;
  const liveCompanion = `${paths.startup}.create.${liveTwoLinkNonce}`;
  await writeFile(liveCompanion, liveTwoLink, { mode: 0o600 });
  await link(liveCompanion, paths.startup);
  const liveTwoLinkReuse = await runChild(
    [childModule, "starter"],
    environment,
  );
  assert.equal(liveTwoLinkReuse.code, 0, liveTwoLinkReuse.stderr);
  const livePublicStat = await lstat(paths.startup);
  const liveCompanionStat = await lstat(liveCompanion);
  assert.equal(livePublicStat.nlink, 2);
  assert.equal(livePublicStat.ino, liveCompanionStat.ino);
  await unlink(paths.startup);
  await unlink(liveCompanion);

  const replacedNonce = "5".repeat(32);
  const replacedPublic = `${JSON.stringify({
    version: 1,
    nonce: replacedNonce,
    pid: 2_147_483_647,
    startIdentity: "1",
    sessionKey: paths.sessionKey,
    brokerSocket: paths.socket,
    commandPath,
    commandDev: command.dev,
    commandIno: command.ino,
  })}\n`;
  const replacedCompanion = `${paths.startup}.create.${replacedNonce}`;
  const replacementBytes = "replacement companion bytes\n";
  await writeFile(paths.startup, replacedPublic, { mode: 0o600 });
  await writeFile(replacedCompanion, replacementBytes, { mode: 0o600 });
  const replacedReuse = await runChild([childModule, "starter"], environment);
  assert.notEqual(replacedReuse.code, 0);
  assert.match(replacedReuse.stderr, /startup companion is replaced/u);
  assert.equal(await readFile(paths.startup, "utf8"), replacedPublic);
  assert.equal(await readFile(replacedCompanion, "utf8"), replacementBytes);
  await unlink(paths.startup);
  await unlink(replacedCompanion);

  const crashedPublisher = await runChild(
    [childModule, "crash-startup-publisher"],
    environment,
  );
  assert.equal(crashedPublisher.code, 86, crashedPublisher.stderr);
  const crashReceipt = JSON.parse(crashedPublisher.stdout) as {
    pid: number;
    startIdentity: string;
    companion: string;
  };
  assert.notEqual(
    linuxProcessStart(crashReceipt.pid),
    crashReceipt.startIdentity,
  );
  const crashedPublicStat = await lstat(paths.startup);
  const crashedCompanionStat = await lstat(crashReceipt.companion);
  assert.equal(crashedPublicStat.nlink, 2);
  assert.equal(crashedPublicStat.ino, crashedCompanionStat.ino);
  const crashRecovery = await runChild([childModule, "starter"], environment);
  assert.equal(crashRecovery.code, 0, crashRecovery.stderr);
  assert.equal(
    (JSON.parse(crashRecovery.stdout) as { pid: number }).pid,
    startReceipt.pid,
  );
  await missing(paths.startup);
  await missing(crashReceipt.companion);
  await noStartupLinks(paths.runtime);

  const wrongStartup = `${JSON.stringify({
    version: 1,
    nonce: "7".repeat(32),
    pid: 2_147_483_647,
    startIdentity: "1",
    sessionKey: "f".repeat(24),
    brokerSocket: paths.socket,
    commandPath,
    commandDev: command.dev,
    commandIno: command.ino,
  })}\n`;
  await writeFile(paths.startup, wrongStartup, { mode: 0o600 });
  const wrongReuse = await runChild([childModule, "starter"], environment);
  assert.notEqual(wrongReuse.code, 0);
  assert.match(wrongReuse.stderr, /belongs to another or replaced session/u);
  assert.equal(await readFile(paths.startup, "utf8"), wrongStartup);
  await unlink(paths.startup);

  await writeFile(
    paths.startup,
    `${JSON.stringify({
      version: 1,
      nonce: "9".repeat(32),
      pid: 2_147_483_647,
      startIdentity: "1",
      sessionKey: paths.sessionKey,
      brokerSocket: paths.socket,
      commandPath,
      commandDev: command.dev,
      commandIno: command.ino,
    })}\n`,
    { mode: 0o600 },
  );
  const healthyReuse = await runChild([childModule, "starter"], environment);
  assert.equal(healthyReuse.code, 0, healthyReuse.stderr);
  const healthyReceipt = JSON.parse(healthyReuse.stdout) as { pid: number };
  assert.equal(healthyReceipt.pid, startReceipt.pid);
  await missing(paths.startup);

  const cliStatus = await runChild(
    [join(root, "bin", "pi-herdr-orchestrator"), "broker", "status"],
    environment,
  );
  assert.equal(cliStatus.code, 0, cliStatus.stderr);
  assert.equal(JSON.parse(cliStatus.stdout).status, "running");

  const ordinaryPiEnvironment = { ...environment };
  delete ordinaryPiEnvironment.HERDR_BIN_PATH;
  delete ordinaryPiEnvironment.HERDR_TERMINAL_ID;
  const extension = await runChild(
    [childModule, "extension"],
    ordinaryPiEnvironment,
  );
  assert.equal(
    extension.code,
    0,
    `${extension.stderr}\nBROKER LOG:\n${await readFile(paths.log, "utf8").catch(() => "no log")}\nEVENTS:\n${await readFile(paths.events, "utf8").catch(() => "no events")}`,
  );
  const extensionReceipt = JSON.parse(extension.stdout) as {
    event: string;
    tools: number;
    adopted: boolean;
    managedRegistered: boolean;
    sessionKey: string;
  };
  assert.deepEqual(extensionReceipt, {
    event: "extension-stopped",
    tools: PARENT_TOOL_COUNT,
    adopted: true,
    managedRegistered: true,
    sessionKey: paths.sessionKey,
  });
  stopped = true;
  await missing(paths.socket);
  await missing(paths.lock);
  await missing(paths.pid);
  await missing(paths.startup);
  await noStartupLinks(paths.runtime);
  await assert.rejects(readFile(`/proc/${startReceipt.pid}/stat`, "utf8"), {
    code: "ENOENT",
  });
  assert.equal(mode((await lstat(paths.secret)).mode), 0o600);
  assert.equal(mode((await lstat(paths.log)).mode), 0o600);

  await writeFile(paths.secret, "malformed\n", { mode: 0o600 });
  const malformedSecret = await runChild([childModule, "starter"], environment);
  assert.notEqual(malformedSecret.code, 0);
  assert.match(malformedSecret.stderr, /client secret is malformed/u);
  await missing(paths.pid);
  await missing(paths.lock);
  await missing(paths.socket);
  await missing(paths.startup);
  await unlink(paths.secret);

  const failureState = JSON.parse(await readFile(fakeState, "utf8")) as {
    schema: unknown;
  };
  failureState.schema = { methods: [] };
  await writeFile(fakeState, JSON.stringify(failureState), { mode: 0o600 });
  const failedChild = await runChild([childModule, "starter"], environment);
  assert.notEqual(failedChild.code, 0);
  assert.match(failedChild.stderr, /exited before readiness/u);
  await missing(paths.pid);
  await missing(paths.lock);
  await missing(paths.socket);
  await missing(paths.startup);
  failureState.schema = fixture;
  await writeFile(fakeState, JSON.stringify(failureState), { mode: 0o600 });

  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  await writeFile(paths.startup, "{}\n", { mode: 0o600 });
  const malformedStartup = await runChild(
    [childModule, "starter"],
    environment,
  );
  assert.notEqual(malformedStartup.code, 0);
  assert.match(
    malformedStartup.stderr,
    /startup record is unsafe or malformed/u,
  );
  await missing(paths.pid);
  await missing(paths.lock);
  await missing(paths.socket);
  await unlink(paths.startup);

  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  stopped = false;
  await writeFile(
    paths.startup,
    `${JSON.stringify({
      version: 1,
      nonce: "a".repeat(32),
      pid: 2_147_483_647,
      startIdentity: "1",
      sessionKey: paths.sessionKey,
      brokerSocket: paths.socket,
      commandPath,
      commandDev: command.dev,
      commandIno: command.ino,
    })}\n`,
    { mode: 0o600 },
  );
  const recovered = await runChild([childModule, "starter"], environment);
  assert.equal(recovered.code, 0, recovered.stderr);
  const recoveredReceipt = JSON.parse(recovered.stdout) as { pid: number };
  assert.notEqual(recoveredReceipt.pid, startReceipt.pid);
  const recoveredStop = await runChild(
    [join(root, "bin", "pi-herdr-orchestrator"), "broker", "stop"],
    environment,
  );
  assert.equal(recoveredStop.code, 0, recoveredStop.stderr);
  stopped = true;
  await missing(paths.startup);
  await missing(paths.socket);
  await missing(paths.lock);
  await missing(paths.pid);

  const state = JSON.parse(await readFile(fakeState, "utf8")) as {
    calls: string[][];
  };
  assert.ok(state.calls.some((argv) => argv.join(" ") === "api schema --json"));
  assert.ok(state.calls.some((argv) => argv.join(" ") === "api snapshot"));
});

test("held live broker readiness failure proves exact exit and preserves a replacement path", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "orch-held-startup-"));
  const herdrSocket = join(temporary, "herdr.sock");
  const receiptSocket = join(temporary, "receipt.sock");
  const fakeBinary = join(temporary, "held-herdr.mjs");
  const runtimeBase = join(temporary, "runtime");
  const stateBase = join(temporary, "state");
  const herdrServer = createServer((socket) => socket.resume());
  await new Promise<void>((resolve, reject) => {
    herdrServer.once("error", reject);
    herdrServer.listen(herdrSocket, resolve);
  });
  await chmod(herdrSocket, 0o600);
  await writeFile(fakeBinary, heldHerdrProgram(), { mode: 0o700 });

  let heldSocket: Socket | undefined;
  let resolveHeld!: (value: { pid: number }) => void;
  let rejectHeld!: (error: Error) => void;
  const held = new Promise<{ pid: number }>((resolve, reject) => {
    resolveHeld = resolve;
    rejectHeld = reject;
  });
  const receiptServer = createServer((socket) => {
    heldSocket = socket;
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      const end = pending.indexOf("\n");
      if (end < 0) return;
      const receipt = JSON.parse(pending.slice(0, end)) as {
        event: string;
        pid: number;
      };
      if (receipt.event !== "schema-held") {
        rejectHeld(new Error("Unexpected held Herdr receipt."));
        return;
      }
      resolveHeld({ pid: receipt.pid });
    });
  });
  await new Promise<void>((resolve, reject) => {
    receiptServer.once("error", reject);
    receiptServer.listen(receiptSocket, resolve);
  });

  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: "C.UTF-8",
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: herdrSocket,
    HERDR_BIN_PATH: fakeBinary,
    HERDR_CONFIG_PATH: receiptSocket,
    HERDR_PANE_ID: "pane-held",
    HERDR_TERMINAL_ID: "terminal-held",
    PI_HERDR_ORCH_RUNTIME_ROOT: runtimeBase,
    PI_HERDR_ORCH_STATE_ROOT: stateBase,
  };
  const key = sessionKey(herdrSocket);
  const base = resolvePaths(herdrSocket);
  const paths = {
    ...base,
    root: join(stateBase, key),
    runtime: join(runtimeBase, key),
    events: join(stateBase, key, "events-v1.jsonl"),
    snapshot: join(stateBase, key, "snapshot-v1.json"),
    lock: join(runtimeBase, key, "broker.lock"),
    startup: join(runtimeBase, key, "startup.lock"),
    pid: join(runtimeBase, key, "broker.pid"),
    socket: join(runtimeBase, key, "broker.sock"),
    secret: join(runtimeBase, key, "client.secret"),
    log: join(runtimeBase, key, "broker.log"),
  };
  const childModule = join(
    root,
    "dist",
    "tests",
    "helpers",
    "production-startup-child.js",
  );
  let brokerIdentity: { pid: number; startIdentity: string } | undefined;
  let released = false;
  t.after(async () => {
    const errors: unknown[] = [];
    if (!released && heldSocket && !heldSocket.destroyed) {
      await new Promise<void>((resolve, reject) =>
        heldSocket!.write("release\n", (error) =>
          error ? reject(error) : resolve(),
        ),
      ).catch((error) => errors.push(error));
    }
    if (
      brokerIdentity &&
      linuxProcessStart(brokerIdentity.pid) === brokerIdentity.startIdentity
    )
      try {
        process.kill(brokerIdentity.pid, "SIGKILL");
      } catch (error) {
        errors.push(error);
      }
    heldSocket?.destroy();
    await new Promise<void>((resolve, reject) =>
      receiptServer.close((error) => (error ? reject(error) : resolve())),
    ).catch((error) => errors.push(error));
    await new Promise<void>((resolve, reject) =>
      herdrServer.close((error) => (error ? reject(error) : resolve())),
    ).catch((error) => errors.push(error));
    await rm(temporary, { recursive: true, force: true }).catch((error) =>
      errors.push(error),
    );
    if (errors.length)
      throw new AggregateError(errors, "Held startup teardown failed.");
  });

  const starter = runChild([childModule, "starter"], environment);
  let heldTimer: NodeJS.Timeout | undefined;
  const receipt = await Promise.race([
    held,
    new Promise<never>((_resolve, reject) => {
      heldTimer = setTimeout(
        () => reject(new Error("Timed out waiting for held schema receipt.")),
        10_000,
      );
    }),
  ]).finally(() => {
    if (heldTimer) clearTimeout(heldTimer);
  });
  assert.ok(receipt.pid > 0);
  const heldStart = linuxProcessStart(receipt.pid);
  assert.ok(heldStart);
  const processRecord = JSON.parse(await readFile(paths.pid, "utf8")) as {
    pid: number;
    startIdentity: string;
  };
  brokerIdentity = processRecord;
  assert.equal(
    linuxProcessStart(processRecord.pid),
    processRecord.startIdentity,
  );
  const replacement = "owned replacement path\n";
  await writeFile(paths.socket, replacement, { mode: 0o600 });
  await chmod(herdrSocket, 0o660);

  const failed = await starter;
  await chmod(herdrSocket, 0o600);
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /owner-only Unix socket/u);
  assert.match(failed.stderr, /Broker startup and cleanup failed/u);
  assert.match(failed.stderr, /Refusing to remove non-socket broker path/u);
  assert.equal(await readFile(paths.socket, "utf8"), replacement);
  await missing(paths.pid);
  await missing(paths.lock);
  await missing(paths.startup);
  assert.notEqual(
    linuxProcessStart(processRecord.pid),
    processRecord.startIdentity,
  );

  const heldClosed = new Promise<void>((resolve) =>
    heldSocket!.once("close", () => resolve()),
  );
  const exitMonitor = spawn(
    "/usr/bin/tail",
    [`--pid=${receipt.pid}`, "-f", "/dev/null"],
    { stdio: "ignore", shell: false },
  );
  const monitoredExit = new Promise<void>((resolve, reject) => {
    exitMonitor.once("error", reject);
    exitMonitor.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Process exit monitor failed with ${code ?? 1}.`)),
    );
  });
  await new Promise<void>((resolve, reject) =>
    heldSocket!.write("release\n", (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  let monitorTimer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all([heldClosed, monitoredExit]),
    new Promise<never>((_resolve, reject) => {
      monitorTimer = setTimeout(
        () =>
          reject(
            new Error("Timed out waiting for held process exit receipts."),
          ),
        5_000,
      );
    }),
  ]).finally(() => {
    if (monitorTimer) clearTimeout(monitorTimer);
  });
  released = true;
  assert.notEqual(linuxProcessStart(receipt.pid), heldStart);
  await unlink(paths.socket);
});

test("fresh owned startup revalidates the retained binary after readiness and cleans its exact child", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "orch-binary-startup-"));
  const herdrSocket = join(temporary, "herdr.sock");
  const fakeBinary = join(temporary, "fake-herdr.mjs");
  const fakeState = join(temporary, "fake-state.json");
  const runtimeBase = join(temporary, "runtime");
  const stateBase = join(temporary, "state");
  const herdrServer = createServer((socket) => socket.resume());
  await new Promise<void>((resolve, reject) => {
    herdrServer.once("error", reject);
    herdrServer.listen(herdrSocket, resolve);
  });
  await chmod(herdrSocket, 0o600);
  await writeFile(fakeBinary, fakeHerdrProgram(), { mode: 0o700 });
  await writeFile(
    fakeState,
    JSON.stringify({
      calls: [],
      schema: {
        methods: [
          "session.snapshot",
          "events.subscribe",
          "workspace.list",
          "workspace.get",
          "workspace.focus",
          "workspace.close",
          "tab.create",
          "tab.get",
          "tab.close",
          "pane.list",
          "pane.get",
          "pane.focus",
          "pane.close",
          "agent.list",
          "agent.get",
          "agent.start",
          "agent.focus",
          "worktree.list",
          "worktree.create",
          "worktree.open",
          "worktree.remove",
        ],
      },
      snapshot: { workspaces: [], tabs: [], panes: [], agents: [] },
      provisions: [],
    }),
    { mode: 0o600 },
  );
  const key = sessionKey(herdrSocket);
  const base = resolvePaths(herdrSocket);
  const paths = {
    ...base,
    root: join(stateBase, key),
    runtime: join(runtimeBase, key),
    events: join(stateBase, key, "events-v1.jsonl"),
    snapshot: join(stateBase, key, "snapshot-v1.json"),
    lock: join(runtimeBase, key, "broker.lock"),
    startup: join(runtimeBase, key, "startup.lock"),
    pid: join(runtimeBase, key, "broker.pid"),
    socket: join(runtimeBase, key, "broker.sock"),
    secret: join(runtimeBase, key, "client.secret"),
    log: join(runtimeBase, key, "broker.log"),
  };
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  let brokerIdentity: { pid: number; startIdentity: string } | undefined;
  let mutated = false;
  let mutationResolve!: () => void;
  let mutationReject!: (error: Error) => void;
  const mutation = new Promise<void>((resolve, reject) => {
    mutationResolve = resolve;
    mutationReject = reject;
  });
  const watcher = watch(paths.runtime, (_event, filename) => {
    if (mutated || filename !== "broker.sock") return;
    try {
      brokerIdentity = JSON.parse(readFileSync(paths.pid, "utf8")) as {
        pid: number;
        startIdentity: string;
      };
      chmodSync(fakeBinary, 0o722);
      mutated = true;
      mutationResolve();
    } catch (error) {
      mutationReject(error as Error);
    }
  });
  let starter:
    Promise<{ stdout: string; stderr: string; code: number }> | undefined;
  let starterObserved = false;
  let bodyError: unknown;
  try {
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      LANG: "C.UTF-8",
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: herdrSocket,
      HERDR_BIN_PATH: fakeBinary,
      HERDR_CONFIG_PATH: fakeState,
      HERDR_PANE_ID: "pane-binary",
      HERDR_TERMINAL_ID: "terminal-binary",
      PI_HERDR_ORCH_RUNTIME_ROOT: runtimeBase,
      PI_HERDR_ORCH_STATE_ROOT: stateBase,
    };
    const childModule = join(
      root,
      "dist",
      "tests",
      "helpers",
      "production-startup-child.js",
    );
    starter = runChild([childModule, "starter"], environment);
    let mutationTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      mutation,
      new Promise<never>((_resolve, reject) => {
        mutationTimer = setTimeout(
          () =>
            reject(new Error("Timed out waiting for broker socket receipt.")),
          10_000,
        );
      }),
    ]).finally(() => {
      if (mutationTimer) clearTimeout(mutationTimer);
    });
    const failed = await starter.finally(() => {
      starterObserved = true;
    });
    assert.notEqual(failed.code, 0);
    assert.match(
      failed.stderr,
      /HERDR_BIN_PATH is missing, replaced, or unsafe/u,
    );
    assert.ok(brokerIdentity);
    assert.notEqual(
      linuxProcessStart(brokerIdentity.pid),
      brokerIdentity.startIdentity,
    );
    await missing(paths.pid);
    await missing(paths.lock);
    await missing(paths.socket);
    await noStartupLinks(paths.runtime);
    assert.equal(mode((await lstat(herdrSocket)).mode), 0o600);
  } catch (error) {
    bodyError = error;
  } finally {
    await collectTerminalOutcome(
      bodyError,
      [
        () => watcher.close(),
        () =>
          brokerIdentity
            ? terminateExactTestProcess(brokerIdentity)
            : undefined,
        async () => {
          if (starter && !starterObserved)
            await starter.finally(() => {
              starterObserved = true;
            });
        },
        () =>
          new Promise<void>((resolve, reject) =>
            herdrServer.close((error) => (error ? reject(error) : resolve())),
          ),
        () => rm(temporary, { recursive: true, force: true }),
      ],
      "Retained-binary startup test body and teardown failed.",
    );
  }
});

test("existing-broker reuse rejects an unsafe broker-retained binary instead of trusting a safe caller binary", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "orch-reuse-binary-"));
  const herdrSocket = join(temporary, "herdr.sock");
  const stateRoot = join(temporary, "state");
  const runtimeRoot = join(temporary, "runtime");
  const schemaPath = join(temporary, "schema.json");
  const callsA = join(temporary, "calls-a");
  const callsB = join(temporary, "calls-b");
  const binaryA = join(temporary, "herdr-a.mjs");
  const binaryB = join(temporary, "herdr-b.mjs");
  const methods = [
    "session.snapshot",
    "events.subscribe",
    "workspace.list",
    "workspace.get",
    "workspace.focus",
    "workspace.close",
    "tab.create",
    "tab.get",
    "tab.close",
    "pane.list",
    "pane.get",
    "pane.focus",
    "pane.close",
    "agent.list",
    "agent.get",
    "agent.start",
    "agent.focus",
    "agent.stop",
    "agent.interrupt",
    "worktree.list",
    "worktree.create",
    "worktree.open",
    "worktree.remove",
  ];
  await writeFile(schemaPath, JSON.stringify({ methods }), { mode: 0o600 });
  const fakeBinary = (calls: string) => `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const command = process.argv.slice(2).join(" ");
appendFileSync(${JSON.stringify(calls)}, command + "\\n");
if (command === "api schema --json")
  process.stdout.write(readFileSync(${JSON.stringify(schemaPath)}, "utf8"));
else if (command === "api snapshot")
  process.stdout.write(JSON.stringify({ id: "cli:api:snapshot", result: { type: "session_snapshot", snapshot: { version: "0.8.0", protocol: 19, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] } } }));
else {
  process.stderr.write("unexpected command");
  process.exitCode = 31;
}
`;
  await writeFile(binaryA, fakeBinary(callsA), { mode: 0o700 });
  await writeFile(binaryB, fakeBinary(callsB), { mode: 0o700 });
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.resume();
    socket.once("close", () => connections.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(herdrSocket, resolve);
  });
  await chmod(herdrSocket, 0o600);
  const environmentKeys = [
    "HERDR_ENV",
    "HERDR_SOCKET_PATH",
    "HERDR_BIN_PATH",
    "PI_HERDR_ORCH_STATE_ROOT",
    "PI_HERDR_ORCH_RUNTIME_ROOT",
  ] as const;
  const priorEnvironment = new Map(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: herdrSocket,
    HERDR_BIN_PATH: binaryA,
    PI_HERDR_ORCH_STATE_ROOT: stateRoot,
    PI_HERDR_ORCH_RUNTIME_ROOT: runtimeRoot,
  });
  let broker: Broker | undefined;
  let bodyError: unknown;
  try {
    const { paths } = await resolveHerdrPaths();
    broker = new Broker(paths, {
      herdrFactory: (store, resolved) =>
        createProductionHerdrService(store, resolved, binaryA),
    });
    await broker.start();
    const retainedCalls = await readFile(callsA, "utf8");
    await chmod(binaryA, 0o722);
    process.env.HERDR_BIN_PATH = binaryB;
    await assert.rejects(ensureBroker(), /Request failed/u);
    assert.equal(await readFile(callsA, "utf8"), retainedCalls);
    await assert.rejects(readFile(callsB, "utf8"), { code: "ENOENT" });
  } catch (error) {
    bodyError = error;
  } finally {
    await collectTerminalOutcome(
      bodyError,
      [
        () => broker?.stop(),
        () => {
          for (const socket of connections) socket.destroy();
        },
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
        () => {
          for (const [key, value] of priorEnvironment)
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        },
        () => rm(temporary, { recursive: true, force: true }),
      ],
      "Existing-broker retained-binary test body and teardown failed.",
    );
  }
});

test("fresh readiness finalization failure stops its exact child and preserves replacements", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "orch-finalize-startup-"));
  const herdrSocket = join(temporary, "herdr.sock");
  const fakeBinary = join(temporary, "fake-herdr.mjs");
  const fakeState = join(temporary, "fake-state.json");
  const runtimeBase = join(temporary, "runtime");
  const stateBase = join(temporary, "state");
  const herdrServer = createServer((socket) => socket.resume());
  await new Promise<void>((resolve, reject) => {
    herdrServer.once("error", reject);
    herdrServer.listen(herdrSocket, resolve);
  });
  await chmod(herdrSocket, 0o600);
  await writeFile(fakeBinary, fakeHerdrProgram(), { mode: 0o700 });
  await writeFile(
    fakeState,
    JSON.stringify({
      calls: [],
      schema: {
        methods: [
          "session.snapshot",
          "events.subscribe",
          "workspace.list",
          "workspace.get",
          "workspace.focus",
          "workspace.close",
          "tab.create",
          "tab.get",
          "tab.close",
          "pane.list",
          "pane.get",
          "pane.focus",
          "pane.close",
          "agent.list",
          "agent.get",
          "agent.start",
          "agent.focus",
          "worktree.list",
          "worktree.create",
          "worktree.open",
          "worktree.remove",
        ],
      },
      snapshot: { workspaces: [], tabs: [], panes: [], agents: [] },
      provisions: [],
    }),
    { mode: 0o600 },
  );
  const key = sessionKey(herdrSocket);
  const base = resolvePaths(herdrSocket);
  const paths = {
    ...base,
    root: join(stateBase, key),
    runtime: join(runtimeBase, key),
    events: join(stateBase, key, "events-v1.jsonl"),
    snapshot: join(stateBase, key, "snapshot-v1.json"),
    lock: join(runtimeBase, key, "broker.lock"),
    startup: join(runtimeBase, key, "startup.lock"),
    pid: join(runtimeBase, key, "broker.pid"),
    socket: join(runtimeBase, key, "broker.sock"),
    secret: join(runtimeBase, key, "client.secret"),
    log: join(runtimeBase, key, "broker.log"),
  };
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const pidReplacement = '{"replacement":true}\n';
  let brokerIdentity: { pid: number; startIdentity: string } | undefined;
  let mutated = false;
  let mutationResolve!: () => void;
  let mutationReject!: (error: Error) => void;
  const mutation = new Promise<void>((resolve, reject) => {
    mutationResolve = resolve;
    mutationReject = reject;
  });
  const watcher = watch(paths.runtime, (_event, filename) => {
    if (mutated || filename !== "broker.sock") return;
    mutated = true;
    try {
      brokerIdentity = JSON.parse(readFileSync(paths.pid, "utf8")) as {
        pid: number;
        startIdentity: string;
      };
      unlinkSync(paths.pid);
      writeFileSync(paths.pid, pidReplacement, { mode: 0o600 });
      chmodSync(paths.runtime, 0o500);
      mutationResolve();
    } catch (error) {
      mutationReject(error as Error);
    }
  });
  let bodyError: unknown;
  try {
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      LANG: "C.UTF-8",
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: herdrSocket,
      HERDR_BIN_PATH: fakeBinary,
      HERDR_CONFIG_PATH: fakeState,
      HERDR_PANE_ID: "pane-finalize",
      HERDR_TERMINAL_ID: "terminal-finalize",
      PI_HERDR_ORCH_RUNTIME_ROOT: runtimeBase,
      PI_HERDR_ORCH_STATE_ROOT: stateBase,
    };
    const childModule = join(
      root,
      "dist",
      "tests",
      "helpers",
      "production-startup-child.js",
    );
    const starter = runChild(
      [childModule, "expected-starter-failure"],
      environment,
    );
    let mutationTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      mutation,
      new Promise<never>((_resolve, reject) => {
        mutationTimer = setTimeout(
          () =>
            reject(new Error("Timed out waiting for finalization receipt.")),
          10_000,
        );
      }),
    ]).finally(() => {
      if (mutationTimer) clearTimeout(mutationTimer);
    });
    const failed = await starter;
    await chmod(paths.runtime, 0o700);
    assert.equal(failed.code, 87, failed.stderr);
    type ErrorReceipt = {
      message: string;
      errors?: ErrorReceipt[];
    };
    const receipt = JSON.parse(failed.stdout) as {
      event: string;
      error: ErrorReceipt;
    };
    const errorMessages = (error: ErrorReceipt): string[] => [
      error.message,
      ...(error.errors ?? []).flatMap(errorMessages),
    ];
    assert.equal(receipt.event, "starter-failed");
    assert.equal(receipt.error.message, "Broker startup and cleanup failed.");
    assert.match(
      receipt.error.errors?.[0]?.message ?? "",
      /EACCES|permission denied/iu,
    );
    assert.ok(
      errorMessages(receipt.error).some((message) =>
        /process record/iu.test(message),
      ),
    );
    assert.ok(brokerIdentity);
    assert.notEqual(
      linuxProcessStart(brokerIdentity.pid),
      brokerIdentity.startIdentity,
    );
    assert.equal(await readFile(paths.pid, "utf8"), pidReplacement);
    assert.equal(mode((await lstat(herdrSocket)).mode), 0o600);
  } catch (error) {
    bodyError = error;
  } finally {
    await collectTerminalOutcome(
      bodyError,
      [
        () => chmod(paths.runtime, 0o700),
        () => watcher.close(),
        () =>
          brokerIdentity
            ? terminateExactTestProcess(brokerIdentity)
            : undefined,
        () =>
          new Promise<void>((resolve, reject) =>
            herdrServer.close((error) => (error ? reject(error) : resolve())),
          ),
        () => rm(temporary, { recursive: true, force: true }),
      ],
      "Finalization test body and teardown failed.",
    );
  }
});

const PARENT_TOOL_COUNT = 25;
