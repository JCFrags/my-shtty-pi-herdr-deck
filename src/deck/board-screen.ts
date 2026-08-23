import { visibleWidth } from "@pi-herdr-deck/tui";
import { SurfaceBuilder, composeColumns } from "./geometry.js";
import type { BoardScreenState, RenderedSurface } from "./screen-types.js";
import type {
  BoardFilter,
  BoardAction,
  BoardItem,
  UnifiedBoardPresentation,
} from "./product-presentation.js";

export interface BoardScreenActions {
  select(item: BoardItem): void;
  filter(value: BoardFilter): void;
  answer(item: BoardItem): void;
  run(item: BoardItem, action: BoardAction): void;
}

export interface BoardScreenOptions {
  width: number;
  height: number;
  state: BoardScreenState;
  model: UnifiedBoardPresentation;
  actions: BoardScreenActions;
}

const FILTERS: readonly BoardFilter[] = ["attention", "active", "all-current"];
const SECTION_LABEL: Record<BoardItem["section"], string> = {
  attention: "NEEDS ATTENTION",
  work: "CURRENT WORK",
  "recent-signals": "RECENT SIGNALS",
};

export type BoardListEntry =
  | { kind: "heading"; section: BoardItem["section"] }
  | { kind: "item"; item: BoardItem };

/** Flatten items and section headings into the scrollable Board list. */
export function flattenBoardItems(
  items: readonly BoardItem[],
): BoardListEntry[] {
  const entries: BoardListEntry[] = [];
  let prior: BoardItem["section"] | undefined;
  for (const item of items) {
    if (item.section !== prior) {
      entries.push({ kind: "heading", section: item.section });
      prior = item.section;
    }
    entries.push({ kind: "item", item });
  }
  return entries;
}

/** Render Board independently from BrokerDeckApp. Scroll includes headings. */
export function renderBoardScreen(
  options: BoardScreenOptions,
): RenderedSurface<BoardScreenState> {
  const width = Math.max(1, options.width);
  const height = Math.max(1, options.height);
  const narrow = width < 96;
  const corrected = { ...options.state };
  const list = options.model.visible;
  const entries = flattenBoardItems(list);
  const selectedIndex = options.model.selected
    ? entries.findIndex(
        (entry) =>
          entry.kind === "item" &&
          entry.item.uiId === options.model.selected!.uiId,
      )
    : -1;
  const listBudget = Math.max(
    1,
    Math.floor((height - 9) * (narrow ? 0.55 : 1)),
  );
  const maxScroll = Math.max(0, entries.length - listBudget);
  corrected.listScroll = clamp(corrected.listScroll, 0, maxScroll);
  if (!corrected.wheelDetached && selectedIndex >= 0) {
    if (selectedIndex < corrected.listScroll)
      corrected.listScroll = selectedIndex;
    else if (selectedIndex >= corrected.listScroll + listBudget)
      corrected.listScroll = Math.min(
        maxScroll,
        selectedIndex - listBudget + 1,
      );
  }
  const visible = entries.slice(
    corrected.listScroll,
    corrected.listScroll + listBudget,
  );
  const listWidth = narrow ? width : Math.floor(width * 0.46);
  const listSurface = renderList(
    listWidth,
    visible,
    options.model,
    options.actions,
  );
  const detailSurface = renderDetail(
    width,
    options.model.selected,
    options.actions,
  );
  const body = narrow
    ? stack(listSurface, detailSurface)
    : composeColumns(
        listSurface,
        detailSurface,
        Math.floor(width * 0.46),
        width - Math.floor(width * 0.46) - 1,
      );
  const shell = new SurfaceBuilder(width);
  shell.addLine(
    `BOARD  ${options.model.counts.work} current · ${options.model.counts.attention} need attention · ${options.model.counts.recentSignals} recent Signals`,
  );
  shell.addButtons(
    FILTERS.map((filter) => ({
      id: `board:filter:${filter}`,
      label: options.model.filter === filter ? `[${filter}]` : filter,
      activate: () => options.actions.filter(filter),
    })),
  );
  for (const line of body.lines) shell.addLine(line);
  for (const box of body.hitBoxes) shell.addHitBox({ ...box, y: box.y + 2 });
  for (const region of body.regions)
    shell.addRegion({ ...region, y: region.y + 2 });
  return shell.finish({
    correctedState: corrected,
    ...(options.model.selected?.uiId
      ? { effectiveSelectedId: options.model.selected.uiId }
      : {}),
  });
}

