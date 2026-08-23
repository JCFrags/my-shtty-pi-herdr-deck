import type { FilesProjection } from "../shared/provider-projections.js";

export interface FilesRowPresentation {
  path: string;
  name: string;
  kind: "root" | "directory" | "file" | "symlink" | "other";
  depth: number;
  selected: boolean;
  partiallySelected: boolean;
  expanded: boolean;
  error?: string;
}
export interface FilesPreviewPresentation {
  path: string;
  lines: string[];
  metadata: Record<string, unknown>;
  error?: string;
}
export interface FilesPresentation {
  available: boolean;
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

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, limit = 4096): string =>
  typeof value === "string"
    ? value
        .slice(0, limit)
        .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�")
        .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "�")
    : "";
const integer = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;

export function filesLayout(width: number): FilesLayout {
  if (width < 78)
    return {
      narrow: true,
      treeWidth: Math.max(1, width),
      previewWidth: Math.max(1, width),
      separatorWidth: 0,
    };
  const interior = Math.max(2, width - 1);
  const treeWidth = Math.max(1, Math.floor(interior * 0.38));
  return {
    narrow: false,
    treeWidth,
    previewWidth: interior - treeWidth,
    separatorWidth: 1,
  };
}

export function normalizeFilesPresentation(
  files: FilesProjection | undefined,
): FilesPresentation {
  const summary = record(files?.summary);
  const view = record(files?.view);
  const rawRows = Array.isArray(view.rows) ? view.rows.slice(0, 256) : [];
  const rows = rawRows.flatMap((value): FilesRowPresentation[] => {
    const row = record(value);
    const path = text(row.path, 4096);
    const kind = row.kind;
    if (
      !path ||
      !["root", "directory", "file", "symlink", "other"].includes(String(kind))
    )
      return [];
    const depth = integer(row.depth) ?? 0;
    return [
      {
        path,
        name: text(row.name, 1024) || path,
        kind: kind as FilesRowPresentation["kind"],
        depth: Math.min(depth, 128),
        selected: row.selected === true,
        partiallySelected: row.partiallySelected === true,
        expanded: row.expanded === true,
        ...(text(row.error, 512) ? { error: text(row.error, 512) } : {}),
      },
    ];
  });
  const preview = record(view.preview);
  const previewPath = text(
    view.previewPath ?? record(preview.metadata).relativePath,
    4096,
  );
  const previewLines = Array.isArray(preview.lines)
    ? preview.lines.slice(0, 5000).map((line) => text(line, 4096))
    : [];
  const selectedKnownBytes = integer(summary.selectedKnownBytes);
  const selectedApproximateTokens = integer(summary.selectedApproximateTokens);
  return {
    available: files?.available === true,
    ...(text(files?.error, 512) ? { error: text(files?.error, 512) } : {}),
    cwd: text(summary.cwd ?? view.cwd, 4096),
    currentPath: text(view.currentPath ?? summary.currentPath, 4096),
    filter: text(view.filter, 256),
    showHidden: summary.showHidden === true || view.showHidden === true,
    selectedCount: integer(summary.selectedCount) ?? 0,
    ...(selectedKnownBytes === undefined ? {} : { selectedKnownBytes }),
    ...(selectedApproximateTokens === undefined
      ? {}
      : { selectedApproximateTokens }),
    rows,
    ...(previewPath || previewLines.length > 0 || text(preview.error, 512)
      ? {
          preview: {
            path: previewPath,
            lines: previewLines,
            metadata: record(preview.metadata),
            ...(text(preview.error, 512)
              ? { error: text(preview.error, 512) }
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
