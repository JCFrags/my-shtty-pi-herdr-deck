import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";
import { HerdrService } from "../../src/herdr/service.js";
import { EventStore } from "../../src/state/event-store.js";

const actor = { principalId: "prn_00000000000000000000000000", kind: "system" };

test("M2 Git gateway rejects unknown, head, and path mismatch before mutation", async () => {
  const cases = [
    ["unknown", "HERDR_GIT_EVIDENCE_UNKNOWN"],
    ["path", "HERDR_GIT_IDENTITY_MISMATCH"],
    ["head", "HERDR_GIT_IDENTITY_MISMATCH"],
  ] as const;
  for (const [kind, errorText] of cases) {
    const root = await mkdtemp(join(tmpdir(), "m2-git-mismatch-"));
    let paneCloses = 0;
    let worktreeRemovals = 0;
    const parentBefore = { head: "parent-head", porcelain: [] as string[] };
    const cli = {
      requireMutationCapabilities: () => undefined,
      snapshot: async () => ({
        panes: [
          { id: "pane-1", occupant: { agentId: "agent-1", generation: 1 } },
        ],
        tabs: [],
        workspaces: [],
        agents: [],
        worktrees: [],
      }),
      closePane: async () => {
        paneCloses++;
      },
      removeWorktree: async () => {
        worktreeRemovals++;
      },
    } as never;
    const store = new EventStore(join(root, "events.ndjson"));
    await store.open();
    const service = new HerdrService({
      store,
      cli,
      provisioner: new HerdrProvisioner(cli, join(root, "prompts")),
      gitEvidence: async () => {
        if (kind === "unknown") throw new Error(errorText);
        return {
          repositoryRoot: kind === "path" ? "/other" : "/fake/worktree",
          head: kind === "head" ? "other-head" : "expected-head",
          branch: "managed",
          dirty: false,
          entries: [],
          changedFiles: [],
        };
      },
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
        worktreeId: "worktree-1",
        worktreePath: "/fake/worktree",
        worktreeGitHead: "expected-head",
      },
    });
    await assert.rejects(
      () => service.close({ paneId: "pane-1", generation: 1 }),
      new RegExp(errorText),
    );
    assert.equal(paneCloses, 0);
    assert.equal(worktreeRemovals, 0);
    assert.deepEqual(parentBefore, { head: "parent-head", porcelain: [] });
  }
});

test("M2 normal removal preserves parent HEAD and porcelain", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-git-parent-preserve-"));
  const parent = { head: "parent-head", porcelain: ["1 .M file"] };
  const before = structuredClone(parent);
  let removed = 0;
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => ({
      panes: [
        { id: "pane-1", occupant: { agentId: "agent-1", generation: 1 } },
      ],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
    closePane: async () => undefined,
    removeWorktree: async () => {
      removed++;
      assert.deepEqual(parent, before);
    },
  } as never;
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const service = new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(cli, join(root, "prompts")),
    gitEvidence: async () => ({
      repositoryRoot: "/fake/worktree",
      head: "managed-head",
      branch: "managed",
      dirty: false,
      entries: [],
      changedFiles: [],
    }),
  });
  const actor = {
    principalId: "prn_00000000000000000000000000",
    kind: "system",
  };
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
      worktreeId: "worktree-1",
      worktreePath: "/fake/worktree",
    },
  });
  await service.close({ paneId: "pane-1", generation: 1 });
  assert.equal(removed, 1);
  assert.deepEqual(parent, before);
});
