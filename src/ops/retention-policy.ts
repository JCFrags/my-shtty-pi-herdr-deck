export type RetentionKind = "artifact" | "log";
export type ResourceStatus = "clean" | "dirty" | "live" | "unknown";

export interface RetentionResource {
  id: string;
  path: string;
  kind: RetentionKind | string;
  bytes: number;
  modifiedAt: number;
  status: ResourceStatus;
  deletionEligible?: boolean;
  sha256?: string;
}

export interface RetentionPolicy {
  now: number;
  maxAgeMs: Readonly<Record<RetentionKind, number>>;
  maxBytes: Readonly<Record<RetentionKind, number>>;
  maxItems: number;
}

export interface RetentionCandidate {
  id: string;
  path: string;
  kind: RetentionKind;
  bytes: number;
  reason: "expired" | "over-budget" | "over-item-limit";
}

export interface RetentionRefusal {
  id: string;
  path: string;
  reason:
    | "dirty-resource"
    | "live-resource"
    | "unknown-resource"
    | "unknown-kind"
    | "not-deletion-eligible"
    | "invalid-resource";
}

export interface RetentionPlan {
  dryRun: true;
  candidates: RetentionCandidate[];
  retained: string[];
  refusals: RetentionRefusal[];
}

export interface ExportEntry {
  id: string;
  path: string;
  kind: RetentionKind;
  bytes: number;
  sha256: string;
}

export interface ExportPlan {
  dryRun: true;
  entries: ExportEntry[];
  manifest: string[];
  refusals: RetentionRefusal[];
}

export interface DeletionPlan {
  dryRun: true;
  paths: string[];
  refusals: RetentionRefusal[];
}

const DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_INTEGER = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

function refusal(
  resource: RetentionResource,
  reason: RetentionRefusal["reason"],
): RetentionRefusal {
  return { id: resource.id, path: resource.path, reason };
}

function validateResource(
  resource: RetentionResource,
): RetentionRefusal | undefined {
  if (
    resource.id.length === 0 ||
    resource.path.length === 0 ||
    !SAFE_INTEGER(resource.bytes) ||
    !Number.isFinite(resource.modifiedAt)
  )
    return refusal(resource, "invalid-resource");
  if (resource.status === "dirty") return refusal(resource, "dirty-resource");
  if (resource.status === "live") return refusal(resource, "live-resource");
  if (resource.status === "unknown")
    return refusal(resource, "unknown-resource");
  if (resource.kind !== "artifact" && resource.kind !== "log")
    return refusal(resource, "unknown-kind");
  if (resource.deletionEligible === false)
    return refusal(resource, "not-deletion-eligible");
  return undefined;
}

function validatePolicy(policy: RetentionPolicy): void {
  if (
    !Number.isFinite(policy.now) ||
    !SAFE_INTEGER(policy.maxItems) ||
    !SAFE_INTEGER(policy.maxAgeMs.artifact) ||
    !SAFE_INTEGER(policy.maxAgeMs.log) ||
    !SAFE_INTEGER(policy.maxBytes.artifact) ||
    !SAFE_INTEGER(policy.maxBytes.log)
  )
    throw new Error("Retention limits must be non-negative safe integers.");
}

export function planRetention(
  resources: readonly RetentionResource[],
  policy: RetentionPolicy,
): RetentionPlan {
  validatePolicy(policy);
  const candidates: RetentionCandidate[] = [];
  const retained: string[] = [];
  const refusals: RetentionRefusal[] = [];
  const eligible: RetentionResource[] = [];

  for (const resource of resources) {
    const invalid = validateResource(resource);
    if (invalid) {
      refusals.push(invalid);
      retained.push(resource.path);
    } else eligible.push(resource);
  }

  const selected = new Set<string>();
  for (const resource of eligible) {
    if (
      policy.now - resource.modifiedAt >
      policy.maxAgeMs[resource.kind as RetentionKind]
    ) {
      selected.add(resource.id);
      candidates.push({
        id: resource.id,
        path: resource.path,
        kind: resource.kind as RetentionKind,
        bytes: resource.bytes,
        reason: "expired",
      });
    }
  }

  for (const kind of ["artifact", "log"] as const) {
    const available = eligible
      .filter(
        (resource) => resource.kind === kind && !selected.has(resource.id),
      )
      .sort(
        (left, right) =>
          left.modifiedAt - right.modifiedAt || left.id.localeCompare(right.id),
      );
    let bytes = available.reduce((sum, resource) => sum + resource.bytes, 0);
    for (const resource of available) {
      if (bytes <= policy.maxBytes[kind]) break;
      selected.add(resource.id);
      bytes -= resource.bytes;
      candidates.push({
        id: resource.id,
        path: resource.path,
        kind,
        bytes: resource.bytes,
        reason: "over-budget",
      });
    }
  }

  const byKind = new Map<RetentionKind, RetentionResource[]>();
  for (const resource of eligible) {
    if (!selected.has(resource.id)) {
      const list = byKind.get(resource.kind as RetentionKind) ?? [];
      list.push(resource);
      byKind.set(resource.kind as RetentionKind, list);
    }
  }
  for (const list of byKind.values()) {
    list.sort(
      (left, right) =>
        right.modifiedAt - left.modifiedAt || left.id.localeCompare(right.id),
    );
    for (const resource of list.slice(policy.maxItems)) {
      selected.add(resource.id);
      candidates.push({
        id: resource.id,
        path: resource.path,
        kind: resource.kind as RetentionKind,
        bytes: resource.bytes,
        reason: "over-item-limit",
      });
    }
  }

  for (const resource of eligible)
    if (!selected.has(resource.id)) retained.push(resource.path);
  candidates.sort((left, right) => left.path.localeCompare(right.path));
  refusals.sort(
    (left, right) =>
      left.reason.localeCompare(right.reason) ||
      left.path.localeCompare(right.path),
  );
  return { dryRun: true, candidates, retained, refusals };
}

export function planExport(
  resources: readonly RetentionResource[],
): ExportPlan {
  const entries: ExportEntry[] = [];
  const refusals: RetentionRefusal[] = [];
  for (const resource of resources) {
    const invalid = validateResource(resource);
    if (invalid) {
      refusals.push(invalid);
      continue;
    }
    if (!resource.sha256 || !DIGEST.test(resource.sha256)) {
      refusals.push(refusal(resource, "invalid-resource"));
      continue;
    }
    entries.push({
      id: resource.id,
      path: resource.path,
      kind: resource.kind as RetentionKind,
      bytes: resource.bytes,
      sha256: resource.sha256,
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  refusals.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = entries.map(
    (entry) => `${entry.path}\t${entry.bytes}\tsha256:${entry.sha256}`,
  );
  return { dryRun: true, entries, manifest, refusals };
}

export function planDeletion(plan: RetentionPlan): DeletionPlan {
  if (plan.dryRun !== true)
    throw new Error("Deletion requires a dry-run plan.");
  return {
    dryRun: true,
    paths: plan.candidates.map((candidate) => candidate.path),
    refusals: [...plan.refusals],
  };
}
