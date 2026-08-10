import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";
import { HerdrService } from "../../src/herdr/service.js";
import { EventStore } from "../../src/state/event-store.js";

const failures = [
  "absent socket",
  "wrong socket target",
  "missing adapter",
  "wrong adapter",
  "schema drift",
  "binary identity changed",
  "capability cache changed",
  "broker lock failure",
  "config failure",
  "profile failure",
  "stale resource",
] as const;

test("M2 production mutation preflight failures make zero Herdr or Git calls", async () => {
  for (const failure of failures) {
    const root = await mkdtemp(join(tmpdir(), "m2-preflight-"));
    let mutations = 0;
    const cli = {
      requireMutationCapabilities: () => {
        mutations++;
      },
      createTab: async () => {
        mutations++;
        return { tab_id: "tab", root_pane_id: "pane" };
      },
      startPi: async () => {
        mutations++;
        return { pane_id: "pane" };
      },
      snapshot: async () => {
        mutations++;
        return {
          panes: [],
          tabs: [],
          workspaces: [],
          agents: [],
          worktrees: [],
        };
      },
      closePane: async () => {
        mutations++;
      },
      closeTab: async () => {
        mutations++;
      },
      removeWorktree: async () => {
        mutations++;
      },
    } as never;
    const store = new EventStore(join(root, "events.ndjson"));
    await store.open();
    const service = new HerdrService({
      store,
      cli,
      provisioner: new HerdrProvisioner(cli, join(root, "prompts")),
      preflight: async () => {
        throw new Error(`PREFLIGHT_${failure}`);
      },
      gitEvidence: async () => {
        mutations++;
        throw new Error("git must not run");
      },
    });
    await assert.rejects(() =>
      service.provision({
        agentId: `agent-${failure.replaceAll(" ", "-")}`,
        parentAgentId: "parent",
        role: "worker",
        workspaceId: "workspace",
        cwd: root,
        profileId: "test-runner",
        isolation: "worktree",
        projectBase: "HEAD",
        prompt: "preflight test",
      }),
    );
    assert.equal(mutations, 0, failure);
  }
});
