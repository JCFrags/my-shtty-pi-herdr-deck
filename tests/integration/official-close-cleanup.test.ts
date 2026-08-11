import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventStore } from "../../src/state/event-store.js";
import { normalizeSnapshot } from "../../src/herdr/normalizers.js";
import { HerdrService } from "../../src/herdr/service.js";

const actor = {
  principalId: "prn_00000000000000000000000000",
  kind: "system",
};
const agentId = "agent-official";
const sessionId = "019ff30e-e9ae-7d2b-a35f-a5e43734df15";
const worktreePath = "/managed/worktree";

function snapshot(
  referenceValue = `/sessions/turn_${sessionId}.jsonl`,
  liveCheckoutPath: string | null = worktreePath,
) {
  return normalizeSnapshot({
    result: {
      snapshot: {
        version: "0.8.0",
        protocol: 19,
        workspaces: [
          {
            workspace_id: "w19",
            ...(liveCheckoutPath === null
              ? {}
              : {
                  worktree: {
                    repo_key: "/repo/.git",
                    repo_name: "repo",
                    repo_root: "/repo",
                    checkout_path: liveCheckoutPath,
                    is_linked_worktree: true,
                  },
                }),
          },
        ],
        tabs: [{ tab_id: "w19:t2", workspace_id: "w19", cwd: worktreePath }],
        panes: [
          {
            pane_id: "w19:p2",
            terminal_id: "terminal-child",
            workspace_id: "w19",
            tab_id: "w19:t2",
            cwd: worktreePath,
            agent: "pi",
          },
        ],
        agents: [
          {
            pane_id: "w19:p2",
            terminal_id: "terminal-child",
            workspace_id: "w19",
            tab_id: "w19:t2",
            agent: "pi",
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "path",
              value: referenceValue,
            },
          },
        ],
      },
    },
  });
}

async function fixture(
  referenceValue?: string,
  liveCheckoutPath: string | null = worktreePath,
) {
  const root = await mkdtemp(join(tmpdir(), "official-close-cleanup-"));
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  await store.append({
    type: "herdr.provision.intent",
    actor,
    entityRefs: { agentId },
    payload: { agentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor,
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "registered",
      paneId: "w19:p2",
      terminalId: "terminal-child",
      sessionId,
      generation: 1,
      workspaceId: "stale-parent-workspace",
      worktreePath,
      worktreeGitHead: "head",
      worktreeGitBranch: "branch",
    },
  });
  let removedWorkspace: string | undefined;
  let paneCloses = 0;
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => snapshot(referenceValue, liveCheckoutPath),
    closePane: async () => {
      paneCloses++;
    },
    removeWorktree: async (workspaceId: string) => {
      removedWorkspace = workspaceId;
    },
  } as never;
  const service = new HerdrService({
    store,
    cli,
    provisioner: {} as never,
    gitEvidence: async () => ({
      repositoryRoot: worktreePath,
      head: "head",
      branch: "branch",
      dirty: false,
      entries: [],
      changedFiles: [],
    }),
  });
  return {
    service,
    store,
    removedWorkspace: () => removedWorkspace,
    paneCloses: () => paneCloses,
  };
}

test("official Herdr 0.8 close binds the Pi path session and removes its live workspace", async () => {
  const { service, store, removedWorkspace, paneCloses } = await fixture();
  await service.close({
    paneId: "w19:p2",
    terminalId: "terminal-child",
    sessionId,
  });
  assert.equal(removedWorkspace(), "w19");
  assert.equal(paneCloses(), 0);
  assert.equal(store.state.herdrResources?.[agentId]?.state, "closed");
  assert.equal(
    store.state.herdrResources?.[agentId]?.cleanupOutcome,
    "worktree_removed",
  );
});

test("official close rejects a different Pi path session before cleanup", async () => {
  const { service, removedWorkspace } = await fixture(
    "/sessions/turn_019ff30e-e9ae-7d2b-a35f-a5e43734df16.jsonl",
  );
  await assert.rejects(
    () =>
      service.close({
        paneId: "w19:p2",
        terminalId: "terminal-child",
        sessionId,
      }),
    /HERDR_IDENTITY_MISMATCH/,
  );
  assert.equal(removedWorkspace(), undefined);
});

test("official close rejects absent or replaced workspace worktree evidence", async () => {
  for (const liveCheckoutPath of [null, "/managed/replacement"] as const) {
    const { service, removedWorkspace, paneCloses } = await fixture(
      undefined,
      liveCheckoutPath,
    );
    await assert.rejects(
      () =>
        service.close({
          paneId: "w19:p2",
          terminalId: "terminal-child",
          sessionId,
        }),
      /HERDR_IDENTITY_MISMATCH/,
    );
    assert.equal(removedWorkspace(), undefined);
    assert.equal(paneCloses(), 0);
  }
});
