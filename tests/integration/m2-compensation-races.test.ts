import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";

const cases = [
  ["missing-pane", "pane.close"],
  ["replaced-pane", "pane.close"],
  ["missing-tab", "tab.close"],
  ["replaced-tab", "tab.close"],
  ["missing-worktree", "worktree.remove"],
  ["replaced-worktree", "worktree.remove"],
] as const;

test("M2 compensation retains each missing or replaced resource", async () => {
  for (const [fault, forbidden] of cases) {
    const root = await mkdtemp(join(tmpdir(), "m2-compensation-race-"));
    const calls: string[] = [];
    const cli = {
      requireMutationCapabilities: () => undefined,
      createWorktree: async () => ({ id: "worktree-1", path: "/owned" }),
      createTab: async () => ({ tab_id: "tab-1", root_pane_id: "pane-1" }),
      startPi: async () => {
        throw new Error("START_FAILED");
      },
      snapshot: async () => ({
        panes:
          fault === "missing-pane"
            ? []
            : [
                {
                  id: "pane-1",
                  occupant: {
                    agentId: fault === "replaced-pane" ? "other" : "agent-1",
                  },
                },
              ],
        tabs:
          fault === "missing-tab"
            ? []
            : [
                {
                  id: "tab-1",
                  panes: [
                    { id: fault === "replaced-tab" ? "other-pane" : "pane-1" },
                  ],
                },
              ],
        workspaces: [],
        agents: [],
        worktrees:
          fault === "missing-worktree"
            ? []
            : [
                {
                  id: "worktree-1",
                  path: fault === "replaced-worktree" ? "/other" : "/owned",
                },
              ],
      }),
      closePane: async () => {
        calls.push("pane.close");
      },
      closeTab: async () => {
        calls.push("tab.close");
      },
      removeWorktree: async () => {
        calls.push("worktree.remove");
      },
    } as never;
    const provisioner = new HerdrProvisioner(
      cli,
      join(root, "prompts"),
      () => [],
      false,
      async () => ({
        repositoryRoot: "/owned",
        head: "h",
        branch: "b",
        dirty: false,
        entries: [],
        changedFiles: [],
      }),
    );
    await assert.rejects(() =>
      provisioner.provision({
        agentId: "agent-1",
        parentAgentId: "parent",
        role: "worker",
        workspaceId: "workspace",
        cwd: root,
        profileId: "test-runner",
        isolation: "worktree",
        projectBase: "HEAD",
        prompt: "race",
      }),
    );
    assert.equal(
      calls.includes(forbidden),
      false,
      `${fault}: ${calls.join(",")}`,
    );
  }
});
