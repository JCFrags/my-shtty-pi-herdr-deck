import type { Agent } from "../../state/types.js";
import type { AgentMorePresentation } from "../agents.js";
import type { RenderedSurface } from "../screen-types.js";
import { SurfaceBuilder } from "../geometry.js";

export interface AgentMoreScreenOptions {
  width: number;
  agent?: Agent | undefined;
  onCompact(): void;
  onRestart(): void;
  onCloseAgent(): void;
  onWorktree(): void;
  onCopy(): void;
  onModel(): void;
  onThinking(): void;
  onCreate(): void;
  onClose(): void;
  presentation?: AgentMorePresentation;
  onActivate?(index: number): void;
}

export function renderAgentMoreScreen(
  options: AgentMoreScreenOptions,
): RenderedSurface {
  const surface = new SurfaceBuilder(options.width);
  const agent = options.agent;
  surface.addLine("AGENT MORE  Escape closes");
  surface.addLine(
    agent
      ? `${agent.displayName ?? agent.herdrName ?? agent.id} · ${agent.state}`
      : "Agent is unavailable",
  );
  surface.addLine("");
  const fallback = [
    {
      id: "compact",
      label: "Compact",
      disabled: agent?.state !== "idle",
      activate: options.onCompact,
    },
    {
      id: "restart",
      label: "Restart",
      disabled: !agent || ["stopped", "replaced"].includes(agent.state),
      activate: options.onRestart,
    },
    {
      id: "close",
      label: "Close",
      disabled: !agent,
      activate: options.onCloseAgent,
    },
    {
      id: "openWorktree",
      label: "Open worktree",
      disabled: !agent?.cwd,
      activate: options.onWorktree,
    },
    {
      id: "copyId",
      label: "Copy ID",
      disabled: !agent,
      activate: options.onCopy,
    },
    {
      id: "setModel",
      label: "Running model",
      disabled: !agent,
      activate: options.onModel,
    },
    {
      id: "setThinking",
      label: "Thinking level",
      disabled: !agent,
      activate: options.onThinking,
    },
    {
      id: "create-child-agent",
      label: "Create child agent",
      disabled: !agent?.cwd,
      activate: options.onCreate,
    },
  ];
  const buttons = options.presentation
    ? options.presentation.actions.map((action) => ({
        id: `agent-more:${action.id}`,
        label: action.label,
        disabled: action.disabled,
        focused:
          options.presentation?.actions[options.presentation.focusedIndex] ===
          action,
        activate: () =>
          options.onActivate?.(options.presentation!.actions.indexOf(action)),
      }))
    : fallback;
  surface.addButtons(buttons);
  return surface.finish();
}
