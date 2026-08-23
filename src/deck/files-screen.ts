import type { TuiMouseEvent } from "@pi-herdr-deck/tui";
import type { FilesProjection } from "../shared/provider-projections.js";
import { composeColumns, SurfaceBuilder } from "./geometry.js";
import type {
  FilesScreenState,
  RenderedSurface,
  SurfaceRegion,
} from "./screen-types.js";
import { hitTest } from "./components/controls.js";

export type FilesRowKind =
  "root" | "directory" | "file" | "symlink" | "other" | "info";

/** A row keeps the provider path untouched for commands and separate values for UI use. */
export interface FilesRowPresentation {
  /** Exact provider path. Never use this value as terminal text or a DOM/id value. */
  actionPath?: string;
  /** Backward-compatible safe path display. */
  path: string;
  /** Terminal-safe path/name values. */
  displayPath: string;
  name: string;
  /** Stable, terminal-safe geometry identifier derived from actionPath. */
  rowKey: string;
  kind: FilesRowKind;
  depth: number;
  selected: boolean;
  partiallySelected: boolean;
  expanded: boolean;
  error?: string;
  /** Provider informational rows are inert and carry only this message. */
  message?: string;
}

export interface FilesPreviewPresentation {
  /** Exact provider path for preview requests, absent when invalid. */
  actionPath?: string;
  /** Backward-compatible safe display path. */
  path: string;
  displayPath: string;
  lines: string[];
  metadata: Record<string, unknown>;
  error?: string;
}

export interface FilesPresentation {
  available: boolean;
  canOpenStandalone: boolean;
  error?: string;
  cwd: string;
  currentPath: string;
  filter: string;
  showHidden: boolean;
  selectedCount: number;
  selectedKnownBytes?: number;
  selectedApproximateTokens?: number;
  rows: FilesRowPresentation[];
  preview?: FilesPreviewPresentation;
  capability?: unknown;
  limits: Record<string, unknown>;
}

export interface FilesLayout {
  narrow: boolean;
  treeWidth: number;
  previewWidth: number;
  separatorWidth: number;
}

export type FilesAction =
  | "expand"
  | "toggle-selection"
  | "preview"
  | "insert-paths"
  | "insert-contents"
  | "clear-selection"
  | "refresh"
  | "open-standalone"
  | "toggle-hidden"
  | "set-filter";

export interface FilesActionRequest {
  action: FilesAction;
  /** Exact provider path for row actions. Absent for screen actions. */
  actionPath?: string;
  /** Directory state requested by an expand action. */
  expanded?: boolean;
  /** Present for set-filter. The provider remains the source of truth. */
  filter?: string;
}

export interface FilesScreenOptions {
  presentation: FilesPresentation;
  state: FilesScreenState;
  onAction(request: FilesActionRequest): void;
  onStateChange?(state: FilesScreenState): void;
}

export interface FilesScreenSurface extends RenderedSurface<FilesScreenState> {
  layout: FilesLayout;
  presentation: FilesPresentation;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Replace terminal controls and bidi overrides, without changing the provider path. */
export function safeFilesDisplay(value: string, limit = 4096): string {
  return value
    .slice(0, limit)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "�");
}

function text(value: unknown, limit = 4096): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function rawText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Accept only relative provider identities. Display sanitization is separate. */
export function isValidFilesActionPath(actionPath: string): boolean {
  if (!actionPath || actionPath.includes("\u0000")) return false;
  if (actionPath.startsWith("/") || actionPath.startsWith("\\")) return false;
  if (/^[A-Za-z]:/u.test(actionPath)) return false;
  return actionPath
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "..");
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function rowKey(actionPath: string): string {
  // Delimit each code point and include its count: ["ab", "c"] cannot collide with ["a", "bc"].
  const encoded = Array.from(actionPath)
    .map((character) => character.codePointAt(0)?.toString(16) ?? "0")
    .join("-");
  return `files-row-${Array.from(actionPath).length}:${encoded || "root"}`;
}

