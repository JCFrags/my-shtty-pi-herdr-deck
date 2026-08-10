import type { HerdrSnapshot } from "./types.js";
import type { Agent } from "../state/types.js";
export type ReconciliationKind =
  "present" | "moved" | "missing" | "replaced" | "orphaned" | "unknown";
export interface Reconciliation {
  agentId: string;
  kind: ReconciliationKind;
  paneId?: string;
  terminalId?: string;
  reason?: string;
}
export function reconcileAgents(
  agents: readonly Agent[],
  snapshot: HerdrSnapshot,
): Reconciliation[] {
  const panes = new Map(snapshot.panes.map((p) => [p.id, p]));
  const out: Reconciliation[] = [];
  for (const a of agents) {
    let pane = a.paneId ? panes.get(a.paneId) : undefined;
    if (!pane && a.terminalId)
      pane = snapshot.panes.find(
        (p) => (p.occupant?.terminalId ?? p.terminalId) === a.terminalId,
      );
    if (!pane) {
      out.push({
        agentId: a.id,
        kind: "missing",
        reason: "Recorded pane is absent.",
      });
      continue;
    }
    const terminal = pane.occupant?.terminalId ?? pane.terminalId;
    if (a.terminalId && terminal && a.terminalId !== terminal) {
      out.push({
        agentId: a.id,
        kind: "replaced",
        paneId: pane.id,
        terminalId: terminal,
        reason: "Terminal occupant changed.",
      });
      continue;
    }
    if (a.paneId !== pane.id) {
      out.push({
        agentId: a.id,
        kind: "moved",
        paneId: pane.id,
        ...(terminal ? { terminalId: terminal } : {}),
      });
      continue;
    }
    out.push({
      agentId: a.id,
      kind: "present",
      paneId: pane.id,
      ...(terminal ? { terminalId: terminal } : {}),
    });
  }
  return out;
}
