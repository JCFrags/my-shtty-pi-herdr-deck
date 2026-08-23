import type { DeckNotification, DeckState } from "./types.js";
import {
  selectActivityPresentation,
  type ActivityFilter,
  type ActivityItem,
} from "./product-presentation.js";
import { SurfaceBuilder, composeColumns } from "./geometry.js";
import type { ActivityScreenState, RenderedSurface } from "./screen-types.js";
import {
  renderResultDetail,
  renderTaskDetail,
  renderGroupDetail,
  renderAgentInspector,
} from "./views.js";
import { selectAdoptedScope } from "./scope.js";

export type ActivityAction = "copy-id" | "focus" | "archive" | "retry-delivery";
export interface ActivityActionContract {
  isAllowed(item: ActivityItem, action: ActivityAction): boolean;
  activate(item: ActivityItem, action: ActivityAction): void;
}
export interface ActivityRenderInput {
  state: DeckState;
  targetPaneId?: string;
  notifications?: readonly DeckNotification[];
  screen: ActivityScreenState;
  width?: number;
  height?: number;
  onSelect?(id: string): void;
  actions?: ActivityActionContract;
}
export interface ActivityWheelResult {
  state: ActivityScreenState;
  handled: boolean;
}

const filters: readonly ActivityFilter[] = [
  "all",
  "results",
  "signals",
  "agents",
  "errors",
];
const sourceBadge = (item: ActivityItem): string => {
  if (item.kind.startsWith("signal-")) return "SIGNALS";
  if (item.kind.startsWith("system-")) return "SYSTEM";
  return "ORCHESTRATOR";
};
const actionLabel = (action: ActivityAction): string =>
  action.replaceAll("-", " ");

export function cycleActivityFilter(filter: ActivityFilter): ActivityFilter {
  return filters[(filters.indexOf(filter) + 1) % filters.length]!;
}

/** Wheel changes only the pane under the pointer. It never changes selection. */
export function applyActivityWheel(
  state: ActivityScreenState,
  region: "list" | "detail" | "outside",
  direction: "up" | "down",
): ActivityWheelResult {
  if (region === "outside") return { state, handled: false };
  const delta = direction === "down" ? 1 : -1;
  return {
    handled: true,
    state:
      region === "list"
        ? {
            ...state,
            listScroll: Math.max(0, state.listScroll + delta),
            wheelDetached: true,
          }
        : { ...state, detailScroll: Math.max(0, state.detailScroll + delta) },
  };
}

function detailLines(
  item: ActivityItem | undefined,
  input: ActivityRenderInput,
  width: number,
): string[] {
  if (!item) return ["DETAIL", "No activity item selected."];
  const scoped = selectAdoptedScope(input.state, input.targetPaneId).state;
  switch (item.kind) {
    case "result":
      return renderResultDetail(item.source, width);
    case "terminal-task":
      return renderTaskDetail(item.source, scoped, width);
    case "terminal-group":
      return renderGroupDetail(item.source, width);
    case "terminal-agent":
      return renderAgentInspector(item.source, scoped, width);
    default:
      return [
        "ACTIVITY DETAIL",
        `Source: ${sourceBadge(item)}`,
        `ID: ${item.entityId}`,
        `Title: ${item.title}`,
        `State: ${item.state}`,
        `Summary: ${item.summary}`,
      ];
  }
}

function renderPane(
  input: ActivityRenderInput,
  width: number,
): { surface: RenderedSurface; selected?: ActivityItem } {
  const model = selectActivityPresentation(
    input.state,
    input.targetPaneId,
    input.screen.selectedId,
    input.screen.filter,
    input.notifications ?? [],
  );
  const selected = model.selected;
  const rowBudget = Math.max(1, (input.height ?? 24) - 6);
  const list = new SurfaceBuilder(width);
  list.addLine(
    `ACTIVITY · ${model.filter.toUpperCase()} · ${model.counts[model.filter]} shown`,
  );
  list.addButtons(
    filters.map((filter) => ({
      id: `activity:filter:${filter}`,
      label: filter,
      focused: filter === model.filter,
      activate: () => input.onSelect?.(`filter:${filter}`),
    })),
  );
  list.addLine("Source       State          Activity");
  const visible = model.items.slice(
    input.screen.listScroll,
    input.screen.listScroll + rowBudget,
  );
  for (const item of visible) {
    const marker = item.uiId === selected?.uiId ? ">" : " ";
    list.addRow(
      `activity:row:${item.uiId}`,
      `${marker}${sourceBadge(item).padEnd(12)} ${item.state.padEnd(14)} ${item.title}`,
      () => input.onSelect?.(item.uiId),
    );
  }
  if (model.items.length === 0)
    list.addLine("No historical activity is available.");
  if (
    input.screen.listScroll > 0 ||
    input.screen.listScroll + visible.length < model.items.length
  )
    list.addLine(
      `↕ ${input.screen.listScroll + 1}-${input.screen.listScroll + visible.length} of ${model.items.length}`,
    );
  const detail = new SurfaceBuilder(width);
  detail.addLine(`DETAIL · ${selected?.kind ?? "none"}`);
  detail.addLine("");
  const detailContent = detailLines(selected, input, width);
  for (const line of detailContent.slice(
    input.screen.detailScroll,
    input.screen.detailScroll + Math.max(1, (input.height ?? 24) - 3),
  ))
    detail.addLine(line);
  if (selected) {
    detail.addLine("");
    detail.addButtons(
      selected.actions.actions.map((action) => {
        const typed = action as ActivityAction;
        return {
          id: `activity:action:${selected.uiId}:${typed}`,
          label: actionLabel(typed),
          disabled: input.actions
            ? !input.actions.isAllowed(selected, typed)
            : false,
          activate: () => input.actions?.activate(selected, typed),
        };
      }),
    );
  }
  const left = list.finish();
  const right = detail.finish();
  const surface =
    width < 90
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
          Math.max(1, Math.floor(width * 0.42)),
          Math.max(1, width - Math.floor(width * 0.42) - 1),
        );
  return { surface, ...(selected ? { selected } : {}) };
}

/** Rendered geometry is the integration contract. BrokerDeckApp may place the lines and hit boxes. */
export function renderActivity(
  input: ActivityRenderInput,
  width = input.width ?? 120,
): RenderedSurface<ActivityScreenState> {
  return renderActivityAtWidth(input, width);
}

export function renderActivityAtWidth(
  input: ActivityRenderInput,
  width: number,
): RenderedSurface<ActivityScreenState> {
  const model = selectActivityPresentation(
    input.state,
    input.targetPaneId,
    input.screen.selectedId,
    input.screen.filter,
    input.notifications ?? [],
  );
  const maxListScroll = Math.max(
    0,
    model.items.length - Math.max(1, (input.height ?? 24) - 6),
  );
  const correctedState =
    input.screen.listScroll > maxListScroll
      ? { ...input.screen, listScroll: maxListScroll }
      : input.screen;
  const rendered = renderPane(
    { ...input, screen: correctedState },
    Math.max(1, width),
  );
  return {
    ...rendered.surface,
    correctedState,
    ...(rendered.selected
      ? { effectiveSelectedId: rendered.selected.uiId }
      : {}),
  };
}
