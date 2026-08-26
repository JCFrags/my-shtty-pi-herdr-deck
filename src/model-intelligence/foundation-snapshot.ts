import { MAX_FOUNDATION_RECORDS_PER_REFRESH } from "../broker/endpoint-policy.js";
import { sha256 } from "../shared/canonical-json.js";
import {
  applyModelEvidenceRecord,
  canonicalEvidenceJson,
  emptyModelEvidenceState,
  MODEL_EVIDENCE_POLICY,
  validateModelEvidenceRecord,
  type ModelEvidenceRecord,
  type ModelEvidenceState,
} from "./model-evidence.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const SOURCE_NAME_MAX_BYTES = 128;
export const MAX_FOUNDATION_SNAPSHOT_ITEMS = MAX_FOUNDATION_RECORDS_PER_REFRESH;

export interface FoundationSnapshotItem {
  readonly supersedes: readonly string[];
  readonly record: ModelEvidenceRecord;
}

export interface FoundationEvidenceSnapshot {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly sourceName: string;
  readonly observedAt: string;
  readonly items: readonly FoundationSnapshotItem[];
}

type FoundationSnapshotInput = Omit<FoundationEvidenceSnapshot, "snapshotId">;

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object.`);
  return value as Record<string, unknown>;
}

function canonicalTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} is invalid.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error(`${path} is invalid.`);
  return value;
}

function boundedSourceName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > SOURCE_NAME_MAX_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error("Foundation snapshot source name is invalid.");
  return value;
}

function snapshotDigest(input: FoundationSnapshotInput): string {
  return sha256(
    `pi-herdr-model-foundation-snapshot-v1\n${canonicalEvidenceJson(input)}`,
  );
}

function evidenceIdentity(record: ModelEvidenceRecord): string {
  if (
    record.sourceKind !== "foundation" ||
    record.evidenceKind !== "score" ||
    record.dimension !== "task_capability" ||
    record.subject.kind !== "canonical"
  )
    throw new Error("Foundation snapshot evidence authority is invalid.");
  return `${record.sourceName}\u0000${record.taskProfile}\u0000${record.subject.canonicalModelId}`;
}

export function normalizeFoundationEvidenceSnapshot(
  value: FoundationSnapshotInput,
): FoundationEvidenceSnapshot {
  const normalized = validateFoundationSnapshotInput(value);
  return { ...normalized, snapshotId: snapshotDigest(normalized) };
}

function validateFoundationSnapshotInput(
  value: unknown,
): FoundationSnapshotInput {
  const input = object(value, "Foundation snapshot");
  if (!exactKeys(input, ["schemaVersion", "sourceName", "observedAt", "items"]))
    throw new Error("Foundation snapshot shape is invalid.");
  if (input.schemaVersion !== 1)
    throw new Error("Foundation snapshot version is invalid.");
  const sourceName = boundedSourceName(input.sourceName);
  const observedAt = canonicalTimestamp(input.observedAt, "observedAt");
  if (
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > MAX_FOUNDATION_SNAPSHOT_ITEMS
  )
    throw new Error("Foundation snapshot item count is invalid.");
  const recordIds = new Set<string>();
  const supersededIds = new Set<string>();
  const identities = new Set<string>();
  const items: FoundationSnapshotItem[] = input.items.map((rawItem, index) => {
    const item = object(rawItem, `Foundation snapshot item ${index}`);
    if (
      !exactKeys(item, ["supersedes", "record"]) ||
      !Array.isArray(item.supersedes)
    )
      throw new Error("Foundation snapshot item shape is invalid.");
    const supersedes = item.supersedes.map((evidenceId) => {
      if (typeof evidenceId !== "string" || !DIGEST.test(evidenceId))
        throw new Error("Foundation snapshot supersession ID is invalid.");
      if (supersededIds.has(evidenceId))
        throw new Error("Foundation snapshot supersession is duplicated.");
      supersededIds.add(evidenceId);
      return evidenceId;
    });
    const sorted = [...supersedes].sort();
    if (
      sorted.some(
        (evidenceId, itemIndex) => evidenceId !== supersedes[itemIndex],
      )
    )
      throw new Error("Foundation snapshot supersession IDs are not sorted.");
    const record = validateModelEvidenceRecord(item.record);
    if (record.sourceName !== sourceName || record.observedAt !== observedAt)
      throw new Error("Foundation snapshot record metadata is inconsistent.");
    const identity = evidenceIdentity(record);
    if (recordIds.has(record.evidenceId) || identities.has(identity))
      throw new Error("Foundation snapshot record is duplicated.");
    recordIds.add(record.evidenceId);
    identities.add(identity);
    return { supersedes, record };
  });
  return { schemaVersion: 1, sourceName, observedAt, items };
}

export function validateFoundationEvidenceSnapshot(
  value: unknown,
): FoundationEvidenceSnapshot {
  const input = object(value, "Foundation snapshot");
  if (
    !exactKeys(input, [
      "schemaVersion",
      "snapshotId",
      "sourceName",
      "observedAt",
      "items",
    ])
  )
    throw new Error("Foundation snapshot shape is invalid.");
  if (typeof input.snapshotId !== "string" || !DIGEST.test(input.snapshotId))
    throw new Error("Foundation snapshot ID is invalid.");
  const normalized = validateFoundationSnapshotInput({
    schemaVersion: input.schemaVersion,
    sourceName: input.sourceName,
    observedAt: input.observedAt,
    items: input.items,
  });
  const expected = snapshotDigest(normalized);
  if (expected !== input.snapshotId)
    throw new Error(
      "Foundation snapshot ID does not match its canonical content.",
    );
  return { ...normalized, snapshotId: expected };
}

export function applyFoundationEvidenceSnapshot(
  stateValue: ModelEvidenceState | undefined,
  snapshotValue: FoundationEvidenceSnapshot,
  eventSeq: number,
): ModelEvidenceState {
  const state = stateValue ?? emptyModelEvidenceState();
  const snapshot = validateFoundationEvidenceSnapshot(snapshotValue);
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 1)
    throw new Error("Foundation snapshot event sequence is invalid.");
  const supersededBy = { ...state.supersededBy };
  for (const item of snapshot.items)
    for (const evidenceId of item.supersedes) {
      const target = state.records[evidenceId];
      if (
        !target ||
        Object.hasOwn(state.supersededBy, evidenceId) ||
        evidenceIdentity(target.record) !== evidenceIdentity(item.record) ||
        target.record.sourceName !== snapshot.sourceName
      )
        throw new Error("Foundation snapshot supersession target is invalid.");
      supersededBy[evidenceId] = item.record.evidenceId;
    }
  const newRecordCount = snapshot.items.filter(
    (item) => !state.records[item.record.evidenceId],
  ).length;
  if (
    Object.keys(state.records).length + newRecordCount >
    MODEL_EVIDENCE_POLICY.maxActiveRecords
  )
    throw new Error("Foundation snapshot exceeds the evidence record limit.");
  let next: ModelEvidenceState = { ...state, supersededBy };
  for (const item of snapshot.items) {
    if (state.records[item.record.evidenceId])
      throw new Error("Foundation snapshot evidence already exists.");
    next = applyModelEvidenceRecord(next, item.record, eventSeq);
  }
  return next;
}
