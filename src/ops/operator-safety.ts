export type SafeJsonValue =
  | null
  | boolean
  | number
  | string
  | SafeJsonValue[]
  | { [key: string]: SafeJsonValue };

const SENSITIVE_KEY =
  /(?:token|secret|password|credential|authorization|cookie|session|prompt|environment|^env$|api[_-]?key|private[_-]?key)/iu;
const MAX_STRING_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeValue(value: unknown, key?: string): SafeJsonValue | undefined {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  if (Array.isArray(value)) {
    return value
      .map((item) => safeValue(item))
      .filter((item): item is SafeJsonValue => item !== undefined);
  }
  if (!isRecord(value)) return undefined;
  const result: { [key: string]: SafeJsonValue } = {};
  for (const name of Object.keys(value).sort()) {
    const child = safeValue(value[name], name);
    if (child !== undefined) result[name] = child;
  }
  return result;
}

/** Return deterministic, privacy-filtered operator metadata. */
export function projectSafeMetadata(metadata: Record<string, unknown>): {
  [key: string]: SafeJsonValue;
} {
  const projected = safeValue(metadata);
  return isRecord(projected) ? projected : {};
}

/** Serialize JSON with recursively sorted object keys and no terminal formatting. */
export function stableJson(value: SafeJsonValue): string {
  return JSON.stringify(safeValue(value) ?? null);
}

export type GcResourceKind =
  "artifact" | "log" | "snapshot" | "worktree" | "runtime";
export type GcResourceState = "clean" | "dirty" | "unknown" | "live";

export interface GcResource {
  id: string;
  kind: GcResourceKind;
  ageMs: number;
  retentionMs: number;
  state: GcResourceState;
  verified?: boolean;
  superseded?: boolean;
}

export interface GcCandidate {
  id: string;
  kind: GcResourceKind;
  reason: "expired" | "superseded" | "stale";
}

export interface GcPlan {
  dryRun: true;
  candidates: GcCandidate[];
  retained: Array<{ id: string; reason: string }>;
}

function retain(resource: GcResource, reason: string) {
  return { id: resource.id, reason };
}

/** Build a read-only GC plan. This function never removes or changes a resource. */
export function planGarbageCollection(
  resources: readonly GcResource[],
): GcPlan {
  const candidates: GcCandidate[] = [];
  const retained: Array<{ id: string; reason: string }> = [];
  for (const resource of [...resources].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (resource.state === "dirty") {
      retained.push(retain(resource, "dirty resource"));
      continue;
    }
    if (resource.state === "unknown") {
      retained.push(retain(resource, "unknown resource"));
      continue;
    }
    if (resource.state === "live") {
      retained.push(retain(resource, "live resource"));
      continue;
    }
    if (
      !Number.isFinite(resource.ageMs) ||
      !Number.isFinite(resource.retentionMs)
    ) {
      retained.push(retain(resource, "invalid retention data"));
      continue;
    }
    if (resource.kind === "snapshot") {
      if (resource.superseded && resource.verified)
        candidates.push({
          id: resource.id,
          kind: resource.kind,
          reason: "superseded",
        });
      else
        retained.push(
          retain(resource, "snapshot is not verified and superseded"),
        );
      continue;
    }
    if (resource.ageMs > resource.retentionMs) {
      candidates.push({
        id: resource.id,
        kind: resource.kind,
        reason: resource.kind === "runtime" ? "stale" : "expired",
      });
    } else retained.push(retain(resource, "within retention period"));
  }
  return { dryRun: true, candidates, retained };
}

export type PreservedResourceKind = "state" | "results" | "logs" | "worktrees";

export interface UninstallResource {
  id: string;
  kind: PreservedResourceKind;
}

export interface UninstallPlan {
  dryRun: true;
  preserve: PreservedResourceKind[];
  resources: UninstallResource[];
  destructiveActions: [];
  liveActions: [];
}

/** Build the default uninstall plan. State and worktrees are always preserved. */
export function planUninstall(
  resources: readonly UninstallResource[] = [],
): UninstallPlan {
  const preserve: PreservedResourceKind[] = [
    "state",
    "results",
    "logs",
    "worktrees",
  ];
  const ordered = [...resources]
    .filter((resource) => preserve.includes(resource.kind))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    dryRun: true,
    preserve,
    resources: ordered,
    destructiveActions: [],
    liveActions: [],
  };
}
