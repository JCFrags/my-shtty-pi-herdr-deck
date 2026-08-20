import type { HerdrSnapshot } from "./types.js";
import type { Agent, OrchestrationState } from "../state/types.js";

export type ReconciliationKind =
  "present" | "moved" | "missing" | "replaced" | "orphaned" | "unknown";

export interface Reconciliation {
  agentId: string;
  kind: ReconciliationKind;
  paneId?: string;
  terminalId?: string;
  worktreeId?: string;
  worktreePath?: string;
  workspaceId?: string;
  reason?: string;
}

type HerdrResources = NonNullable<OrchestrationState["herdrResources"]>;

export function reconcileAgents(
  agents: readonly Agent[],
  snapshot: HerdrSnapshot,
  resources: Readonly<HerdrResources> = {},
): Reconciliation[] {
  const panes = new Map(snapshot.panes.map((pane) => [pane.id, pane]));
  const out: Reconciliation[] = [];
  for (const agent of agents) {
    const resource = resources[agent.id];
    if (resource?.state === "closed") continue;
    let pane = agent.paneId ? panes.get(agent.paneId) : undefined;
    if (!pane && agent.terminalId)
      pane = snapshot.panes.find(
        (candidate) =>
          (candidate.occupant?.terminalId ?? candidate.terminalId) ===
          agent.terminalId,
      );
    if (!pane) {
      out.push({
        agentId: agent.id,
        kind: "missing",
        reason: "Recorded pane is absent.",
      });
      continue;
    }
    if (!pane.occupant) {
      out.push({
        agentId: agent.id,
        kind: "orphaned",
        paneId: pane.id,
        reason: "Managed pane has no verified occupant.",
      });
      continue;
    }
    const terminalId = pane.occupant.terminalId ?? pane.terminalId;
    if (agent.terminalId && terminalId && agent.terminalId !== terminalId) {
      out.push({
        agentId: agent.id,
        kind: "replaced",
        paneId: pane.id,
        terminalId,
        reason: "Terminal occupant changed.",
      });
      continue;
    }

    const hasWorktreeIdentity = Boolean(
      resource?.worktreeId || resource?.worktreePath || resource?.workspaceId,
    );
    let worktreeIdentity:
      | { worktreeId: string; worktreePath: string; workspaceId: string }
      | undefined;
    if (hasWorktreeIdentity) {
      if (
        !resource?.worktreeId ||
        !resource.worktreePath ||
        !resource.workspaceId
      ) {
        out.push({
          agentId: agent.id,
          kind: "replaced",
          paneId: pane.id,
          ...(terminalId ? { terminalId } : {}),
          reason: "Recorded worktree identity is incomplete.",
        });
        continue;
      }
      const liveMatches = snapshot.worktrees.filter(
        (worktree) => worktree.id === resource.worktreeId,
      );
      if (liveMatches.length === 0) {
        out.push({
          agentId: agent.id,
          kind: "missing",
          paneId: pane.id,
          ...(terminalId ? { terminalId } : {}),
          reason: "Recorded worktree is absent.",
        });
        continue;
      }
      if (liveMatches.length !== 1) {
        out.push({
          agentId: agent.id,
          kind: "replaced",
          paneId: pane.id,
          ...(terminalId ? { terminalId } : {}),
          reason: "Recorded worktree identity is ambiguous.",
        });
        continue;
      }
      const live = liveMatches[0]!;
      if (
        live.path !== resource.worktreePath ||
        live.workspaceId !== resource.workspaceId
      ) {
        out.push({
          agentId: agent.id,
          kind: "replaced",
          paneId: pane.id,
          ...(terminalId ? { terminalId } : {}),
          reason: "Recorded worktree identity changed.",
        });
        continue;
      }
      worktreeIdentity = {
        worktreeId: resource.worktreeId,
        worktreePath: live.path,
        workspaceId: resource.workspaceId,
      };
    }

    out.push({
      agentId: agent.id,
      kind: agent.paneId !== pane.id ? "moved" : "present",
      paneId: pane.id,
      ...(terminalId ? { terminalId } : {}),
      ...worktreeIdentity,
    });
  }
  return out;
}
