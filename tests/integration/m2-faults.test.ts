import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectCapabilities } from "../../src/herdr/capabilities.js";
import { HerdrCli } from "../../src/herdr/cli.js";
import { HerdrProcessRunner } from "../../src/herdr/runner.js";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";
import { HerdrService } from "../../src/herdr/service.js";
import { createId } from "../../src/shared/ids.js";
import { EventStore } from "../../src/state/event-store.js";
import { Broker } from "../../src/broker/broker.js";
import { sessionKey } from "../../src/shared/paths.js";

const methods = [
  "tab.create",
  "tab.close",
  "pane.close",
  "agent.start",
  "worktree.create",
  "worktree.remove",
  "session.snapshot",
];

function fakeHerdrScript(): string {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const path = process.env.HERDR_CONFIG_PATH;
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
const command = args.slice(0, 2).join(" ");
const fail = state.fail;
const failNow = (fail === "worktree.create" && command === "worktree create") || (fail === "tab.create.worktree" && command === "tab create") || (fail === "agent.start" && command === "agent start") || (fail === "tab.close.initial" && args.join(" ") === "tab close tab-1");
if (failNow) { writeFileSync(path, JSON.stringify(state)); console.error("fake boundary failure"); process.exit(31); }
const next = () => state.next++;
if (command === "worktree create") {
  const id = "worktree-" + next(); state.worktrees.push(id); writeFileSync(path, JSON.stringify(state));
  console.log(JSON.stringify({ id, path: "/fake/worktree", tab_id: "tab-1" }));
} else if (command === "worktree remove") {
  state.worktrees = state.worktrees.filter((id) => id !== args[2]); writeFileSync(path, JSON.stringify(state));
} else if (command === "tab create") {
  const n = next(); const tab = "tab-" + n; const pane = "pane-" + n;
  state.tabs.push(tab); state.panes.push(pane); writeFileSync(path, JSON.stringify(state));
  console.log(JSON.stringify({ tab_id: tab, root_pane_id: pane }));
} else if (command === "tab close") {
  const tab = args[2]; const n = tab.slice(4);
  state.tabs = state.tabs.filter((id) => id !== tab);
  state.panes = state.panes.filter((id) => id !== "pane-" + n);
  writeFileSync(path, JSON.stringify(state));
} else if (command === "pane close") {
  state.panes = state.panes.filter((id) => id !== args[2]); writeFileSync(path, JSON.stringify(state));
} else if (command === "agent start") {
  writeFileSync(path, JSON.stringify(state)); console.log(JSON.stringify({ pane_id: args[6] }));
} else if (command === "session snapshot") {
  writeFileSync(path, JSON.stringify(state));
  console.log(JSON.stringify({ panes: [], tabs: [], workspaces: [], agents: [], worktrees: [] }));
} else { writeFileSync(path, JSON.stringify(state)); console.log(JSON.stringify({})); }
`;
}

function fakeCapabilities() {
  return projectCapabilities({ methods });
}

async function provisionOptions() {
  return {
    parentAgentId: createId("agt"),
    role: "worker",
    workspaceId: "workspace-1",
    cwd: "/fake/project",
    profileId: "test-runner",
    isolation: "worktree" as const,
    projectBase: "HEAD",
    branch: "Fault Safe / branch",
    prompt: "Use only a fake local interface.",
  };
}

test("M2 fake stack persists provisioning and compensates the unused initial tab", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-m2-stack-"));
  const cliPath = join(root, "fake-herdr.mjs");
  const statePath = join(root, "fake-state.json");
  const eventPath = join(root, "events.ndjson");
  const promptRoot = join(root, "prompts");
  await writeFile(cliPath, fakeHerdrScript());
  await chmod(cliPath, 0o755);
  await writeFile(
    statePath,
    JSON.stringify({
      calls: [],
      tabs: ["tab-1"],
      panes: ["pane-1"],
      worktrees: [],
      next: 1,
    }),
  );
  const oldConfig = process.env.HERDR_CONFIG_PATH;
  process.env.HERDR_CONFIG_PATH = statePath;
  const cli = new HerdrCli(
    new HerdrProcessRunner({ binary: cliPath }),
    fakeCapabilities(),
  );
  const store = new EventStore(eventPath);
  await store.open();
  try {
    const agentId = createId("agt");
    const service = new HerdrService({
      store,
      cli,
      provisioner: new HerdrProvisioner(cli, promptRoot),
    });
    const result = await service.provision({
      agentId,
      ...(await provisionOptions()),
    });
    assert.equal(result.worktreeId, "worktree-1");
    assert.equal(result.paneId, "pane-2");
    assert.equal(
      store.state.herdrResources?.[agentId]?.worktreeId,
      "worktree-1",
    );
    assert.equal(store.state.herdrResources?.[agentId]?.state, "registered");
    assert.equal((await readdir(promptRoot)).length, 2);
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      calls: string[][];
      tabs: string[];
      panes: string[];
      worktrees: string[];
    };
    assert.deepEqual(state.tabs, ["tab-2"]);
    assert.deepEqual(state.panes, ["pane-2"]);
    assert.deepEqual(state.worktrees, ["worktree-1"]);
    assert.ok(state.calls.some((args) => args.join(" ") === "tab close tab-1"));
    const events = await readFile(eventPath, "utf8");
    assert.doesNotMatch(events, /Use only a fake|PI_HERDR_ORCH_AGENT_TOKEN/);
  } finally {
    if (oldConfig === undefined) delete process.env.HERDR_CONFIG_PATH;
    else process.env.HERDR_CONFIG_PATH = oldConfig;
  }
});

test("M2 authenticated broker routing drives production Herdr service and startup reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-m2-broker-"));
  const cliPath = join(root, "fake-herdr.mjs");
  const statePath = join(root, "fake-state.json");
  await writeFile(cliPath, fakeHerdrScript());
  await chmod(cliPath, 0o755);
  await writeFile(
    statePath,
    JSON.stringify({ calls: [], tabs: [], panes: [], worktrees: [], next: 1 }),
  );
  const oldConfig = process.env.HERDR_CONFIG_PATH;
  process.env.HERDR_CONFIG_PATH = statePath;
  const paths = {
    root,
    runtime: join(root, "runtime"),
    events: join(root, "events.ndjson"),
    snapshot: join(root, "snapshot.json"),
    lock: join(root, "broker.lock"),
    socket: join(root, "broker.sock"),
    secret: join(root, "secret"),
  };
  const cli = new HerdrCli(
    new HerdrProcessRunner({ binary: cliPath }),
    fakeCapabilities(),
  );
  const broker = new Broker(paths, {
    herdrFactory: async (store) =>
      new HerdrService({
        store,
        cli,
        provisioner: new HerdrProvisioner(cli, join(root, "prompts")),
      }),
  });
  try {
    await broker.start();
    const hello = await brokerRequestForTest(
      broker,
      "hello",
      "system.ping",
      {},
    );
    assert.equal(hello.ok, true, JSON.stringify(hello));
    const agentId = createId("agt");
    const response = await brokerRequestForTest(
      broker,
      "provision",
      "herdr.provision",
      {
        agentId,
        parentAgentId: createId("agt"),
        role: "worker",
        workspaceId: "workspace-1",
        cwd: "/fake/project",
        profileId: "test-runner",
        isolation: "shared-readonly",
        prompt: "broker-routed fake prompt",
      },
    );
    assert.equal(
      response.ok,
      true,
      JSON.stringify({ response, verify: broker.store.verify() }),
    );
    const result = response.result as Record<string, unknown>;
    assert.equal(typeof result.tokenDigest, "string");
    assert.equal("token" in result, false);
    const status = await brokerRequestForTest(
      broker,
      "status",
      "herdr.status",
      {},
    );
    assert.equal(status.ok, true);
    const reconciled = await brokerRequestForTest(
      broker,
      "reconcile",
      "herdr.reconcile",
      {},
    );
    assert.equal(reconciled.ok, true);
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      calls: string[][];
    };
    assert.ok(
      state.calls.some((args) => args.join(" ").startsWith("session snapshot")),
    );
  } finally {
    await broker.stop().catch(() => undefined);
    if (oldConfig === undefined) delete process.env.HERDR_CONFIG_PATH;
    else process.env.HERDR_CONFIG_PATH = oldConfig;
  }
});

async function brokerRequestForTest(
  broker: Broker,
  id: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const socket = createConnection(broker.paths.socket);
  let buffer = "";
  const frames: Record<string, unknown>[] = [];
  const next = (predicate: (frame: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`broker test response timeout: ${id}`)),
        2_000,
      );
      const check = () => {
        const found = frames.find(predicate);
        if (found) {
          clearTimeout(timer);
          resolve(found);
        }
      };
      (socket as Socket & { __check?: () => void }).__check = check;
      check();
    });
  socket.on("data", (data) => {
    buffer += data.toString("utf8");
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      frames.push(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
    (socket as Socket & { __check?: () => void }).__check?.();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    JSON.stringify({
      v: 1,
      type: "hello",
      id: id + "-hello",
      client: {
        kind: "cli",
        name: "m2-test",
        version: "0.1.0",
        capabilities: [],
      },
      sessionKey: sessionKey(broker.paths.socket),
      auth: { kind: "client_secret", secret: broker.secret },
    }) + "\n",
  );
  await next((frame) => frame.type === "hello_result" && frame.ok === true);
  socket.write(
    JSON.stringify({ v: 1, type: "request", id, method, params }) + "\n",
  );
  const response = await next(
    (frame) => frame.type === "response" && frame.id === id,
  );
  socket.destroy();
  return response;
}

test("M2 fake stack leaves no resources at each creation fault boundary", async () => {
  for (const fail of [
    "worktree.create",
    "tab.create.worktree",
    "agent.start",
    "tab.close.initial",
  ]) {
    const root = await mkdtemp(join(tmpdir(), "pi-herdr-m2-fault-"));
    const cliPath = join(root, "fake-herdr.mjs");
    const statePath = join(root, "fake-state.json");
    const promptRoot = join(root, "prompts");
    await writeFile(cliPath, fakeHerdrScript());
    await chmod(cliPath, 0o755);
    await writeFile(
      statePath,
      JSON.stringify({
        calls: [],
        tabs: ["tab-1"],
        panes: ["pane-1"],
        worktrees: [],
        next: 1,
        fail,
      }),
    );
    const oldConfig = process.env.HERDR_CONFIG_PATH;
    process.env.HERDR_CONFIG_PATH = statePath;
    try {
      const cli = new HerdrCli(
        new HerdrProcessRunner({ binary: cliPath }),
        fakeCapabilities(),
      );
      await assert.rejects(async () =>
        new HerdrProvisioner(cli, promptRoot).provision({
          agentId: createId("agt"),
          ...(await provisionOptions()),
        }),
      );
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        tabs: string[];
        panes: string[];
        worktrees: string[];
      };
      assert.ok(state.tabs.every((id) => ["tab-1", "tab-2"].includes(id)));
      assert.ok(state.panes.every((id) => ["pane-1", "pane-2"].includes(id)));
      // An empty snapshot is ambiguous. The corrected product retains the
      // resource instead of destroying it as if ownership were proven.
      assert.ok(
        state.worktrees.length === 0 || state.worktrees.includes("worktree-1"),
      );
      assert.equal((await readdir(promptRoot)).length, 2);
    } finally {
      if (oldConfig === undefined) delete process.env.HERDR_CONFIG_PATH;
      else process.env.HERDR_CONFIG_PATH = oldConfig;
    }
  }
});
