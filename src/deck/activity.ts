import type { Agent, Task } from "../state/types.js";
import type { BoardRecord } from "./board-presentation.js";
import type {
  DeckGroup,
  DeckNotification,
  DeckResult,
  DeckState,
} from "./types.js";
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

export type ActivityAction =
  "copy-id" | "focus" | "archive-update" | "retry-delivery";
export interface SignalActivityDetail {
  kind: "signal-update" | "signal-decision" | "signal-history";
  id: string;
  title: string;
  state: string;
  summary: string;
  changedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  terminalAt?: string;
  detail?: string;
  stage?: string;
  outcome?: string;
  answer?: string;
  revision?: number;
  deliveryState?: string;
  retryableDelivery: boolean;
  archivable: boolean;
}
export interface SystemActivityDetail {
  kind: "system-error" | "system-recovery";
  id: string;
  title: string;
  state: string;
  summary: string;
  notificationKind: string;
  sequence: number;
}
export type ActivityDetail =
  | {
      kind: "result";
      source: DeckResult;
      id: string;
      title: string;
      state: string;
      summary: string;
    }
  | {
      kind: "terminal-task";
      source: Task;
      id: string;
      title: string;
      state: string;
      summary: string;
    }
  | {
      kind: "terminal-group";
      source: DeckGroup;
      id: string;
      title: string;
      state: string;
      summary: string;
    }
  | {
      kind: "terminal-agent";
      source: Agent;
      id: string;
      title: string;
      state: string;
      summary: string;
    }
  | SignalActivityDetail
  | SystemActivityDetail;
const activityRecord = (value: unknown): BoardRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as BoardRecord)
    : {};

const activityText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = activityRecord(value);
    const candidate =
      record.text ?? record.summary ?? record.outcome ?? record.statusLabel;
    return typeof candidate === "string" ? candidate : undefined;
  }
  return undefined;
};

export function activityDetail(item: ActivityItem): ActivityDetail {
  const base = {
    id: item.entityId,
    title: item.title,
    state: item.state,
    summary: item.summary,
  };
  switch (item.kind) {
    case "result":
    case "terminal-task":
    case "terminal-group":
    case "terminal-agent":
      return {
        kind: item.kind,
        source: item.source,
        ...base,
      } as ActivityDetail;
    case "system-error":
    case "system-recovery": {
      const source = item.source as BoardRecord;
      return {
        kind: item.kind,
        ...base,
        notificationKind: String(source.state ?? item.state),
        sequence: Number(source.sequence ?? 0),
      } as ActivityDetail;
    }
    default: {
      const source = item.source as BoardRecord;
      return {
        kind: item.kind,
        ...base,
        ...(typeof source.changedAt === "string"
          ? { changedAt: source.changedAt }
          : {}),
        ...(typeof source.createdAt === "string"
          ? { createdAt: source.createdAt }
          : {}),
        ...(typeof source.updatedAt === "string"
          ? { updatedAt: source.updatedAt }
          : {}),
        ...(typeof source.terminalAt === "string"
          ? { terminalAt: source.terminalAt }
          : {}),
        ...(activityText(source.detail)
          ? { detail: activityText(source.detail) }
          : {}),
        ...(typeof source.stage === "string" ? { stage: source.stage } : {}),
        ...(typeof source.outcome === "string"
          ? { outcome: source.outcome }
          : {}),
        ...(activityText(source.answerSummary ?? source.acknowledgementOutcome)
          ? {
              answer: activityText(
                source.answerSummary ?? source.acknowledgementOutcome,
              ),
            }
          : {}),
        ...(typeof source.revision === "number"
          ? { revision: source.revision }
          : {}),
        ...(typeof source.deliveryState === "string"
          ? { deliveryState: source.deliveryState }
          : {}),
        retryableDelivery: source.retryableDelivery === true,
        archivable: source.terminal === true && source.archived !== true,
      } as ActivityDetail;
    }
  }
}
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

export interface ActivityKeyResult {
  state: ActivityScreenState;
  handled: boolean;
  selectedId?: string;
}

