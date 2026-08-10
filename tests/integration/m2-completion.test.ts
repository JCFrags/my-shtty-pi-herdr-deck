import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
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
  assert.deepEqual(await readdir(prompts), []);
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

test("M2 token digest is the only durable token value", () => {
  const token = createManagedToken();
  assert.match(token.digest, /^[0-9a-f]{64}$/);
  assert.notEqual(token.token, token.digest);
});
