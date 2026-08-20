import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";
import { HerdrService } from "../../src/herdr/service.js";
import { createManagedToken } from "../../src/herdr/token-files.js";
import { createId } from "../../src/shared/ids.js";
import { EventStore } from "../../src/state/event-store.js";
import { emptyState, reduce } from "../../src/state/reducer.js";

test("M2 fake registration retains files until verified and records lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-completion-"));
  const events = join(root, "events.ndjson");
  const prompts = join(root, "prompts");
  let closed = false;
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
            agentId: "agent-1",
            terminalId: "terminal-1",
            sessionId: "session-1",
            generation: 1,
          },
        },
      ],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
    closePane: async () => {
      closed = true;
    },
  } as never;
  const store = new EventStore(events);
  await store.open();
  const service = new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(cli, prompts, () => [], true),
  });
  const result = await service.provision({
    agentId: "agent-1",
    parentAgentId: "parent-1",
    role: "worker",
    workspaceId: "workspace-1",
    cwd: root,
    profileId: "test-runner",
    isolation: "shared-readonly",
    prompt: "fake prompt",
  });
  assert.equal(store.state.herdrResources?.["agent-1"]?.state, "pending");
  assert.ok(result.promptPath);
  assert.ok(result.tokenFilePath);
  assert.equal((await readdir(prompts)).length, 2);
  await service.register("agent-1", {
    paneId: "pane-1",
    terminalId: "terminal-1",
    sessionId: "session-1",
    generation: 1,
  });
  assert.equal(store.state.herdrResources?.["agent-1"]?.state, "registered");
  assert.equal(
    store.state.herdrResources?.["agent-1"]?.cleanupOutcome,
    "retained_registration_files",
  );
  assert.equal((await readdir(prompts)).length, 2);
  assert.equal(await readFile(result.promptPath!, "utf8"), "fake prompt");
  assert.equal(
    await readFile(result.tokenFilePath!, "utf8"),
    result.token.token + "\n",
  );
  await service.close({
    paneId: "pane-1",
    terminalId: "terminal-1",
    sessionId: "session-1",
    generation: 1,
  });
  await service
    .close({
      paneId: "pane-1",
      terminalId: "terminal-1",
      sessionId: "session-1",
      generation: 1,
    })
    .catch((error: unknown) => assert.match(String(error), /IDENTITY/));
  assert.equal(closed, true);
  assert.equal(
    store.state.herdrResources?.["agent-1"]?.cleanupOutcome,
    "close_succeeded",
  );
});

test("M2 fake registration refuses a replaced occupant before token deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-replaced-"));
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  let occupant = "agent-1";
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-1", root_pane_id: "pane-1" }),
    startPi: async () => ({ pane_id: "pane-1" }),
    snapshot: async () => ({
      panes: [{ id: "pane-1", occupant: { agentId: occupant, generation: 1 } }],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
  } as never;
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
  await service.provision({
    agentId: "agent-1",
    parentAgentId: "parent-1",
    role: "worker",
    workspaceId: "w",
    cwd: root,
    profileId: "p",
    isolation: "shared-readonly",
    prompt: "p",
  });
  occupant = "replacement";
  await assert.rejects(
    () => service.register("agent-1", { paneId: "pane-1", generation: 1 }),
    /IDENTITY_MISMATCH/,
  );
});

test("M2 reducer retains explicit dirty and replacement classifications", () => {
  const id = createId("agt");
  let state = emptyState();
  state = reduce(state, {
    type: "herdr.provision.intent",
    actor: { principalId: "system", kind: "system" },
    entityRefs: { agentId: id },
    payload: { agentId: id },
  });
  state = reduce(state, {
    type: "herdr.provision.outcome",
    actor: { principalId: "system", kind: "system" },
    entityRefs: { agentId: id },
    payload: {
      agentId: id,
      state: "replaced",
      dirty: true,
      replaced: true,
      cleanupOutcome: "retained",
    },
  });
  assert.equal(state.herdrResources?.[id]?.dirty, true);
  assert.equal(state.herdrResources?.[id]?.replaced, true);
  assert.equal(state.herdrResources?.[id]?.cleanupOutcome, "retained");
});

