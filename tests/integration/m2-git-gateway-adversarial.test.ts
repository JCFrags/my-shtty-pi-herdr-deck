import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";
import { HerdrService } from "../../src/herdr/service.js";
import { EventStore } from "../../src/state/event-store.js";
import { collectGitEvidence } from "../../src/git/evidence.js";

const execFileAsync = promisify(execFile);

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

test("M2 real Git gateway preserves parent HEAD and porcelain for removal and compensation", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-real-git-"));
  const parent = join(root, "parent");
  const worktree = join(root, "worktree");
  await execFileAsync("git", ["init", parent]);
  await writeFile(join(parent, "file.txt"), "base\n");
  await execFileAsync("git", ["-C", parent, "add", "file.txt"]);
  await execFileAsync("git", [
    "-C",
    parent,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  await execFileAsync("git", [
    "-C",
    parent,
    "worktree",
    "add",
    "-b",
    "managed",
    worktree,
    "HEAD",
  ]);
  const before = await collectGitEvidence(parent);
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
      await execFileAsync("git", [
        "-C",
        parent,
        "worktree",
        "remove",
        worktree,
      ]);
    },
  } as never;
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const service = new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(cli, join(root, "prompts")),
    gitEvidence: collectGitEvidence,
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
      worktreeId: "managed",
      worktreePath: worktree,
    },
  });
  await service.close({ paneId: "pane-1", generation: 1 });
  const after = await collectGitEvidence(parent);
  assert.equal(removed, 1);
  assert.equal(after.head, before.head);
  assert.deepEqual(after.entries, before.entries);
  assert.deepEqual(after.changedFiles, before.changedFiles);

  const compensationWorktree = join(root, "compensation-worktree");
  await execFileAsync("git", [
    "-C",
    parent,
    "worktree",
    "add",
    "-b",
    "compensate",
    compensationWorktree,
    "HEAD",
  ]);
  let calls = 0;
  const failCli = {
    requireMutationCapabilities: () => undefined,
    createWorktree: async () => ({
      id: "compensate",
      path: compensationWorktree,
    }),
    createTab: async () => ({ tab_id: "tab-1", root_pane_id: "pane-1" }),
    startPi: async () => {
      throw new Error("START_FAILED");
    },
    snapshot: async () => ({
      panes: [{ id: "pane-1", occupant: { agentId: "agent-1" } }],
      tabs: [{ id: "tab-1", panes: [{ id: "pane-1" }] }],
      workspaces: [],
      agents: [],
      worktrees: [{ id: "compensate", path: compensationWorktree }],
    }),
    removeWorktree: async () => {
      calls++;
      await execFileAsync("git", [
        "-C",
        parent,
        "worktree",
        "remove",
        compensationWorktree,
      ]);
    },
    closePane: async () => {
      calls++;
    },
    closeTab: async () => {
      calls++;
    },
  } as never;
  const failureStore = new EventStore(join(root, "failure-events.ndjson"));
  await failureStore.open();
  const failureService = new HerdrService({
    store: failureStore,
    cli: failCli,
    provisioner: new HerdrProvisioner(
      failCli,
      join(root, "failure-prompts"),
      () => [],
      false,
      collectGitEvidence,
    ),
    gitEvidence: collectGitEvidence,
  });
  const parentBeforeCompensation = await collectGitEvidence(parent);
  await assert.rejects(() =>
    failureService.provision({
      agentId: "agent-1",
      parentAgentId: "parent",
      role: "worker",
      workspaceId: "workspace",
      cwd: parent,
      profileId: "test-runner",
      isolation: "worktree",
      projectBase: "HEAD",
      prompt: "compensation",
    }),
  );
  const parentAfterCompensation = await collectGitEvidence(parent);
  assert.equal(calls > 0, true);
  assert.equal(parentAfterCompensation.head, parentBeforeCompensation.head);
  assert.deepEqual(
    parentAfterCompensation.entries,
    parentBeforeCompensation.entries,
  );
  assert.deepEqual(
    failureStore.state.herdrResources?.["agent-1"]?.cleanupOutcome,
    "retained",
  );
});
