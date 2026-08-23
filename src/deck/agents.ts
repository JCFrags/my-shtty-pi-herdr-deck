import type { Agent } from "../state/types.js";
import type { DeckAction, ActionTarget } from "./actions.js";
import { SurfaceBuilder, composeColumns } from "./geometry.js";
import type { AgentsScreenState, RenderedSurface } from "./screen-types.js";
import {
  selectAgentListPresentation,
  selectAgentInspectorRelation,
} from "./selections.js";
import type { DeckState } from "./types.js";

export type AgentContractAction = DeckAction | "create-child-agent";
export interface AgentActionContract {
  authorize(
    action: AgentContractAction,
    target: ActionTarget,
  ): string | undefined;
  activate(action: AgentContractAction, target: ActionTarget): void;
}
export interface AgentRenderInput {
  state: DeckState;
  screen: AgentsScreenState;
  width: number;
  pageSize?: number;
  actions?: AgentActionContract;
  onSelect?(id: string): void;
  onOpenMore?(guard: AgentMoreGuard): void;
}
export interface AgentMoreGuard {
  agentId: string;
  generation: number;
}
export interface AgentMorePresentation {
  guard: AgentMoreGuard;
  focusedIndex: number;
  actions: readonly AgentMoreAction[];
  closeOnEscape: true;
}
export type AgentPrimaryAction = DeckAction | "more";
export interface AgentMoreAction {
  id: DeckAction | "copyId" | "create-child-agent";
  label: string;
  disabled: boolean;
  activate(): void;
}

const actionLabels: readonly [AgentPrimaryAction, string][] = [
  ["focus", "Focus"],
  ["prompt", "Prompt"],
  ["ask", "Ask"],
  ["steer", "Steer"],
  ["followUp", "Follow-up"],
  ["interrupt", "Interrupt"],
  ["stop", "Stop"],
  ["more", "More"],
];
const moreLabels: readonly [
  DeckAction | "copyId" | "create-child-agent",
  string,
][] = [
  ["compact", "Compact"],
  ["restart", "Restart"],
  ["close", "Close"],
  ["openWorktree", "Open worktree"],
  ["copyId", "Copy ID"],
  ["setModel", "Running model"],
  ["setThinking", "Thinking level"],
  ["create-child-agent", "Create child agent"],
];
const activeStates = new Set([
  "provisioning",
  "starting",
  "working",
  "blocked",
  "stopping",
]);
const name = (agent: Agent): string =>
  agent.displayName ?? agent.herdrName ?? agent.id;
const targetFor = (agent: Agent): ActionTarget => ({
  agent,
  generation: agent.generation,
  ...(agent.paneId ? { paneId: agent.paneId } : {}),
  ...(agent.terminalId ? { terminalId: agent.terminalId } : {}),
  ...(agent.currentRunId ? { runId: agent.currentRunId } : {}),
});

export function agentMoreGuard(
  agent: Agent | undefined,
): AgentMoreGuard | undefined {
  return agent
    ? { agentId: agent.id, generation: agent.generation }
    : undefined;
}
export function isAgentMoreGuardCurrent(
  state: DeckState,
  guard: AgentMoreGuard,
): boolean {
  const agent = state.agents.get(guard.agentId);
  return Boolean(agent && agent.generation === guard.generation);
}
export function agentPrimaryActions(
  agent: Agent,
  actions?: AgentActionContract,
): Array<{ action: AgentPrimaryAction; label: string; disabled: boolean }> {
  const target = targetFor(agent);
  return actionLabels.map(([action, label]) => ({
    action,
    label,
    disabled:
      action === "more" ? false : Boolean(actions?.authorize(action, target)),
  }));
}