export function filesLayout(width: number): FilesLayout {
  const safeWidth = Math.max(1, Math.floor(width));
  if (safeWidth < 78)
    return {
      narrow: true,
      treeWidth: safeWidth,
      previewWidth: safeWidth,
      separatorWidth: 0,
    };
  // The separator is one terminal cell. The panes use the remaining cells.
  const paneWidth = safeWidth - 1;
  const treeWidth = Math.max(1, Math.round(paneWidth * 0.38));
  return {
    narrow: false,
    treeWidth,
    previewWidth: paneWidth - treeWidth,
    separatorWidth: 1,
  };
}

export function normalizeFilesPresentation(
  files: FilesProjection | undefined,
  canOpenStandalone = false,
): FilesPresentation {
  const summary = record(files?.summary);
  const view = record(files?.view);
  const rawRows = Array.isArray(view.rows) ? view.rows.slice(0, 256) : [];
  const rows = rawRows.flatMap((value, index): FilesRowPresentation[] => {
    const source = record(value);
    const rowType = text(source.rowType, 32).toLowerCase();
    const message = rawText(source.message);
    if (rowType === "info" || rowType === "information") {
      if (!message) return [];
      return [
        {
          path: "",
          displayPath: "",
          name: safeFilesDisplay(message, 4096),
          rowKey: `files-info-${index}`,
          kind: "info",
          depth: 0,
          selected: false,
          partiallySelected: false,
          expanded: false,
          message: safeFilesDisplay(message, 4096),
        },
      ];
    }
    const actionPath = rawText(source.actionPath ?? source.path);
    const kind = source.kind;
    if (
      !isValidFilesActionPath(actionPath) ||
      !["root", "directory", "file", "symlink", "other"].includes(String(kind))
    )
      return [];
    const name = text(source.name, 1024) || actionPath;
    return [
      {
        actionPath,
        path: safeFilesDisplay(actionPath),
        displayPath: safeFilesDisplay(actionPath),
        name: safeFilesDisplay(name, 1024),
        rowKey: rowKey(actionPath),
        kind: kind as FilesRowKind,
        depth: Math.min(integer(source.depth) ?? 0, 128),
        selected: source.selected === true,
        partiallySelected: source.partiallySelected === true,
        expanded: source.expanded === true,
        ...(text(source.error, 512)
          ? { error: safeFilesDisplay(text(source.error, 512)) }
          : {}),
      },
    ];
  });
  const preview = record(view.preview);
  const previewRawActionPath = rawText(
    view.previewActionPath ??
      view.previewPath ??
      preview.actionPath ??
      record(preview.metadata).relativePath,
  );
  const previewActionPath = isValidFilesActionPath(previewRawActionPath)
    ? previewRawActionPath
    : "";
  const previewLines = Array.isArray(preview.lines)
    ? preview.lines
        .slice(0, 5000)
        .map((line) => safeFilesDisplay(text(line, 4096)))
    : [];
  const knownBytes = integer(summary.selectedKnownBytes);
  const tokens = integer(summary.selectedApproximateTokens);
  return {
    available: files?.available === true,
    canOpenStandalone,
    ...(text(files?.error, 512)
      ? { error: safeFilesDisplay(text(files?.error, 512)) }
      : {}),
    cwd: safeFilesDisplay(text(summary.cwd ?? view.cwd, 4096)),
    currentPath: safeFilesDisplay(
      text(view.currentPath ?? summary.currentPath, 4096),
    ),
    // These are provider-owned values. Do not filter rows or toggle hidden locally.
    filter: safeFilesDisplay(text(view.filter, 256)),
    showHidden: view.showHidden === true,
    selectedCount: integer(summary.selectedCount) ?? 0,
    ...(knownBytes === undefined ? {} : { selectedKnownBytes: knownBytes }),
    ...(tokens === undefined ? {} : { selectedApproximateTokens: tokens }),
    rows,
    ...(previewActionPath || previewLines.length > 0 || text(preview.error, 512)
      ? {
          preview: {
            actionPath: previewActionPath,
            path: safeFilesDisplay(previewActionPath),
            displayPath: safeFilesDisplay(previewActionPath),
            lines: previewLines,
            metadata: record(preview.metadata),
            ...(text(preview.error, 512)
              ? { error: safeFilesDisplay(text(preview.error, 512)) }
              : {}),
          },
        }
      : {}),
    ...(files?.capability === undefined
      ? {}
      : { capability: files.capability }),
    limits: record(summary.limits),
  };
}

