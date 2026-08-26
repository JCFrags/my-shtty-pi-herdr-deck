import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";
import { HerdrService } from "../../src/herdr/service.js";
import { EventStore } from "../../src/state/event-store.js";

const actor = { principalId: "prn_00000000000000000000000000", kind: "system" };

test("M2 concurrent repeated stop and register have one side effect and stable outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-lifecycle-race-"));
  let stops = 0;
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-1", root_pane_id: "pane-1" }),
    startPi: async () => ({ pane_id: "pane-1" }),
    snapshot: async () => ({
      panes: [
        {
          id: "pane-1",
          terminalId: "terminal-1",
          occupant: {
            kind: "pi",
            agentId: "agent-1",
            terminalId: "terminal-1",
            generation: 1,
          },
        },
      ],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
    stopAgent: async () => {
      stops++;
    },
  } as never;
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const service = new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(
      cli,
      join(root, "prompts"),
      () => [],
      true,
    ),
  });
  await store.append({
    type: "herdr.provision.intent",
    actor,
    entityRefs: { agentId: "agent-1" },
    payload: { agentId: "agent-1" },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor,
    entityRefs: { agentId: "agent-1" },
    payload: {
      agentId: "agent-1",
      state: "registered",
      paneId: "pane-1",
      generation: 1,
    },
  });
  await Promise.all([
    service.stop({ paneId: "pane-1", generation: 1 }),
    service.stop({ paneId: "pane-1", generation: 1 }),
  ]);
  await service.stop({ paneId: "pane-1", generation: 1 });
  assert.equal(stops, 1);
  assert.equal(store.state.herdrResources?.["agent-1"]?.state, "stopped");
});

test("M2 concurrent deadline reconcile cleans registration once and revokes generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-deadline-race-"));
  const prompts = join(root, "prompts");
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-1", root_pane_id: "pane-1" }),
    startPi: async () => ({ pane_id: "pane-1" }),
    snapshot: async () => ({
      panes: [],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
  } as never;
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const service = new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(cli, prompts, () => [], true),
  });
  await service.provision({
    agentId: "agent-1",
    parentAgentId: "parent",
    role: "worker",
    workspaceId: "workspace",
    cwd: root,
    profileId: "test-runner",
    isolation: "shared-readonly",
    prompt: "deadline",
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor,
    entityRefs: { agentId: "agent-1" },
    payload: {
      agentId: "agent-1",
      state: "pending",
      registrationDeadline: new Date(0).toISOString(),
    },
  });
  await Promise.all([
    service.reconcile(),
    service.reconcile(),
    service.reconcile(),
  ]);
  assert.equal(store.state.herdrResources?.["agent-1"]?.state, "timed_out");
  assert.equal(store.state.herdrResources?.["agent-1"]?.generation, 2);
  assert.equal((await readdir(prompts)).length, 2);
});

test("M2 concurrent broker registration attempts produce one transition and cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-register-race-"));
  const prompts = join(root, "prompts");
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-1", root_pane_id: "pane-1" }),
    startPi: async () => ({ pane_id: "pane-1" }),
    snapshot: async () => ({
      panes: [
        {
          id: "pane-1",
          terminalId: "terminal-1",
          occupant: {
            kind: "pi",
            agentId: "agent-1",
            terminalId: "terminal-1",
            generation: 1,
          },
        },
      ],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
  } as never;
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const service = new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(cli, prompts, () => [], true),
  });
  const result = await service.provision({
    agentId: "agent-1",
    parentAgentId: "parent",
    role: "worker",
    workspaceId: "workspace",
    cwd: root,
    profileId: "test-runner",
    isolation: "shared-readonly",
    prompt: "register",
  });
  const attempts = await Promise.allSettled([
    service.register(
      "agent-1",
      { paneId: "pane-1", generation: 1 },
      undefined,
      result.token.digest,
    ),
    service.register(
      "agent-1",
      { paneId: "pane-1", generation: 1 },
      undefined,
      result.token.digest,
    ),
  ]);
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((x) => x.status === "rejected").length, 1);
  assert.equal(store.state.herdrResources?.["agent-1"]?.state, "registered");
  assert.equal((await readdir(prompts)).length, 0);
});

test("M2 repeated normal reconcile has stable durable state and no mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-reconcile-repeat-"));
  let snapshots = 0;
  let mutations = 0;
  const cli = {
    snapshot: async () => {
      snapshots++;
      return { panes: [], tabs: [], workspaces: [], agents: [], worktrees: [] };
    },
    requireMutationCapabilities: () => {
      mutations++;
    },
  } as never;
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const service = new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(cli, join(root, "prompts")),
  });
  await Promise.all([
    service.reconcile(),
    service.reconcile(),
    service.reconcile(),
  ]);
  assert.equal(snapshots, 3);
  assert.equal(mutations, 0);
});
