import assert from "node:assert/strict";
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
    assert.deepEqual(await readdir(promptRoot), []);
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
      assert.ok(state.tabs.every((id) => id === "tab-1"));
      assert.ok(state.panes.every((id) => id === "pane-1"));
      assert.deepEqual(state.worktrees, []);
      assert.deepEqual(await readdir(promptRoot), []);
    } finally {
      if (oldConfig === undefined) delete process.env.HERDR_CONFIG_PATH;
      else process.env.HERDR_CONFIG_PATH = oldConfig;
    }
  }
});