function displayMetadata(metadata: Record<string, unknown>): string[] {
  return Object.entries(metadata).flatMap(([key, value]) => {
    const safeKey = safeFilesDisplay(key, 80);
    const safeValue = safeFilesDisplay(
      typeof value === "string" ? value : JSON.stringify(value),
      240,
    );
    return safeKey && safeValue ? [`${safeKey}: ${safeValue}`] : [];
  });
}

function appendSurface(
  root: SurfaceBuilder,
  surface: RenderedSurface,
  yOffset: number,
): void {
  for (const line of surface.lines) root.addLine(line);
  for (const box of surface.hitBoxes)
    root.addHitBox({ ...box, y: box.y + yOffset });
  for (const region of surface.regions)
    root.addRegion({ ...region, y: region.y + yOffset });
}

function withState(
  options: FilesScreenOptions,
  patch: Partial<FilesScreenState>,
): FilesScreenState {
  const next = { ...options.state, ...patch };
  options.onStateChange?.(next);
  return next;
}

function isFolder(row: FilesRowPresentation): boolean {
  return row.kind === "root" || row.kind === "directory";
}

export function renderFilesScreen(
  options: FilesScreenOptions,
  width: number,
  height = 24,
): FilesScreenSurface {
  const { presentation } = options;
  const layout = filesLayout(width);
  const root = new SurfaceBuilder(width);
  root.addLine(`FILES  ${presentation.available ? "● READY" : "○ CONNECTING"}`);
  root.addLine(
    `${presentation.cwd || "Provider working directory unavailable"}  ${presentation.selectedCount} selected  filter: ${presentation.filter || "none"}  hidden: ${presentation.showHidden ? "on" : "off"}`,
  );
  const contentY = root.lines.length;
  const tree = new SurfaceBuilder(layout.treeWidth);
  const preview = new SurfaceBuilder(layout.previewWidth);
  const visibleRows = presentation.rows; // Provider already applied filter and hidden policy.
  const rowBudget = Math.max(1, height - contentY - 4);
  const selectedIndex = visibleRows.findIndex(
    (row) => row.actionPath === options.state.focusedPath,
  );
  let treeScroll = Math.max(0, options.state.treeScroll);
  if (!options.state.wheelDetached && selectedIndex >= 0)
    treeScroll = Math.max(
      0,
      Math.min(selectedIndex, treeScroll + rowBudget - 1),
    );
  treeScroll = Math.min(
    treeScroll,
    Math.max(0, visibleRows.length - rowBudget),
  );
  for (const row of visibleRows.slice(treeScroll, treeScroll + rowBudget)) {
    if (row.kind === "info") {
      tree.addLine(`  ${row.message ?? row.name}`);
      continue;
    }
    const actionPath = row.actionPath;
    if (actionPath === undefined) continue;
    const y = tree.lines.length;
    const indent = "  ".repeat(row.depth);
    const marker = row.selected ? "x" : row.partiallySelected ? "-" : " ";
    const caret = isFolder(row) ? (row.expanded ? "▾" : "▸") : "·";
    const selected = options.state.focusedPath === actionPath;
    const rowX = Math.min(layout.treeWidth - 1, 7 + indent.length);
    tree.addRow(
      `${row.rowKey}:row`,
      `${selected ? ">" : " "} ${indent}${caret} [${marker}] ${row.name}${row.error ? ` ! ${row.error}` : ""}`,
      () => {
        withState(options, {
          focusedPath: actionPath,
          focusTarget: "tree",
          wheelDetached: false,
        });
        if (!isFolder(row)) options.onAction({ action: "preview", actionPath });
      },
      { x: rowX, width: layout.treeWidth - rowX },
    );
    if (isFolder(row))
      tree.addHitBox({
        id: `${row.rowKey}:expand`,
        x: Math.min(layout.treeWidth - 1, 2 + indent.length),
        y,
        width: 1,
        height: 1,
        disabled: false,
        activate: () =>
          options.onAction({
            action: "expand",
            actionPath,
            expanded: !row.expanded,
          }),
      });
    tree.addHitBox({
      id: `${row.rowKey}:select`,
      x: Math.min(layout.treeWidth - 1, 4 + indent.length),
      y,
      width: 3,
      height: 1,
      disabled: false,
      activate: () =>
        options.onAction({
          action: "toggle-selection",
          actionPath,
        }),
    });
  }
  if (visibleRows.length === 0) tree.addLine("No provider rows.");

  const selectedPreview = presentation.preview;
  preview.addLine(
    selectedPreview
      ? `PREVIEW  ${selectedPreview.displayPath}`
      : "PREVIEW  No file selected",
  );
  if (selectedPreview) {
    for (const line of displayMetadata(selectedPreview.metadata))
      preview.addLine(line);
    preview.addLine("");
    const previewBudget = Math.max(
      1,
      height - contentY - preview.lines.length - 2,
    );
    const start = Math.min(
      options.state.previewScroll,
      Math.max(0, selectedPreview.lines.length - previewBudget),
    );
    for (const [index, line] of selectedPreview.lines
      .slice(start, start + previewBudget)
      .entries())
      preview.addLine(`${String(start + index + 1).padStart(4)} ${line}`);
    if (selectedPreview.error) preview.addLine(`! ${selectedPreview.error}`);
  } else preview.addLine("Select a file to request a preview.");
  const treeRegion: SurfaceRegion = {
    id: "files:tree-region",
    x: 0,
    y: 0,
    width: layout.treeWidth,
    height: Math.max(1, tree.lines.length),
  };
  const previewRegion: SurfaceRegion = {
    id: "files:preview-region",
    x: 0,
    y: 0,
    width: layout.previewWidth,
    height: Math.max(1, preview.lines.length),
  };
  tree.addRegion(treeRegion);
  preview.addRegion(previewRegion);
  if (layout.narrow) {
    const tabY = root.addLine(
      `>${options.state.activePane === "tree" ? "Tree" : "Preview"}<  [Tree] [Preview]`,
    );
    root.addHitBox({
      id: "files:tab-tree",
      x: 0,
      y: tabY,
      width: 8,
      height: 1,
      disabled: false,
      activate: () =>
        withState(options, { activePane: "tree", focusTarget: "tree" }),
    });
    root.addHitBox({
      id: "files:tab-preview",
      x: 9,
      y: tabY,
      width: 11,
      height: 1,
      disabled: false,
      activate: () =>
        withState(options, { activePane: "preview", focusTarget: "preview" }),
    });
    appendSurface(
      root,
      options.state.activePane === "tree" ? tree : preview,
      root.lines.length,
    );
  } else {
    const columns = composeColumns(
      tree.finish(),
      preview.finish(),
      layout.treeWidth,
      layout.previewWidth,
    );
    appendSurface(root, columns, root.lines.length);
  }
  root.addLine("");
  // This is the only command bar. Header, pane titles, metadata, and empty states are inert.
  root.addButtons([
    {
      id: "files:action-insert-paths",
      label: `Insert paths (${presentation.selectedCount})`,
      disabled: presentation.selectedCount === 0,
      activate: () => options.onAction({ action: "insert-paths" }),
    },
    {
      id: "files:action-insert-contents",
      label: `Insert contents (${presentation.selectedCount})`,
      disabled: presentation.selectedCount === 0,
      activate: () => options.onAction({ action: "insert-contents" }),
    },
    {
      id: "files:action-clear",
      label: "Clear selection",
      disabled: presentation.selectedCount === 0,
      activate: () => options.onAction({ action: "clear-selection" }),
    },
    {
      id: "files:action-refresh",
      label: "Refresh",
      activate: () => options.onAction({ action: "refresh" }),
    },
    {
      id: "files:action-open-standalone",
      label: "Open standalone view",
      disabled: !presentation.canOpenStandalone,
      activate: () => options.onAction({ action: "open-standalone" }),
    },
  ]);
  const correctedState =
    treeScroll === options.state.treeScroll
      ? undefined
      : { ...options.state, treeScroll };
  const finished: RenderedSurface<FilesScreenState> =
    correctedState === undefined
      ? root.finish<FilesScreenState>()
      : root.finish({ correctedState });
  return { ...finished, layout, presentation };
}

