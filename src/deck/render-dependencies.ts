import type { DeckState } from "./types.js";
import { currentProviderProjection } from "./views.js";

export type VisibleDeckTab = "home" | "work" | "files" | "agents" | "inbox" | "more";
export type VisibleWorkView = "todo" | "tasks" | "results" | "groups" | "history";

export interface VisibleSurfaceContext {
  tab: VisibleDeckTab;
  workView: VisibleWorkView;
  targetPaneId?: string;
}

const TRANSPORT_KEYS = /^(seq|adapterSeq|heartbeatAt|lastHeartbeatAt|updatedAt|timestamp)$/i;

function semanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (value instanceof Map)
    return [...value.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, item]) => [key, semanticValue(item)]);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !TRANSPORT_KEYS.test(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, semanticValue(item)]),
    );
  return value;
}

/** Select only broker state that can affect the active visible surface. */
export function visibleSurfaceSignature(
  state: DeckState,
  context: VisibleSurfaceContext,
): string {
  const provider = currentProviderProjection(state, context.targetPaneId);
  const owner = provider ? state.agents.get(provider.ownerAgentId) : undefined;
  const authority = provider
    ? {
        ownerAgentId: provider.ownerAgentId,
        piSessionId: provider.piSessionId,
        owner: owner
          ? {
              id: owner.id,
              paneId: owner.paneId,
              parentAgentId: owner.parentAgentId,
              state: owner.state,
              piSessionId: owner.piSessionId,
              connectionGeneration: owner.connectionGeneration,
            }
          : undefined,
      }
    : undefined;

  let selected: unknown;
  if (context.tab === "files") selected = { authority, files: provider?.files };
  else if (context.tab === "inbox")
    selected = { authority, board: provider?.agentBoard, questions: state.questions };
  else if (context.tab === "agents")
    selected = { agents: state.agents, tasks: state.tasks, runs: state.runs, questions: state.questions };
  else if (context.tab === "work") {
    if (context.workView === "todo") selected = { authority, todo: provider?.todo };
    else if (context.workView === "tasks")
      selected = { agents: state.agents, tasks: state.tasks, runs: state.runs, questions: state.questions, results: state.results };
    else if (context.workView === "results") selected = { agents: state.agents, tasks: state.tasks, runs: state.runs, results: state.results };
    else if (context.workView === "groups") selected = { agents: state.agents, tasks: state.tasks, runs: state.runs, groups: state.groups };
    else selected = { agents: state.agents, tasks: state.tasks, runs: state.runs, results: state.results };
  } else if (context.tab === "home")
    selected = {
      authority,
      agents: state.agents,
      tasks: state.tasks,
      runs: state.runs,
      questions: state.questions,
      results: state.results,
      providerSummary: provider
        ? { todo: provider.todo, agentBoard: provider.agentBoard, files: provider.files }
        : undefined,
    };
  else selected = {};

  return JSON.stringify(semanticValue(selected));
}
