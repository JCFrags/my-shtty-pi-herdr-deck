import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { doctor } from "../../src/broker/doctor.js";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";
import { HerdrService } from "../../src/herdr/service.js";
import { HerdrSocketClient } from "../../src/herdr/socket-client.js";
import { EventStore } from "../../src/state/event-store.js";
import type { HerdrSnapshot } from "../../src/herdr/types.js";

const snapshot = (agentId = "agent-1"): HerdrSnapshot => ({
  panes: [
    {
      id: "pane-1",
      terminalId: "terminal-1",
      occupant: {
        agentId,
        terminalId: "terminal-1",
        sessionId: "session-1",
        generation: 1,
      },
    },
  ],
  tabs: [{ id: "tab-1", panes: [{ id: "pane-1" }] }],
  workspaces: [],
  agents: [],
  worktrees: [],
});

function managedWorktreeSnapshot(): HerdrSnapshot {
  const current = snapshot();
  current.panes[0]!.workspaceId = "workspace-child";
  current.panes[0]!.tabId = "tab-1";
  current.panes[0]!.cwd = "/fake/worktree";
  current.panes[0]!.occupant!.workspaceId = "workspace-child";
  current.panes[0]!.occupant!.tabId = "tab-1";
  current.tabs[0]!.workspaceId = "workspace-child";
  current.workspaces = [
    {
      id: "workspace-child",
      cwd: "/fake/worktree",
      worktree: {
        repoKey: "/repo/.git",
        repoName: "repo",
        repoRoot: "/repo",
        checkoutPath: "/fake/worktree",
        isLinkedWorktree: true,
      },
      tabs: [],
    },
  ];
  return current;
}

function baseCli(current = snapshot()): any {
  return {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-1", root_pane_id: "pane-1" }),
    startPi: async () => ({ pane_id: "pane-1" }),
    snapshot: async () => current,
  } as never;
}

async function pendingService(root: string, cli = baseCli()) {
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
  const result = await service.provision({
    agentId: "agent-1",
    parentAgentId: "parent-1",
    role: "worker",
    workspaceId: "workspace-1",
    cwd: root,
    profileId: "test-runner",
    isolation: "shared-readonly",
    prompt: "private test prompt",
  });
  return { service, store, result, prompts: join(root, "prompts") };
}

test("M2 production registration rejects every wrong identity and proof without cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-registration-matrix-"));
  const { service, result, prompts } = await pendingService(root);
  const cases = [
    [{ paneId: "wrong-pane", generation: 1 }, result.token.digest],
    [
      { paneId: "pane-1", terminalId: "wrong-terminal", generation: 1 },
      result.token.digest,
    ],
    [
      { paneId: "pane-1", sessionId: "wrong-session", generation: 1 },
      result.token.digest,
    ],
    [{ paneId: "pane-1", generation: 2 }, result.token.digest],
    [{ paneId: "pane-1", generation: 1 }, "0".repeat(64)],
  ] as const;
  for (const [identity, proof] of cases)
    await assert.rejects(
      () => service.register("agent-1", identity, undefined, proof),
      /IDENTITY|TOKEN/,
    );
  assert.equal((await readdir(prompts)).length, 2);
  assert.equal(result.token.token.length > 0, true);
  await service.register(
    "agent-1",
    {
      paneId: "pane-1",
      terminalId: "terminal-1",
      sessionId: "session-1",
      generation: 1,
    },
    undefined,
    result.token.digest,
  );
  assert.equal((await readdir(prompts)).length, 0);
});

test("M2 registration rechecks the occupant before committing registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-registration-toctou-"));
  let snapshots = 0;
  const cli = {
    ...baseCli(),
    snapshot: async () => {
      snapshots++;
      return snapshots < 2 ? snapshot() : snapshot("attacker");
    },
  } as never;
  const { service, result, store, prompts } = await pendingService(root, cli);
  await assert.rejects(
    () =>
      service.register(
        "agent-1",
        { paneId: "pane-1", generation: 1 },
        result,
        result.token.digest,
      ),
    /IDENTITY_MISMATCH/,
  );
  assert.equal(snapshots, 2);
  assert.equal(store.state.herdrResources?.["agent-1"]?.state, "pending");
  assert.equal(store.state.herdrResources?.["agent-1"]?.generation, 2);
  assert.equal((await readdir(prompts)).length, 2);
});