export function handleFilesKey(
  options: FilesScreenOptions,
  key: string,
): boolean {
  const rows = options.presentation.rows;
  const current = Math.max(
    0,
    rows.findIndex((row) => row.actionPath === options.state.focusedPath),
  );
  const move = (delta: number): void => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, current + delta))];
    if (row?.actionPath !== undefined)
      withState(options, {
        focusedPath: row.actionPath,
        focusTarget: "tree",
        wheelDetached: false,
      });
  };
  if (key === "ArrowDown" || key === "j") {
    move(1);
    return true;
  }
  if (key === "ArrowUp" || key === "k") {
    move(-1);
    return true;
  }
  const row = rows[current];
  if (key === "Enter" && row?.actionPath !== undefined) {
    options.onAction({
      action: isFolder(row) ? "expand" : "preview",
      actionPath: row.actionPath,
      ...(isFolder(row) ? { expanded: !row.expanded } : {}),
    });
    return true;
  }
  if ((key === " " || key === "Space") && row?.actionPath !== undefined) {
    options.onAction({
      action: "toggle-selection",
      actionPath: row.actionPath,
    });
    return true;
  }
  if (key === "h") {
    options.onAction({ action: "toggle-hidden" });
    return true;
  }
  if (key === "i") {
    options.onAction({ action: "insert-paths" });
    return true;
  }
  if (key === "c") {
    options.onAction({ action: "clear-selection" });
    return true;
  }
  if (key === "r") {
    options.onAction({ action: "refresh" });
    return true;
  }
  if (key === "o") {
    options.onAction({ action: "open-standalone" });
    return true;
  }
  return false;
}

