import type { Agent } from "../../state/types.js";
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
  surface.addButtons([
    {
      id: "agent-more:compact",
      label: "Compact",
      disabled: agent?.state !== "idle",
      activate: options.onCompact,
    },
    {
      id: "agent-more:restart",
      label: "Restart",
      disabled: !agent || ["stopped", "replaced"].includes(agent.state),
      activate: options.onRestart,
    },
    {
      id: "agent-more:close",
      label: "Close",
      disabled: !agent,
      activate: options.onCloseAgent,
    },
    {
      id: "agent-more:worktree",
      label: "Open worktree",
      disabled: !agent?.cwd,
      activate: options.onWorktree,
    },
    {
      id: "agent-more:copy",
      label: "Copy ID",
      disabled: !agent,
      activate: options.onCopy,
    },
    {
      id: "agent-more:model",
      label: "Running model",
      disabled: !agent,
      activate: options.onModel,
    },
    {
      id: "agent-more:thinking",
      label: "Thinking level",
      disabled: !agent,
      activate: options.onThinking,
    },
    {
      id: "agent-more:create",
      label: "Create child agent",
      disabled: !agent?.cwd,
      activate: options.onCreate,
    },
    {
      id: "agent-more:close-drawer",
      label: "Close drawer",
      activate: options.onClose,
    },
  ]);
  return surface.finish();
}
