import type { Agent } from "../state/types.js";
import type { ProviderProjection } from "../shared/provider-projections.js";
import type { DeckState } from "./types.js";

function rankProviderCandidates(
  state: DeckState,
  candidates: ProviderProjection[],
): ProviderProjection[] {
  return candidates.sort((a, b) => {
    const agentA = state.agents.get(a.ownerAgentId);
    const agentB = state.agents.get(b.ownerAgentId);
    const score = (
      projection: ProviderProjection,
      agent: Agent | undefined,
    ): number =>
      (agent && projection.piSessionId === agent.piSessionId ? 8 : 0) +
      (agent && !agent.parentAgentId ? 4 : 0) +
      (agent && agent.state !== "idle" ? 1 : 0);
    return (
      (agentB?.connectionGeneration ?? 0) -
        (agentA?.connectionGeneration ?? 0) ||
      score(b, agentB) - score(a, agentA) ||
      a.ownerAgentId.localeCompare(b.ownerAgentId)
    );
  });
}

export function currentProviderProjection(
  state: DeckState,
  targetPaneId?: string,
): ProviderProjection | undefined {
  const candidates = [...state.providerProjections.values()].filter(
    (projection) => {
      const agent = state.agents.get(projection.ownerAgentId);
      return Boolean(
        agent &&
        !["closed", "stopped"].includes(agent.state) &&
        (!targetPaneId || agent.paneId === targetPaneId),
      );
    },
  );
  if (targetPaneId) return rankProviderCandidates(state, candidates)[0];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return undefined;
  const paneIds = new Set(
    candidates.map(
      (candidate) => state.agents.get(candidate.ownerAgentId)?.paneId,
    ),
  );
  if (paneIds.size !== 1 || ![...paneIds][0]) return undefined;
  return rankProviderCandidates(state, candidates)[0];
}

export interface FilesPresentationAuthority {
  provider?: ProviderProjection;
  providerIdentity?: {
    ownerAgentId: string;
    piSessionId?: string;
    connectionGeneration: number;
  };
  canOpenStandalone: boolean;
}

export function selectFilesPresentationAuthority(
  state: DeckState,
  targetPaneId?: string,
): FilesPresentationAuthority {
  const provider = currentProviderProjection(state, targetPaneId);
  const owner = provider ? state.agents.get(provider.ownerAgentId) : undefined;
  const adoptedRoot = selectAdoptedRootAgent(state, targetPaneId);
  return {
    ...(provider ? { provider } : {}),
    ...(provider
      ? {
          providerIdentity: {
            ownerAgentId: provider.ownerAgentId,
            ...(provider.piSessionId
              ? { piSessionId: provider.piSessionId }
              : {}),
            connectionGeneration: owner?.connectionGeneration ?? 0,
          },
        }
      : {}),
    canOpenStandalone: Boolean(adoptedRoot),
  };
}

export function selectAdoptedRootAgent(
  state: DeckState,
  targetPaneId?: string,
): Agent | undefined {
  const authoritative = currentProviderProjection(state, targetPaneId);
  const owner = authoritative
    ? state.agents.get(authoritative.ownerAgentId)
    : undefined;
  if (owner && !["closed", "stopped"].includes(owner.state)) return owner;
  if (!targetPaneId) return undefined;
  return [...state.agents.values()]
    .filter(
      (agent) =>
        agent.paneId === targetPaneId &&
        !["closed", "stopped"].includes(agent.state),
    )
    .sort(
      (a, b) =>
        (b.connectionGeneration ?? 0) - (a.connectionGeneration ?? 0) ||
        Number(Boolean(b.piSessionId)) - Number(Boolean(a.piSessionId)) ||
        Number(Boolean(a.parentAgentId)) - Number(Boolean(b.parentAgentId)) ||
        a.id.localeCompare(b.id),
    )[0];
}

export interface AdoptedScope {
  rootAgentId?: string;
  rootExists: boolean;
  state: DeckState;
}

export function selectAdoptedScope(
  state: DeckState,
  targetPaneId?: string,
): AdoptedScope {
  const rootAgentId = selectAdoptedRootAgent(state, targetPaneId)?.id;
  const rootExists = Boolean(rootAgentId && state.agents.has(rootAgentId));
  const agentIds = new Set<string>();
  if (rootExists && rootAgentId) agentIds.add(rootAgentId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const agent of state.agents.values()) {
      if (
        agent.parentAgentId &&
        agentIds.has(agent.parentAgentId) &&
        !agentIds.has(agent.id)
      ) {
        agentIds.add(agent.id);
        changed = true;
      }
    }
  }

  const agents = new Map([...state.agents].filter(([id]) => agentIds.has(id)));
  const tasks = new Map(
    [...state.tasks].filter(([, task]) => {
      const run = task.currentRunId
        ? state.runs.get(task.currentRunId)
        : undefined;
      return Boolean(
        (task.assignedAgentId && agentIds.has(task.assignedAgentId)) ||
        (run?.agentId && agentIds.has(run.agentId)),
      );
    }),
  );
  const runs = new Map(
    [...state.runs].filter(
      ([id, run]) =>
        Boolean(run.agentId && agentIds.has(run.agentId)) ||
        [...tasks.values()].some((task) => task.currentRunId === id),
    ),
  );
  const taskIds = new Set(tasks.keys());
  const runIds = new Set(runs.keys());
  const results = new Map(
    [...state.results].filter(([, result]) =>
      Boolean(
        (result.taskId && taskIds.has(result.taskId)) ||
        (result.runId && runIds.has(result.runId)),
      ),
    ),
  );
  const questions = new Map(
    [...state.questions].filter(([, question]) =>
      Boolean(
        (question.agentId && agentIds.has(question.agentId)) ||
        (question.taskId && taskIds.has(question.taskId)) ||
        (question.runId && runIds.has(question.runId)),
      ),
    ),
  );
  const groups = new Map(
    [...state.groups].filter(([, group]) =>
      Boolean(
        group.agentIds?.some((id) => agentIds.has(id)) ||
        group.taskIds?.some((id) => taskIds.has(id)) ||
        group.questionIds?.some((id) => questions.has(id)) ||
        group.resultIds?.some((id) => results.has(id)),
      ),
    ),
  );

  return {
    ...(rootAgentId ? { rootAgentId } : {}),
    rootExists,
    state: { ...state, agents, tasks, runs, groups, questions, results },
  };
}