const mousePresses = new WeakMap<
  FilesScreenOptions,
  { id: string; x: number; y: number; dragged: boolean }
>();

export function handleFilesMouse(
  options: FilesScreenOptions,
  surface: FilesScreenSurface,
  event: TuiMouseEvent,
): boolean {
  if (event.type === "wheel") {
    const region = surface.regions.find(
      (candidate) =>
        event.x >= candidate.x &&
        event.x < candidate.x + candidate.width &&
        event.y >= candidate.y &&
        event.y < candidate.y + candidate.height,
    );
    if (!region) return false;
    const delta = event.direction === "down" ? 1 : -1;
    const field =
      region.id === "files:preview-region" ? "previewScroll" : "treeScroll";
    withState(options, {
      [field]: Math.max(0, options.state[field] + delta),
      focusTarget: field === "previewScroll" ? "preview" : "tree",
      wheelDetached: true,
    });
    return true;
  }
  if (event.button !== "left") return false;
  if (event.type === "press") {
    const box = hitTest(surface.hitBoxes, event.x, event.y);
    if (!box) return false;
    mousePresses.set(options, {
      id: box.id,
      x: event.x,
      y: event.y,
      dragged: false,
    });
    return true;
  }
  const press = mousePresses.get(options);
  if (event.type === "move") {
    if (!press) return false;
    press.dragged ||= press.x !== event.x || press.y !== event.y;
    return true;
  }
  if (event.type !== "release" || !press) return false;
  mousePresses.delete(options);
  const box = hitTest(surface.hitBoxes, event.x, event.y);
  if (!press.dragged && box?.id === press.id && !box.disabled) box.activate();
  return true;
}