test("M2 close removes the exact clean managed worktree workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-close-managed-worktree-"));
  let snapshots = 0;
  let removals = 0;
  let removedWorkspace: string | undefined;
  const cli = {
    ...baseCli(),
    snapshot: async () => {
      snapshots++;
      return managedWorktreeSnapshot();
    },
    closePane: async () =>
      assert.fail("worktree close must use worktree remove"),
    removeWorktree: async (workspaceId: string) => {
      removals++;
      removedWorkspace = workspaceId;
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
    gitEvidence: async () => ({
      repositoryRoot: "/fake/worktree",
      head: "head",
      branch: "branch",
      dirty: false,
      entries: [],
      changedFiles: [],
    }),
  });
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: "agent-1" },
    payload: { agentId: "agent-1" },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: "agent-1" },
    payload: {
      agentId: "agent-1",
      state: "registered",
      paneId: "pane-1",
      worktreePath: "/fake/worktree",
      generation: 1,
    },
  });
  await service.close({ paneId: "pane-1", generation: 1 });
  assert.equal(snapshots, 2);
  assert.equal(removals, 1);
  assert.equal(removedWorkspace, "workspace-child");
  assert.equal(
    store.state.herdrResources?.["agent-1"]?.cleanupOutcome,
    "worktree_removed",
  );
});

test("M2 subscription stops after its finite reconnect budget", async () => {
  let attempts = 0;
  const client = new HerdrSocketClient({
    socketPath: "/fake",
    reconnectDelaysMs: [0],
    maxReconnectAttempts: 3,
    connectSocket: () => {
      attempts++;
      const socket = new EventEmitter() as EventEmitter & {
        destroy: () => void;
      };
      socket.destroy = () => undefined;
      queueMicrotask(() => socket.emit("error", new Error("DOWN")));
      return socket as never;
    },
  });
  await assert.rejects(
    () => client.subscribe(() => undefined),
    /RECONNECT_EXHAUSTED/,
  );
  assert.equal(attempts, 3);
});

test("M2 production close removes a clean worktree and refuses dirty evidence", async () => {
  for (const dirty of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "m2-git-gateway-"));
    let paneCloses = 0;
    let removals = 0;
    const cli = {
      ...baseCli(managedWorktreeSnapshot()),
      closePane: async () => void paneCloses++,
      removeWorktree: async () => void removals++,
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
      gitEvidence: async () => ({
        repositoryRoot: "/fake/worktree",
        head: "worktree-head",
        branch: "managed",
        dirty,
        entries: [],
        changedFiles: [],
      }),
    });
    await store.append({
      type: "herdr.provision.intent",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId: "agent-1" },
      payload: { agentId: "agent-1" },
    });
    await store.append({
      type: "herdr.provision.outcome",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId: "agent-1" },
      payload: {
        agentId: "agent-1",
        state: "registered",
        paneId: "pane-1",
        worktreePath: "/fake/worktree",
        generation: 1,
      },
    });
    if (dirty)
      await assert.rejects(
        () => service.close({ paneId: "pane-1", generation: 1 }),
        /DIRTY_WORKTREE/,
      );
    else await service.close({ paneId: "pane-1", generation: 1 });
    assert.equal(paneCloses, 0);
    assert.equal(removals, dirty ? 0 : 1);
  }
});

test("M2 ambiguous compensation retains resources and records a typed outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-compensation-matrix-"));
  const cli = {
    ...baseCli({
      panes: [],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
    createWorktree: async () => ({ id: "worktree-1", path: "/fake/worktree" }),
    createTab: async () => ({ tab_id: "tab-1", root_pane_id: "pane-1" }),
    startPi: async () => {
      throw new Error("START_FAILED");
    },
    closePane: async () => assert.fail("ambiguous pane must be retained"),
    closeTab: async () => assert.fail("ambiguous tab must be retained"),
    removeWorktree: async () =>
      assert.fail("ambiguous worktree must be retained"),
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
  await assert.rejects(() =>
    service.provision({
      agentId: "agent-1",
      parentAgentId: "parent-1",
      role: "worker",
      workspaceId: "workspace-1",
      cwd: root,
      profileId: "test-runner",
      isolation: "worktree",
      projectBase: "HEAD",
      prompt: "private test prompt",
    }),
  );
  assert.equal(
    store.state.herdrResources?.["agent-1"]?.cleanupOutcome,
    "retained",
  );
  assert.equal(store.state.herdrResources?.["agent-1"]?.unknown, true);
});

test("M2 mandatory doctor fails closed for absent socket and missing public capability", async () => {
  const report = await doctor({
    herdrBinary: "/bin/true",
    herdrSocket: "/tmp/m2-no-such-herdr.sock",
    schema: { methods: ["session.snapshot", "events.subscribe"] },
  });
  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find((x) => x.name === "herdr-socket")?.available,
    false,
  );
  assert.equal(
    report.checks.some((x) => x.name === "pi-integration"),
    false,
  );
  assert.equal(
    report.checks.find((x) => x.name === "herdr-capability:worktree.remove")
      ?.available,
    false,
  );
});