test("M2 registration reconstructs pending files after service restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-restart-"));
  const prompts = join(root, "prompts");
  const events = join(root, "events.ndjson");
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-r", root_pane_id: "pane-r" }),
    startPi: async () => ({ pane_id: "pane-r" }),
    snapshot: async () => ({
      panes: [
        {
          id: "pane-r",
          terminalId: "term-r",
          occupant: {
            agentId: "agent-r",
            terminalId: "term-r",
            sessionId: "sess-r",
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
  const firstStore = new EventStore(events);
  await firstStore.open();
  const first = new HerdrService({
    store: firstStore,
    cli,
    provisioner: new HerdrProvisioner(cli, prompts, () => [], true),
  });
  const result = await first.provision({
    agentId: "agent-r",
    parentAgentId: "parent-r",
    role: "worker",
    workspaceId: "w",
    cwd: root,
    profileId: "p",
    isolation: "shared-readonly",
    prompt: "restart",
  });
  const secondStore = new EventStore(events);
  await secondStore.open();
  const second = new HerdrService({
    store: secondStore,
    cli,
    provisioner: new HerdrProvisioner(cli, prompts, () => [], true),
  });
  await second.startupReconcile();
  await second.register(
    "agent-r",
    {
      paneId: "pane-r",
      terminalId: "term-r",
      sessionId: "sess-r",
      generation: 1,
    },
    undefined,
    result.token.digest,
  );
  assert.equal(
    secondStore.state.herdrResources?.["agent-r"]?.state,
    "registered",
  );
  assert.equal((await readdir(prompts)).length, 2);
});

test("M2 restart expiry durably times out pending registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-expiry-"));
  const prompts = join(root, "prompts");
  const events = join(root, "events.ndjson");
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-e", root_pane_id: "pane-e" }),
    startPi: async () => ({ pane_id: "pane-e" }),
    snapshot: async () => ({
      panes: [],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
  } as never;
  const firstStore = new EventStore(events);
  await firstStore.open();
  const first = new HerdrService({
    store: firstStore,
    cli,
    provisioner: new HerdrProvisioner(cli, prompts, () => [], true),
  });
  await first.provision({
    agentId: "agent-e",
    parentAgentId: "parent-e",
    role: "worker",
    workspaceId: "w",
    cwd: root,
    profileId: "p",
    isolation: "shared-readonly",
    prompt: "expiry",
  });
  await firstStore.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: "agent-e" },
    payload: {
      agentId: "agent-e",
      state: "pending",
      paneId: "pane-e",
      registrationDeadline: new Date(Date.now() - 1).toISOString(),
    },
  });
  const secondStore = new EventStore(events);
  await secondStore.open();
  const second = new HerdrService({
    store: secondStore,
    cli,
    provisioner: new HerdrProvisioner(cli, prompts, () => [], true),
  });
  await second.startupReconcile();
  assert.equal(
    secondStore.state.herdrResources?.["agent-e"]?.state,
    "timed_out",
  );
  assert.equal((await readdir(prompts)).length, 2);
});

