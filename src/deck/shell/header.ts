import { truncateToWidth, visibleWidth } from "@pi-herdr-deck/tui";
import type { HitBox } from "../components/controls.js";
import { renderButton } from "../components/controls.js";
import type {
  AgentBoardTab,
  ShellHeaderPresentation,
} from "../screen-types.js";

export interface HeaderActions {
  selectTab(tab: AgentBoardTab): void;
  toggleSettings(): void;
  toggleHelp(): void;
}

export interface RenderedHeader {
  lines: string[];
  hitBoxes: HitBox[];
}

function bounded(value: string, width: number): string {
  return truncateToWidth(value, Math.max(1, width));
}

/** Render the shell header and emit hit boxes from terminal-cell coordinates. */
export function renderHeader(
  width: number,
  presentation: ShellHeaderPresentation,
  actions?: HeaderActions,
): RenderedHeader {
  const safeWidth = Math.max(1, width);
  const scope = bounded(
    presentation.scopeLabel,
    Math.min(36, Math.max(12, safeWidth - 35)),
  );
  const status = presentation.online ? "● ONLINE" : "○ OFFLINE";
  const first = `${presentation.productName}  ${status}  ${scope}  ⚠ ${presentation.attentionCount}`;
  const lines = [bounded(first, safeWidth)];
  const hitBoxes: HitBox[] = [];
  const tabs: Array<{ id: string; label: string; tab: AgentBoardTab }> = [
    { id: "tab:board", label: "Board 1", tab: "board" },
    { id: "tab:files", label: "Files 2", tab: "files" },
    { id: "tab:agents", label: "Agents 3", tab: "agents" },
    { id: "tab:activity", label: "Activity 4", tab: "activity" },
  ];
  let row = "";
  const entries: Array<{
    id: string;
    x: number;
    width: number;
    activate: () => void;
  }> = [];
  for (const item of tabs) {
    const label = renderButton(
      presentation.selectedTab === item.tab
        ? item.label.toUpperCase()
        : item.label,
    );
    const separator = row ? " " : "";
    if (
      visibleWidth(row) + visibleWidth(separator) + visibleWidth(label) >
      safeWidth
    )
      break;
    const x = visibleWidth(row) + visibleWidth(separator);
    row += `${separator}${label}`;
    if (actions)
      entries.push({
        id: item.id,
        x,
        width: visibleWidth(label),
        activate: () => actions.selectTab(item.tab),
      });
  }
  for (const item of [
    {
      id: "header:settings",
      label: "Settings ,",
      activate: actions?.toggleSettings,
    },
    { id: "header:help", label: "Help ?", activate: actions?.toggleHelp },
  ]) {
    if (!item.activate) continue;
    const label = renderButton(item.label);
    const separator = row ? " " : "";
    if (
      visibleWidth(row) + visibleWidth(separator) + visibleWidth(label) >
      safeWidth
    )
      break;
    const x = visibleWidth(row) + visibleWidth(separator);
    row += `${separator}${label}`;
    entries.push({
      id: item.id,
      x,
      width: visibleWidth(label),
      activate: item.activate,
    });
  }
  lines.push(truncateToWidth(row, safeWidth));
  for (const entry of entries)
    hitBoxes.push({
      id: entry.id,
      x: entry.x,
      y: 1,
      width: entry.width,
      height: 1,
      disabled: false,
      activate: entry.activate,
    });
  return { lines, hitBoxes };
}

export function adoptedScopeLabel(
  rootName: string | undefined,
  agentCount: number,
): string {
  const name = rootName ? bounded(rootName, 22) : "unavailable";
  return `Scope ${name} + ${Math.max(0, agentCount - (rootName ? 1 : 0))} children`;
}