function renderList(
  width: number,
  entries: BoardListEntry[],
  model: UnifiedBoardPresentation,
  actions: BoardScreenActions,
): RenderedSurface {
  const surface = new SurfaceBuilder(width);
  for (const entry of entries) {
    if (entry.kind === "heading") {
      surface.addLine(SECTION_LABEL[entry.section]);
      continue;
    }
    const item = entry.item;
    const badge = `[${item.sourceLabel}]`;
    const marker = item.uiId === model.selected?.uiId ? ">" : " ";
    surface.addRow(
      `board:item:${item.uiId}`,
      `${marker} ${badge} ${item.status}  ${item.title}`,
      () => actions.select(item),
    );
  }
  if (entries.length === 0) surface.addLine("✓ No items match this filter.");
  return surface.finish();
}

function renderDetail(
  width: number,
  selected: BoardItem | undefined,
  actions: BoardScreenActions,
): RenderedSurface {
  const surface = new SurfaceBuilder(width);
  if (!selected) {
    surface.addLine("DETAIL");
    surface.addLine("Select an item.");
    return surface.finish();
  }
  surface.addLine(
    `DETAIL  [${selected.sourceLabel}] ${selected.kind.toUpperCase()}`,
  );
  surface.addLine(selected.title);
  surface.addLine(selected.summary);
  surface.addLine(`State: ${selected.state}`);
  for (const line of typedDetailLines(selected)) surface.addLine(line);
  if (selected.actions.actions.includes("answer"))
    surface.addButtons([
      {
        id: "board:answer",
        label: "Answer",
        activate: () => actions.answer(selected),
      },
    ]);
  const actionsToShow = selected.actions.actions.filter(
    (action) => action !== "answer",
  );
  surface.addButtons(
    actionsToShow.map((action) => ({
      id: `board:action:${action}`,
      label: actionLabel(action),
      activate: () => actions.run(selected, action),
    })),
  );
  return surface.finish();
}

function typedDetailLines(selected: BoardItem): string[] {
  switch (selected.kind) {
    case "todo":
      return [
        `Todo: ${selected.source.text}`,
        `Wait: ${selected.source.waitReason ?? "none"}`,
        `Provider: ${selected.sourceLabel}`,
      ];
    case "task":
      return [
        `Objective: ${selected.source.objective}`,
        `Agent: ${selected.ownerAgentId ?? "unassigned"}`,
        `Run: ${selected.relatedRunId ?? "none"}`,
      ];
    case "group":
      return [
        `Objective: ${selected.source.objective ?? "none"}`,
        `Members: ${selected.source.agentIds?.length ?? 0}`,
        `Tasks: ${selected.source.taskIds?.length ?? 0}`,
      ];
    case "broker-question":
      return [
        `Question: ${selected.source.prompt}`,
        `Options: ${selected.source.options?.map((option) => option.label).join(", ") || "free text"}`,
      ];
    case "signal-question":
      return [
        `Question: ${String(selected.source.question ?? selected.source.title ?? selected.title)}`,
        `Revision: ${selected.revision ?? "unknown"}`,
      ];
    case "signal-update":
      return [
        `Kind: ${String(selected.source.kind ?? "unknown")}`,
        `Stage: ${String(selected.source.stage ?? "unknown")}`,
        `Revision: ${selected.revision ?? "unknown"}`,
      ];
    case "agent-alert":
      return [
        `Agent: ${selected.source.displayName ?? selected.source.herdrName}`,
        `Pane: ${selected.source.paneId ?? "none"}`,
      ];
  }
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    "cancel-task": "Cancel task",
    "focus-agent": "Focus",
    "open-agents": "Open Agents",
    "mark-done": "Mark done",
    "clear-wait": "Clear wait",
    "use-recommendation": "Use recommendation",
    "dismiss-question": "Dismiss",
    "retry-delivery": "Retry delivery",
    "archive-update": "Archive",
    wait: "Wait group",
    stop: "Stop group",
    close: "Close group",
  };
  return labels[action] ?? action;
}

function stack(top: RenderedSurface, bottom: RenderedSurface): RenderedSurface {
  const lines = [...top.lines, "", ...bottom.lines];
  const offset = top.lines.length + 1;
  return {
    lines,
    hitBoxes: [
      ...top.hitBoxes,
      ...bottom.hitBoxes.map((box) => ({ ...box, y: box.y + offset })),
    ],
    regions: [
      ...top.regions,
      ...bottom.regions.map((region) => ({ ...region, y: region.y + offset })),
    ],
  };
}
function clamp(value: number, min: number, max: number): number {
  return Math.max(
    min,
    Math.min(max, Number.isFinite(value) ? Math.floor(value) : min),
  );
}

export function boardIsNarrow(width: number): boolean {
  return width < 96;
}
export function boardTextWidth(text: string): number {
  return visibleWidth(text);
}