/** Keyboard navigation shares the same list selection contract as mouse rows. */
export function handleActivityKey(
  state: ActivityScreenState,
  key: string,
  itemIds: readonly string[],
  visibleCount = Number.POSITIVE_INFINITY,
): ActivityKeyResult {
  if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "j" && key !== "k")
    return { state, handled: false };
  if (itemIds.length === 0) return { state, handled: true };
  const current = Math.max(0, itemIds.indexOf(state.selectedId ?? ""));
  const delta = key === "ArrowUp" || key === "k" ? -1 : 1;
  const index = (current + delta + itemIds.length) % itemIds.length;
  const nextScroll = Number.isFinite(visibleCount)
    ? index < state.listScroll
      ? index
      : index >= state.listScroll + Math.max(1, visibleCount)
        ? index - Math.max(1, visibleCount) + 1
        : state.listScroll
    : state.listScroll;
  return {
    state: { ...state, listScroll: Math.max(0, nextScroll) },
    handled: true,
    ...(itemIds[index] ? { selectedId: itemIds[index] } : {}),
  };
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
const supportedActions = new Set<ActivityAction>([
  "copy-id",
  "focus",
  "archive-update",
  "retry-delivery",
]);
const actionLabel = (action: ActivityAction): string =>
  action.replaceAll("-", " ");
const isSupportedAction = (value: string): value is ActivityAction =>
  supportedActions.has(value as ActivityAction);

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
  const typed = activityDetail(item);
  if (
    typed.kind === "signal-update" ||
    typed.kind === "signal-decision" ||
    typed.kind === "signal-history"
  )
    return [
      "ACTIVITY DETAIL",
      `Source: SIGNALS`,
      `ID: ${typed.id}`,
      `Title: ${typed.title}`,
      `State: ${typed.state}`,
      `Summary: ${typed.summary}`,
      `Changed: ${typed.changedAt ?? "none"}`,
      `Created: ${typed.createdAt ?? "none"}`,
      `Updated: ${typed.updatedAt ?? "none"}`,
      `Terminal: ${typed.terminalAt ?? "none"}`,
      `Detail: ${typed.detail ?? "none"}`,
      `Stage: ${typed.stage ?? "none"}`,
      `Outcome: ${typed.outcome ?? "none"}`,
      `Answer: ${typed.answer ?? "none"}`,
      `Revision: ${typed.revision ?? "none"}`,
      `Delivery: ${typed.deliveryState ?? "none"}`,
      `Retryable: ${typed.retryableDelivery ? "yes" : "no"}`,
      `Archivable: ${typed.archivable ? "yes" : "no"}`,
    ];
  if (typed.kind === "system-error" || typed.kind === "system-recovery")
    return [
      "ACTIVITY DETAIL",
      `Source: SYSTEM`,
      `ID: ${typed.id}`,
      `Title: ${typed.title}`,
      `State: ${typed.state}`,
      `Summary: ${typed.summary}`,
      `Notification: ${typed.notificationKind}`,
      `Sequence: ${typed.sequence}`,
    ];
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
  const actionButtons = selected
    ? selected.actions.actions.filter(isSupportedAction).map((typed) => ({
        id: `activity:action:${selected.uiId}:${typed}`,
        label: actionLabel(typed),
        disabled: input.actions
          ? !input.actions.isAllowed(selected, typed)
          : false,
        activate: () => input.actions?.activate(selected, typed),
      }))
    : [];
  // Keep actions above the detail body. This leaves them reachable when the
  // terminal is short instead of placing them after an unbounded detail.
  if (actionButtons.length > 0) detail.addButtons(actionButtons);
  detail.addLine("");
  const detailLinesBudget = Math.max(
    1,
    (input.height ?? 24) - 2 - (actionButtons.length > 0 ? 1 : 0),
  );
  const detailContent = detailLines(selected, input, width);
  for (const line of detailContent.slice(
    input.screen.detailScroll,
    input.screen.detailScroll + detailLinesBudget,
  ))
    detail.addLine(line);
  const left = list.finish();
  const right = detail.finish();
  const leftWidth = Math.max(1, Math.floor(width * 0.42));
  const wide = width >= 90;
  const surface = wide
    ? composeColumns(left, right, leftWidth, Math.max(1, width - leftWidth - 1))
    : {
        lines: [...left.lines, "", ...right.lines],
        hitBoxes: [
          ...left.hitBoxes,
          ...right.hitBoxes.map((box) => ({
            ...box,
            y: box.y + left.lines.length + 1,
          })),
        ],
        regions: [],
      };
  surface.regions.push(
    {
      id: "activity:list",
      x: 0,
      y: 0,
      width: wide ? leftWidth : width,
      height: left.lines.length,
    },
    {
      id: "activity:detail",
      x: wide ? leftWidth + 1 : 0,
      y: wide ? 0 : left.lines.length + 1,
      width: wide ? Math.max(1, width - leftWidth - 1) : width,
      height: right.lines.length,
    },
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
