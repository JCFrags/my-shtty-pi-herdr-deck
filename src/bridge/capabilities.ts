import type {
  ToolExpansionState,
  ToolGroupScope,
  ToolStatus,
} from "./protocol.js";

export const PI_COMPATIBILITY_MESSAGE =
  "Pi Deck requires Pi with component mouse events, per-tool expansion state and bulk selectors, and expansion-change subscription. The installed Pi API is incompatible.";

export interface ToolExpansionAdapter {
  getStates(): ToolExpansionState[];
  setToolExpanded(toolCallId: string, expanded: boolean): void | Promise<void>;
  setGroupExpanded(
    scope: ToolGroupScope,
    expanded: boolean,
  ): void | Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface CapabilityResult {
  compatible: boolean;
  missing: string[];
  expansion?: ToolExpansionAdapter;
}

type UnknownRecord = Record<string, unknown>;

type Callable = (...args: never[]) => unknown;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callable(
  record: UnknownRecord,
  names: readonly string[],
): Callable | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "function") return value as Callable;
  }
  return undefined;
}

function callBound(
  fn: Callable,
  receiver: UnknownRecord,
  ...args: unknown[]
): unknown {
  return Reflect.apply(fn, receiver, args);
}

function normalizeStatus(value: unknown): ToolStatus {
  switch (value) {
    case "pending":
    case "running":
    case "complete":
    case "error":
      return value;
    case "completed":
    case "done":
    case "success":
      return "complete";
    case "executing":
    case "working":
      return "running";
    case "failed":
      return "error";
    default:
      return "unknown";
  }
}

function normalizeStateEntry(
  value: unknown,
  fallbackId?: string,
): ToolExpansionState | undefined {
  if (typeof value === "boolean" && fallbackId) {
    return {
      id: fallbackId,
      name: fallbackId,
      expanded: value,
      status: "unknown",
      turnIndex: 0,
    };
  }
  if (!isRecord(value)) return undefined;
  const idValue = value.id ?? value.toolCallId ?? value.callId ?? fallbackId;
  const nameValue = value.name ?? value.toolName ?? value.tool ?? idValue;
  if (
    typeof idValue !== "string" ||
    idValue.length === 0 ||
    typeof nameValue !== "string" ||
    nameValue.length === 0
  )
    return undefined;
  const expandedValue = value.expanded ?? value.isExpanded;
  if (typeof expandedValue !== "boolean") return undefined;
  const turnIndexValue = value.turnIndex ?? value.turn ?? 0;
  return {
    id: idValue,
    name: nameValue,
    expanded: expandedValue,
    status: normalizeStatus(value.status),
    turnIndex:
      Number.isSafeInteger(turnIndexValue) && (turnIndexValue as number) >= 0
        ? (turnIndexValue as number)
        : 0,
  };
}

function normalizeExpansionSnapshot(value: unknown): ToolExpansionState[] {
  const source =
    isRecord(value) && Array.isArray(value.tools) ? value.tools : value;
  if (Array.isArray(source)) {
    return source.flatMap((entry) => {
      const normalized = normalizeStateEntry(entry);
      return normalized ? [normalized] : [];
    });
  }
  if (isRecord(source)) {
    return Object.entries(source).flatMap(([id, entry]) => {
      const normalized = normalizeStateEntry(entry, id);
      return normalized ? [normalized] : [];
    });
  }
  return [];
}

function detectExpansionAdapter(
  uiValue: unknown,
): ToolExpansionAdapter | undefined {
  if (!isRecord(uiValue)) return undefined;
  const nested = isRecord(uiValue.toolExpansion)
    ? uiValue.toolExpansion
    : undefined;
  const receiver = nested ?? uiValue;
  const getStates = callable(receiver, [
    "getStates",
    "getSnapshot",
    "getToolExpansionStates",
    "getToolExpansionSnapshot",
  ]);
  const setTool = callable(receiver, ["setToolExpanded"]);
  const setGroup = callable(receiver, [
    "setGroupExpanded",
    "setToolGroupExpanded",
  ]);
  const subscribe = callable(receiver, [
    "subscribe",
    "onChange",
    "onToolExpansionChange",
    "subscribeToolExpansionChanges",
  ]);
  if (!getStates || !setTool || !setGroup || !subscribe) return undefined;
  return {
    getStates: () => normalizeExpansionSnapshot(callBound(getStates, receiver)),
    setToolExpanded: (toolCallId, expanded) =>
      callBound(
        setTool,
        receiver,
        toolCallId,
        expanded,
      ) as void | Promise<void>,
    setGroupExpanded: (scope, expanded) =>
      callBound(setGroup, receiver, scope, expanded) as void | Promise<void>,
    subscribe: (listener) => {
      const unsubscribe = callBound(subscribe, receiver, listener);
      return typeof unsubscribe === "function"
        ? (unsubscribe as () => void)
        : () => undefined;
    },
  };
}

export function hasComponentMouseApi(tuiModule: unknown): boolean {
  if (!isRecord(tuiModule)) return false;
  if (
    typeof tuiModule.parseMouseInput !== "function" ||
    typeof tuiModule.TUI !== "function" ||
    typeof tuiModule.ProcessTerminal !== "function"
  )
    return false;
  const tuiPrototype = (tuiModule.TUI as { prototype?: UnknownRecord })
    .prototype;
  return (
    isRecord(tuiPrototype) &&
    typeof tuiPrototype.setMouseTracking === "function"
  );
}

export function detectPiCapabilities(
  context: unknown,
  tuiModule: unknown,
): CapabilityResult {
  const missing: string[] = [];
  if (!hasComponentMouseApi(tuiModule)) missing.push("component mouse events");
  const ui = isRecord(context) ? context.ui : undefined;
  const expansion = detectExpansionAdapter(ui);
  if (!expansion) {
    missing.push("per-tool expansion state and bulk selectors");
    missing.push("expansion-change subscription");
  }
  if (missing.length > 0) return { compatible: false, missing };
  return { compatible: true, missing, expansion: expansion! };
}

export function requirePiCapabilities(
  context: unknown,
  tuiModule: unknown,
): ToolExpansionAdapter {
  const result = detectPiCapabilities(context, tuiModule);
  if (!result.compatible || !result.expansion)
    throw new Error(PI_COMPATIBILITY_MESSAGE);
  return result.expansion;
}