test("M2 close is serialized and repeated close mutates once", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-close-lock-"));
  const eventPath = join(root, "events.ndjson");
  const store = new EventStore(eventPath);
  await store.open();
  let closeCount = 0;
  const agentId = createId("agt");
  let livePanes: Array<Record<string, unknown>> = [
    { id: "pane-c", occupant: { agentId, generation: 1 } },
  ];
  let liveAgents: Array<Record<string, unknown>> = [];
  let liveWorkspaces: Array<Record<string, unknown>> = [];
  let liveWorktrees: Array<Record<string, unknown>> = [];
  let worktreeInventoryPresent = false;
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => ({
      panes: livePanes,
      tabs: [],
      workspaces: liveWorkspaces,
      agents: liveAgents,
      worktrees: liveWorktrees,
      worktreeInventoryPresent,
    }),
    closePane: async () => {
      closeCount++;
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  } as never;
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
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: { agentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: { agentId, state: "registered", paneId: "pane-c", generation: 1 },
  });
  await Promise.all([
    service.close({ paneId: "pane-c", generation: 1 }),
    service.close({ paneId: "pane-c", generation: 1 }),
  ]);
  assert.equal(closeCount, 1);
  assert.equal(store.state.herdrResources?.[agentId]?.state, "closed");
  const closedSeq = store.state.lastEventSeq;
  assert.deepEqual(await service.reconcile(), []);
  assert.equal(store.state.lastEventSeq, closedSeq);
  await store.append({
    type: "herdr.reconciled",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "missing",
      reason: "Recorded pane is absent.",
    },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "closing",
      cleanupOutcome: "mutation_pending",
      generation: 2,
    },
  });
  assert.equal(store.state.herdrResources?.[agentId]?.state, "closed");
  const replay = new EventStore(eventPath);
  await replay.open();
  assert.equal(replay.state.herdrResources?.[agentId]?.state, "closed");

  const missingAgentId = createId("agt");
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: missingAgentId },
    payload: { agentId: missingAgentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: missingAgentId },
    payload: {
      agentId: missingAgentId,
      state: "registered",
      paneId: "pane-m",
      terminalId: "terminal-m",
      workspaceId: "workspace-shared",
      generation: 1,
    },
  });
  await store.append({
    type: "herdr.reconciled",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: missingAgentId },
    payload: {
      agentId: missingAgentId,
      state: "missing",
      reason: "Recorded pane is absent.",
    },
  });
  liveWorkspaces = [{ id: "workspace-shared" }];
  await service.close({ paneId: "pane-m", terminalId: "terminal-m" });
  assert.equal(closeCount, 1);
  assert.equal(store.state.herdrResources?.[missingAgentId]?.state, "closed");
  assert.equal(
    store.state.herdrResources?.[missingAgentId]?.cleanupOutcome,
    "already_absent",
  );

  liveWorkspaces = [];
  const movedAgentId = createId("agt");
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: movedAgentId },
    payload: { agentId: movedAgentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: movedAgentId },
    payload: {
      agentId: movedAgentId,
      ownerId: movedAgentId,
      state: "registered",
      paneId: "pane-old",
      terminalId: "terminal-old",
      generation: 1,
    },
  });
  await store.append({
    type: "herdr.reconciled",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: movedAgentId },
    payload: {
      agentId: movedAgentId,
      state: "missing",
      reason: "Recorded pane is absent.",
    },
  });
  livePanes = [
    {
      id: "pane-new",
      terminalId: "terminal-new",
      occupant: { agentId: movedAgentId, terminalId: "terminal-new" },
    },
  ];
  liveAgents = [
    {
      agentId: movedAgentId,
      paneId: "pane-new",
      terminalId: "terminal-new",
    },
  ];
  await assert.rejects(
    service.close({ paneId: "pane-old", terminalId: "terminal-old" }),
    /HERDR_IDENTITY_MISMATCH/,
  );
  assert.equal(closeCount, 1);
  assert.equal(store.state.herdrResources?.[movedAgentId]?.state, "missing");

  const worktreeAgentId = createId("agt");
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: worktreeAgentId },
    payload: { agentId: worktreeAgentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: worktreeAgentId },
    payload: {
      agentId: worktreeAgentId,
      ownerId: worktreeAgentId,
      state: "registered",
      paneId: "pane-worktree",
      terminalId: "terminal-worktree",
      workspaceId: "workspace-worktree",
      worktreeId: "worktree-id",
      worktreePath: "/repo/worktree",
      generation: 1,
    },
  });
  await store.append({
    type: "herdr.reconciled",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: worktreeAgentId },
    payload: {
      agentId: worktreeAgentId,
      state: "missing",
      reason: "Recorded pane is absent.",
    },
  });
  livePanes = [];
  liveAgents = [];
  liveWorkspaces = [{ id: "workspace-worktree" }];
  await assert.rejects(
    service.close({
      paneId: "pane-worktree",
      terminalId: "terminal-worktree",
    }),
    /HERDR_IDENTITY_MISMATCH/,
  );
  liveWorkspaces = [];
  await assert.rejects(
    service.close({
      paneId: "pane-worktree",
      terminalId: "terminal-worktree",
    }),
    /HERDR_IDENTITY_MISMATCH/,
  );
  worktreeInventoryPresent = true;
  liveWorktrees = [];
  await service.close({
    paneId: "pane-worktree",
    terminalId: "terminal-worktree",
  });
  assert.equal(closeCount, 1);
  assert.equal(store.state.herdrResources?.[worktreeAgentId]?.state, "closed");
  assert.equal(
    store.state.herdrResources?.[worktreeAgentId]?.cleanupOutcome,
    "already_absent",
  );
});

test("M2 token digest is the only durable token value", () => {
  const token = createManagedToken();
  assert.match(token.digest, /^[0-9a-f]{64}$/);
  assert.notEqual(token.token, token.digest);
});
