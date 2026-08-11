import type { Agent, AgentState, OrchestrationState } from "./types.js";
const terminal = new Set<AgentState>(["stopped", "failed", "replaced"]);
const allowed: Record<AgentState, readonly AgentState[]> = {
  provisioning: ["starting", "failed", "orphaned"],
  starting: ["idle", "failed", "orphaned"],
  idle: ["working", "stopping", "orphaned", "replaced"],
  working: ["idle", "blocked", "stopping", "orphaned", "replaced"],
  blocked: ["working", "stopping", "orphaned", "replaced"],
  stopping: ["stopped", "orphaned"],
  stopped: [],
  failed: [],
  orphaned: ["idle", "stopped"],
  replaced: [],
};
export function canTransitionAgent(from: AgentState, to: AgentState): boolean {
  return from === to || allowed[from].includes(to);
}
export function transitionAgent(agent: Agent, to: AgentState): Agent {
  if (!canTransitionAgent(agent.state, to))
    throw new Error(`Invalid agent transition ${agent.state} -> ${to}.`);
  return { ...agent, state: to };
}
export function assertAgentGraph(state: OrchestrationState): void {
  const seen = new Set<string>();
  for (const agent of Object.values(state.agents)) {
    if (agent.parentAgentId === agent.id)
      throw new Error("Agent parent cycle.");
    let current = agent,
      depth = 0;
    while (current.parentAgentId) {
      if (++depth > 2) throw new Error("Delegation depth exceeded.");
      if (seen.has(current.id)) throw new Error("Agent parent cycle.");
      seen.add(current.id);
      const parent = state.agents[current.parentAgentId];
      if (!parent) throw new Error("Agent parent is missing.");
      current = parent;
    }
    if (agent.depth !== undefined && agent.depth !== depth)
      throw new Error("Agent depth invariant failed.");
    seen.clear();
    if (agent.currentRunId && terminal.has(agent.state))
      throw new Error("Terminal agent has active run.");
  }
}
export function agentView(agent: Agent): Record<string, unknown> {
  const { tokenDigest: _, ...safe } = agent;
  return safe;
}