/** A row hit box is keyed by the canonical agent ID, never by display name. */
export function renderAgents(
  input: AgentRenderInput,
): RenderedSurface<AgentsScreenState> {
  const scoped = input.state;
  const presentation = selectAgentListPresentation(
    scoped.agents.values(),
    input.screen.filter,
    input.screen.requestedPage,
    input.screen.selectedId,
    input.pageSize ?? 12,
  );
  const selected = presentation.selected;
  const correctedState = {
    ...input.screen,
    requestedPage: presentation.safePage,
    ...(selected ? { selectedId: selected.id } : {}),
  };
  const list = new SurfaceBuilder(Math.max(1, input.width));
  list.addLine(
    `AGENTS · ${input.screen.filter.toUpperCase()} · page ${presentation.safePage + 1}/${presentation.pageCount}`,
  );
  list.addLine(
    `${presentation.matchingCount} matching · duplicate display names remain separate rows`,
  );
  list.addButtons(
    (["active", "idle", "history"] as const).map((filter) => ({
      id: `agents:filter:${filter}`,
      label: filter,
      focused: filter === input.screen.filter,
      activate: () => input.onSelect?.(`filter:${filter}`),
    })),
  );
  for (const agent of presentation.visible) {
    const marker = agent.id === selected?.id ? ">" : " ";
    list.addRow(
      `agents:row:${agent.id}`,
      `${marker} ${name(agent)} · ${agent.state} · ${agent.id}`,
      () => input.onSelect?.(agent.id),
    );
  }
  if (presentation.visible.length === 0)
    list.addLine("No agents match this view.");
  const detail = new SurfaceBuilder(Math.max(1, input.width));
  detail.addLine("AGENT DETAIL");
  if (selected) {
    const relation = selectAgentInspectorRelation(selected, scoped);
    detail.addLine(`ID: ${selected.id} · generation ${selected.generation}`);
    detail.addLine(`Identity: ${selected.id}`);
    detail.addLine(`Name: ${name(selected)}`);
    detail.addLine(`State: ${selected.state}`);
    detail.addLine(
      `Run: ${relation.run?.id ?? selected.currentRunId ?? "none"}`,
    );
    detail.addLine(`Task: ${relation.task?.id ?? "none"}`);
    detail.addButtons(
      agentPrimaryActions(selected, input.actions).map(
        ({ action, label, disabled }) => ({
          id: `agents:action:${selected.id}:${action}`,
          label,
          disabled,
          activate: () => {
            if (action === "more")
              input.onOpenMore?.(agentMoreGuard(selected)!);
            else input.actions?.activate(action, targetFor(selected));
          },
        }),
      ),
    );
  } else detail.addLine("No agent selected.");
  const left = list.finish();
  const right = detail.finish();
  const surface =
    input.width < 90
      ? {
          lines: [...left.lines, "", ...right.lines],
          hitBoxes: [
            ...left.hitBoxes,
            ...right.hitBoxes.map((box) => ({
              ...box,
              y: box.y + left.lines.length + 1,
            })),
          ],
          regions: [],
        }
      : composeColumns(
          left,
          right,
          Math.max(1, Math.floor(input.width * 0.42)),
          Math.max(1, input.width - Math.floor(input.width * 0.42) - 1),
        );
  return {
    ...surface,
    correctedState,
    ...(selected ? { effectiveSelectedId: selected.id } : {}),
  };
}

export function openAgentMore(
  state: DeckState,
  guard: AgentMoreGuard,
  focusedIndex = 0,
  authorization?: AgentActionContract,
): AgentMorePresentation | undefined {
  if (!isAgentMoreGuardCurrent(state, guard)) return undefined;
  const agent = state.agents.get(guard.agentId)!;
  const target = targetFor(agent);
  const actions: AgentMoreAction[] = moreLabels.map(([id, label]) => ({
    id,
    label,
    disabled:
      id === "create-child-agent"
        ? Boolean(authorization?.authorize("create-child-agent", target))
        : id !== "copyId" && Boolean(authorization?.authorize(id, target)),
    activate: () => undefined,
  }));
  return {
    guard,
    focusedIndex: Math.max(0, Math.min(actions.length - 1, focusedIndex)),
    actions,
    closeOnEscape: true,
  };
}

/** Keyboard and mouse use the same focused action index. A stale guard closes the overlay. */
export function moveAgentMoreFocus(
  presentation: AgentMorePresentation,
  delta: number,
): AgentMorePresentation {
  const count = presentation.actions.length;
  return {
    ...presentation,
    focusedIndex: count
      ? Math.max(0, Math.min(count - 1, presentation.focusedIndex + delta))
      : 0,
  };
}
export function agentMoreFocusFromMouse(
  presentation: AgentMorePresentation,
  actionIndex: number,
): AgentMorePresentation {
  return {
    ...presentation,
    focusedIndex: Math.max(
      0,
      Math.min(presentation.actions.length - 1, actionIndex),
    ),
  };
}

export function handleAgentMoreKey(
  presentation: AgentMorePresentation,
  key: "ArrowUp" | "ArrowDown" | "Enter" | "Escape",
  state: DeckState,
  input: AgentActionContract,
): {
  presentation?: AgentMorePresentation;
  activated: boolean;
  closed: boolean;
} {
  if (key === "Escape") return { activated: false, closed: true };
  if (key === "ArrowUp" || key === "ArrowDown")
    return {
      presentation: moveAgentMoreFocus(
        presentation,
        key === "ArrowDown" ? 1 : -1,
      ),
      activated: false,
      closed: false,
    };
  return {
    presentation,
    activated: activateAgentMore(state, presentation, input),
    closed: false,
  };
}

export function activateAgentMore(
  state: DeckState,
  presentation: AgentMorePresentation,
  input: AgentActionContract,
): boolean {
  if (!isAgentMoreGuardCurrent(state, presentation.guard)) return false;
  const item = presentation.actions[presentation.focusedIndex];
  if (!item || item.disabled) return false;
  const agent = state.agents.get(presentation.guard.agentId)!;
  const target = targetFor(agent);
  if (item.id === "create-child-agent") {
    if (input.authorize("create-child-agent", target)) return false;
    input.activate("create-child-agent", target);
  } else if (item.id === "copyId") {
    input.activate("copyId", target);
  } else {
    if (input.authorize(item.id, target)) return false;
    input.activate(item.id, target);
  }
  return true;
}

export function isActiveAgent(agent: Agent): boolean {
  return activeStates.has(agent.state);
}
