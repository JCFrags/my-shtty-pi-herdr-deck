import { sha256 } from "../shared/canonical-json.js";

export const MODEL_EVIDENCE_POLICY = Object.freeze({
  version: 1 as const,
  ppm: 1_000_000,
  neutralPpm: 500_000,
  internetBlendCapPpm: 200_000,
  qualityFullConfidenceSamples: 5,
  lifecycleFullConfidenceSamples: 20,
  maxFutureSkewMs: 5 * 60_000,
  maxActiveRecords: 4_096,
  maxCompactionRecords: 512,
  maxAggregates: 4_096,
  recencyBuckets: Object.freeze([
    Object.freeze({ maxAgeMs: 7 * 86_400_000, weightPpm: 1_000_000 }),
    Object.freeze({ maxAgeMs: 30 * 86_400_000, weightPpm: 850_000 }),
    Object.freeze({ maxAgeMs: 90 * 86_400_000, weightPpm: 650_000 }),
    Object.freeze({ maxAgeMs: 180 * 86_400_000, weightPpm: 450_000 }),
    Object.freeze({ maxAgeMs: 365 * 86_400_000, weightPpm: 250_000 }),
    Object.freeze({ maxAgeMs: Number.MAX_SAFE_INTEGER, weightPpm: 100_000 }),
  ]),
});

const PPM = MODEL_EVIDENCE_POLICY.ppm;
const DIGEST = /^[a-f0-9]{64}$/u;
const CANONICAL_MODEL_ID = /^[a-z0-9][a-z0-9._/-]{0,255}$/u;
const PROFILE_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const ENDPOINT_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const DIMENSIONS = new Set<ModelScoreDimension>([
  "task_capability",
  "reviewed_output_quality",
  "speed",
  "effective_cost",
  "preference",
]);
const OUTCOMES = new Set<ModelLifecycleOutcome>([
  "completed",
  "provisioning_failed",
  "adapter_failed",
  "timed_out",
  "result_missing",
  "lost",
]);
const SOURCE_KINDS = new Set<ModelEvidenceSourceKind>([
  "foundation",
  "broker_lifecycle",
  "broker_measurement",
  "independent_review",
  "human",
]);

export type Ppm = number;
export type ModelEvidenceSourceKind =
  | "foundation"
  | "broker_lifecycle"
  | "broker_measurement"
  | "independent_review"
  | "human";
export type ModelScoreDimension =
  | "task_capability"
  | "reviewed_output_quality"
  | "speed"
  | "effective_cost"
  | "preference";
export type ModelLifecycleOutcome =
  | "completed"
  | "provisioning_failed"
  | "adapter_failed"
  | "timed_out"
  | "result_missing"
  | "lost";

export interface CanonicalModelSubject {
  readonly kind: "canonical";
  readonly canonicalModelId: string;
}

export interface RuntimeModelSubject {
  readonly kind: "runtime";
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: string;
  readonly endpointId?: string;
}

export type ModelEvidenceSubject = CanonicalModelSubject | RuntimeModelSubject;

export interface RunEvidenceBinding {
  readonly kind: "run";
  readonly runId: string;
}

export interface ReviewEvidenceBinding {
  readonly kind: "review";
  readonly taskId: string;
  readonly runId: string;
  readonly resultId: string;
  readonly reviewerAgentId: string;
  readonly reviewerModelFamily: string;
  readonly resultDigest: string;
  readonly rubricVersion: string;
}

export type ModelEvidenceBinding = RunEvidenceBinding | ReviewEvidenceBinding;

interface ModelEvidenceBase {
  readonly schemaVersion: 1;
  readonly evidenceId: string;
  readonly sourceKind: ModelEvidenceSourceKind;
  readonly sourceName: string;
  readonly sourceKey: string;
  readonly taskProfile: string;
  readonly subject: ModelEvidenceSubject;
  readonly sampleCount: number;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly binding?: ModelEvidenceBinding;
}

export interface ModelScoreEvidence extends ModelEvidenceBase {
  readonly evidenceKind: "score";
  readonly dimension: ModelScoreDimension;
  readonly valuePpm: Ppm;
  readonly confidencePpm: Ppm;
}

export interface ModelLifecycleEvidence extends ModelEvidenceBase {
  readonly evidenceKind: "lifecycle";
  readonly outcome: ModelLifecycleOutcome;
}

export type ModelEvidenceRecord = ModelScoreEvidence | ModelLifecycleEvidence;
export type ModelScoreEvidenceInput = Omit<ModelScoreEvidence, "evidenceId">;
export type ModelLifecycleEvidenceInput = Omit<
  ModelLifecycleEvidence,
  "evidenceId"
>;
export type ModelEvidenceInput =
  ModelScoreEvidenceInput | ModelLifecycleEvidenceInput;

export interface StoredModelEvidence {
  readonly record: ModelEvidenceRecord;
  readonly recordedEventSeq: number;
}

export interface ModelEvidenceAggregate {
  readonly aggregateKey: string;
  readonly evidenceKind: "score" | "lifecycle";
  readonly sourceKind: ModelEvidenceSourceKind;
  readonly taskProfile: string;
  readonly subject: ModelEvidenceSubject;
  readonly dimension?: ModelScoreDimension;
  readonly valuePpm: Ppm;
  readonly confidencePpm: Ppm;
  readonly sampleCount: number;
  readonly evidenceCount: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly outcomeCounts?: Readonly<Record<ModelLifecycleOutcome, number>>;
}

export interface ModelEvidenceState {
  readonly schemaVersion: 1;
  readonly records: Readonly<Record<string, StoredModelEvidence>>;
  readonly supersededBy: Readonly<Record<string, string | null>>;
  readonly aggregates: Readonly<Record<string, ModelEvidenceAggregate>>;
  readonly compactedThroughEventSeq: number;
  readonly lastCompactionDigest?: string;
}

export interface ModelEvidenceSupersession {
  readonly schemaVersion: 1;
  readonly evidenceId: string;
  readonly replacement: ModelEvidenceRecord | null;
  readonly reason: "corrected" | "retracted";
  readonly supersededAt: string;
}

export interface ModelEvidenceCompaction {
  readonly schemaVersion: 1;
  readonly policyVersion: 1;
  readonly asOf: string;
  readonly throughEventSeq: number;
  readonly evidenceIds: readonly string[];
  readonly evidenceDigest: string;
  readonly aggregates: readonly ModelEvidenceAggregate[];
  readonly compactionDigest: string;
}

export interface ModelEvidenceCandidate {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: string;
  readonly endpointId?: string;
  readonly canonicalModelId?: string;
  readonly quantization?: string;
}

export interface ModelEvidenceMetric {
  readonly valuePpm: Ppm;
  readonly confidencePpm: Ppm;
  readonly sampleCount: number;
  readonly status: "missing" | "observed" | "prior_only" | "conflicting";
}

export interface ModelEvidenceCandidateProjection {
  readonly candidate: ModelEvidenceCandidate;
  readonly taskCapability: ModelEvidenceMetric & {
    readonly internetContributionPpm: Ppm;
  };
  readonly protocolReliability: ModelEvidenceMetric;
  readonly reviewedOutputQuality: ModelEvidenceMetric;
  readonly speed: ModelEvidenceMetric;
  readonly effectiveCost: ModelEvidenceMetric;
  readonly preference: ModelEvidenceMetric;
  readonly overallConfidencePpm: Ppm;
  readonly evidenceDigest: string;
}

export interface ModelEvidenceProjection {
  readonly schemaVersion: 1;
  readonly policyVersion: 1;
  readonly taskProfile: string;
  readonly asOf: string;
  readonly candidates: readonly ModelEvidenceCandidateProjection[];
  readonly evidenceDigest: string;
}

interface WeightedObservation {
  readonly valuePpm: number;
  readonly confidencePpm: number;
  readonly sampleCount: number;
  readonly observedAt: string;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${path} must be a plain object.`);
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, maxBytes: number, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`${path} is invalid.`);
  return value;
}

function ppm(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > PPM)
    throw new Error(`${path} must be an integer from 0 to ${PPM}.`);
  return Number(value);
}

function positiveCount(value: unknown, path: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > 10_000
  )
    throw new Error(`${path} must be an integer from 1 to 10000.`);
  return Number(value);
}

export function canonicalEvidenceJson(value: unknown): string {
  if (
    value === undefined ||
    (typeof value === "number" &&
      (!Number.isFinite(value) || Object.is(value, -0))) ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  )
    throw new TypeError("Value is not canonical evidence JSON.");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++)
      if (!Object.hasOwn(value, index))
        throw new TypeError("Sparse arrays are not canonical evidence JSON.");
    return `[${value.map(canonicalEvidenceJson).join(",")}]`;
  }
  const item = record(value, "Canonical evidence value");
  const symbolKeys = Object.getOwnPropertySymbols(item);
  if (symbolKeys.length > 0)
    throw new TypeError("Symbol keys are not canonical evidence JSON.");
  const keys = Object.keys(item).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalEvidenceJson(item[key])}`)
    .join(",")}}`;
}

function evidenceDigest(value: unknown): string {
  return sha256(`pi-herdr:model-evidence:v1\0${canonicalEvidenceJson(value)}`);
}

function validTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} is invalid.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error(`${path} is invalid.`);
  return value;
}

function normalizeSubject(value: unknown): ModelEvidenceSubject {
  const subject = record(value, "subject");
  if (subject.kind === "canonical") {
    if (
      !exactKeys(subject, ["kind", "canonicalModelId"]) ||
      typeof subject.canonicalModelId !== "string" ||
      !CANONICAL_MODEL_ID.test(subject.canonicalModelId)
    )
      throw new Error("Canonical evidence subject is invalid.");
    return { kind: "canonical", canonicalModelId: subject.canonicalModelId };
  }
  if (subject.kind !== "runtime")
    throw new Error("Evidence subject is invalid.");
  const keys = ["kind", "provider", "modelId", "thinkingLevel"];
  if (subject.endpointId !== undefined) keys.push("endpointId");
  if (
    !exactKeys(subject, keys) ||
    (subject.endpointId !== undefined &&
      (typeof subject.endpointId !== "string" ||
        !ENDPOINT_ID.test(subject.endpointId)))
  )
    throw new Error("Runtime evidence subject is invalid.");
  return {
    kind: "runtime",
    provider: boundedText(subject.provider, 128, "subject.provider"),
    modelId: boundedText(subject.modelId, 256, "subject.modelId"),
    thinkingLevel: boundedText(
      subject.thinkingLevel,
      32,
      "subject.thinkingLevel",
    ),
    ...(subject.endpointId !== undefined
      ? { endpointId: subject.endpointId as string }
      : {}),
  };
}

function normalizeBinding(value: unknown): ModelEvidenceBinding {
  const binding = record(value, "binding");
  if (binding.kind === "run") {
    if (
      !exactKeys(binding, ["kind", "runId"]) ||
      !/^run_[0-9A-HJKMNP-TV-Z]{26}$/u.test(String(binding.runId))
    )
      throw new Error("Run evidence binding is invalid.");
    return { kind: "run", runId: String(binding.runId) };
  }
  if (
    binding.kind !== "review" ||
    !exactKeys(binding, [
      "kind",
      "taskId",
      "runId",
      "resultId",
      "reviewerAgentId",
      "reviewerModelFamily",
      "resultDigest",
      "rubricVersion",
    ]) ||
    !/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/u.test(String(binding.taskId)) ||
    !/^run_[0-9A-HJKMNP-TV-Z]{26}$/u.test(String(binding.runId)) ||
    !/^res_[0-9A-HJKMNP-TV-Z]{26}$/u.test(String(binding.resultId)) ||
    !/^agt_[0-9A-HJKMNP-TV-Z]{26}$/u.test(String(binding.reviewerAgentId)) ||
    !DIGEST.test(String(binding.resultDigest))
  )
    throw new Error("Review evidence binding is invalid.");
  return {
    kind: "review",
    taskId: String(binding.taskId),
    runId: String(binding.runId),
    resultId: String(binding.resultId),
    reviewerAgentId: String(binding.reviewerAgentId),
    reviewerModelFamily: boundedText(
      binding.reviewerModelFamily,
      256,
      "binding.reviewerModelFamily",
    ),
    resultDigest: String(binding.resultDigest),
    rubricVersion: boundedText(
      binding.rubricVersion,
      128,
      "binding.rubricVersion",
    ),
  };
}

function normalizeWithoutId(value: unknown): ModelEvidenceInput {
  const input = record(value, "Model evidence");
  const evidenceKind = input.evidenceKind;
  const optionalBinding = input.binding !== undefined ? ["binding"] : [];
  const common = [
    "schemaVersion",
    "evidenceKind",
    "sourceKind",
    "sourceName",
    "sourceKey",
    "taskProfile",
    "subject",
    "sampleCount",
    "observedAt",
    "expiresAt",
    ...optionalBinding,
  ];
  const kindKeys =
    evidenceKind === "score"
      ? ["dimension", "valuePpm", "confidencePpm"]
      : evidenceKind === "lifecycle"
        ? ["outcome"]
        : [];
  if (
    input.schemaVersion !== 1 ||
    kindKeys.length === 0 ||
    !exactKeys(input, [...common, ...kindKeys])
  )
    throw new Error("Model evidence shape is invalid.");
  if (
    typeof input.sourceKind !== "string" ||
    !SOURCE_KINDS.has(input.sourceKind as ModelEvidenceSourceKind)
  )
    throw new Error("Model evidence source kind is invalid.");
  const subject = normalizeSubject(input.subject);
  const observedAt = validTimestamp(input.observedAt, "observedAt");
  const expiresAt = validTimestamp(input.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(observedAt))
    throw new Error("expiresAt must be later than observedAt.");
  const binding =
    input.binding === undefined ? undefined : normalizeBinding(input.binding);
  const base = {
    schemaVersion: 1 as const,
    evidenceKind: evidenceKind as "score" | "lifecycle",
    sourceKind: input.sourceKind as ModelEvidenceSourceKind,
    sourceName: boundedText(input.sourceName, 128, "sourceName"),
    sourceKey: boundedText(input.sourceKey, 1024, "sourceKey"),
    taskProfile:
      typeof input.taskProfile === "string" &&
      PROFILE_ID.test(input.taskProfile)
        ? input.taskProfile
        : (() => {
            throw new Error("taskProfile is invalid.");
          })(),
    subject,
    sampleCount: positiveCount(input.sampleCount, "sampleCount"),
    observedAt,
    expiresAt,
    ...(binding ? { binding } : {}),
  };
  if (evidenceKind === "score") {
    if (
      typeof input.dimension !== "string" ||
      !DIMENSIONS.has(input.dimension as ModelScoreDimension)
    )
      throw new Error("Model evidence dimension is invalid.");
    return {
      ...base,
      evidenceKind: "score",
      dimension: input.dimension as ModelScoreDimension,
      valuePpm: ppm(input.valuePpm, "valuePpm"),
      confidencePpm: ppm(input.confidencePpm, "confidencePpm"),
    };
  }
  if (
    typeof input.outcome !== "string" ||
    !OUTCOMES.has(input.outcome as ModelLifecycleOutcome)
  )
    throw new Error("Model lifecycle outcome is invalid.");
  return {
    ...base,
    evidenceKind: "lifecycle",
    outcome: input.outcome as ModelLifecycleOutcome,
  };
}

function assertAuthority(recordValue: ModelEvidenceInput): void {
  const source = recordValue.sourceKind;
  const subject = recordValue.subject;
  if (source === "foundation") {
    if (
      recordValue.evidenceKind !== "score" ||
      recordValue.dimension !== "task_capability" ||
      subject.kind !== "canonical" ||
      recordValue.binding !== undefined
    )
      throw new Error("Foundation evidence authority is invalid.");
    return;
  }
  if (subject.kind !== "runtime")
    throw new Error("Local evidence requires an exact runtime subject.");
  if (source === "broker_lifecycle") {
    if (
      recordValue.evidenceKind !== "lifecycle" ||
      recordValue.binding?.kind !== "run" ||
      recordValue.binding.runId !== recordValue.sourceKey
    )
      throw new Error("Broker lifecycle evidence authority is invalid.");
    return;
  }
  if (source === "broker_measurement") {
    if (
      recordValue.evidenceKind !== "score" ||
      (recordValue.dimension !== "speed" &&
        recordValue.dimension !== "effective_cost") ||
      !subject.endpointId ||
      recordValue.binding?.kind !== "run"
    )
      throw new Error("Broker measurement evidence authority is invalid.");
    return;
  }
  if (source === "independent_review") {
    if (
      recordValue.evidenceKind !== "score" ||
      recordValue.dimension !== "reviewed_output_quality" ||
      recordValue.binding?.kind !== "review"
    )
      throw new Error("Independent review evidence authority is invalid.");
    return;
  }
  if (
    source !== "human" ||
    recordValue.evidenceKind !== "score" ||
    (recordValue.dimension !== "preference" &&
      recordValue.dimension !== "reviewed_output_quality") ||
    recordValue.binding !== undefined
  )
    throw new Error("Human preference evidence authority is invalid.");
}

export function normalizeModelEvidence(value: unknown): ModelEvidenceRecord {
  const input = normalizeWithoutId(value);
  assertAuthority(input);
  return { ...input, evidenceId: evidenceDigest(input) } as ModelEvidenceRecord;
}

export function validateModelEvidenceRecord(
  value: unknown,
): ModelEvidenceRecord {
  const input = record(value, "Model evidence record");
  if (
    !Object.hasOwn(input, "evidenceId") ||
    typeof input.evidenceId !== "string" ||
    !DIGEST.test(input.evidenceId)
  )
    throw new Error("Model evidence ID is invalid.");
  const { evidenceId, ...withoutId } = input;
  const normalized = normalizeModelEvidence(withoutId);
  if (normalized.evidenceId !== evidenceId)
    throw new Error("Model evidence ID does not match its canonical content.");
  return normalized;
}

export function emptyModelEvidenceState(): ModelEvidenceState {
  return {
    schemaVersion: 1,
    records: {},
    supersededBy: {},
    aggregates: {},
    compactedThroughEventSeq: 0,
  };
}

function parseAsOf(value: string): number {
  return Date.parse(validTimestamp(value, "asOf"));
}

function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n)
    throw new Error("Fixed-point division is invalid.");
  return (numerator + denominator / 2n) / denominator;
}

export function mulPpm(left: number, right: number): number {
  ppm(left, "left");
  ppm(right, "right");
  return Number(divRoundHalfUp(BigInt(left) * BigInt(right), BigInt(PPM)));
}

function weightedMean(
  items: readonly { value: number; weight: number }[],
): number {
  let numerator = 0n;
  let denominator = 0n;
  for (const item of items) {
    if (item.weight <= 0) continue;
    numerator += BigInt(item.value) * BigInt(item.weight);
    denominator += BigInt(item.weight);
  }
  return denominator === 0n
    ? MODEL_EVIDENCE_POLICY.neutralPpm
    : Number(divRoundHalfUp(numerator, denominator));
}

function recencyWeight(observedAt: string, asOfMs: number): number {
  const observedMs = Date.parse(observedAt);
  if (observedMs - asOfMs > MODEL_EVIDENCE_POLICY.maxFutureSkewMs)
    throw new Error("Evidence is too far in the future.");
  const age = Math.max(0, asOfMs - observedMs);
  return MODEL_EVIDENCE_POLICY.recencyBuckets.find(
    (bucket) => age <= bucket.maxAgeMs,
  )!.weightPpm;
}

function observationMetric(
  observations: readonly WeightedObservation[],
  asOfMs: number,
  fullConfidenceSamples: number,
): ModelEvidenceMetric {
  if (observations.length === 0)
    return {
      valuePpm: MODEL_EVIDENCE_POLICY.neutralPpm,
      confidencePpm: 0,
      sampleCount: 0,
      status: "missing",
    };
  const weighted = observations.map((item) => {
    const recency = recencyWeight(item.observedAt, asOfMs);
    const effective = mulPpm(item.confidencePpm, recency);
    return { ...item, effective };
  });
  const valuePpm = weightedMean(
    weighted.map((item) => ({ value: item.valuePpm, weight: item.effective })),
  );
  const totalSamples = weighted.reduce(
    (sum, item) => Math.min(1_000_000, sum + item.sampleCount),
    0,
  );
  const sampleConfidence = Math.min(
    PPM,
    Math.floor((totalSamples * PPM) / fullConfidenceSamples),
  );
  const baseConfidence = weightedMean(
    weighted.map((item) => ({
      value: item.effective,
      weight: item.effective,
    })),
  );
  const meanDeviation = weightedMean(
    weighted.map((item) => ({
      value: Math.abs(item.valuePpm - valuePpm),
      weight: item.effective,
    })),
  );
  const agreementPpm = Math.max(0, PPM - Math.min(PPM, meanDeviation * 2));
  const confidencePpm = mulPpm(
    mulPpm(baseConfidence, sampleConfidence),
    agreementPpm,
  );
  return {
    valuePpm,
    confidencePpm,
    sampleCount: totalSamples,
    status: agreementPpm < 750_000 ? "conflicting" : "observed",
  };
}

function aggregateKey(recordValue: ModelEvidenceRecord): string {
  return evidenceDigest({
    evidenceKind: recordValue.evidenceKind,
    sourceKind: recordValue.sourceKind,
    taskProfile: recordValue.taskProfile,
    subject: recordValue.subject,
    ...(recordValue.evidenceKind === "score"
      ? { dimension: recordValue.dimension }
      : {}),
  });
}

function sourceIdentity(recordValue: ModelEvidenceRecord): string {
  return `${recordValue.sourceKind}\u0000${recordValue.sourceName}\u0000${recordValue.sourceKey}`;
}

function activeRecords(state: ModelEvidenceState): StoredModelEvidence[] {
  return Object.values(state.records).filter(
    (stored) => !Object.hasOwn(state.supersededBy, stored.record.evidenceId),
  );
}

export function applyModelEvidenceRecord(
  stateValue: ModelEvidenceState | undefined,
  recordValue: ModelEvidenceRecord,
  eventSeq: number,
): ModelEvidenceState {
  const state = stateValue ?? emptyModelEvidenceState();
  const recordItem = validateModelEvidenceRecord(recordValue);
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 1)
    throw new Error("Evidence event sequence is invalid.");
  if (state.records[recordItem.evidenceId])
    throw new Error("Model evidence already exists.");
  if (
    Object.keys(state.records).length >= MODEL_EVIDENCE_POLICY.maxActiveRecords
  )
    throw new Error("Active model evidence is at its bounded limit.");
  const source = sourceIdentity(recordItem);
  if (
    activeRecords(state).some(
      (stored) => sourceIdentity(stored.record) === source,
    )
  )
    throw new Error("Active model evidence has a duplicate source key.");
  return {
    ...state,
    records: {
      ...state.records,
      [recordItem.evidenceId]: {
        record: recordItem,
        recordedEventSeq: eventSeq,
      },
    },
  };
}

export function validateModelEvidenceSupersession(
  value: unknown,
): ModelEvidenceSupersession {
  const input = record(value, "Model evidence supersession");
  if (
    !exactKeys(input, [
      "schemaVersion",
      "evidenceId",
      "replacement",
      "reason",
      "supersededAt",
    ]) ||
    input.schemaVersion !== 1 ||
    typeof input.evidenceId !== "string" ||
    !DIGEST.test(input.evidenceId) ||
    (input.reason !== "corrected" && input.reason !== "retracted") ||
    (input.reason === "corrected" && input.replacement === null) ||
    (input.reason === "retracted" && input.replacement !== null)
  )
    throw new Error("Model evidence supersession is invalid.");
  const replacement =
    input.replacement === null
      ? null
      : validateModelEvidenceRecord(input.replacement);
  if (replacement?.evidenceId === input.evidenceId)
    throw new Error("Replacement model evidence must have new content.");
  return {
    schemaVersion: 1,
    evidenceId: input.evidenceId,
    replacement,
    reason: input.reason,
    supersededAt: validTimestamp(input.supersededAt, "supersededAt"),
  };
}

export function applyModelEvidenceSupersession(
  stateValue: ModelEvidenceState | undefined,
  value: ModelEvidenceSupersession,
  eventSeq: number,
): ModelEvidenceState {
  const state = stateValue ?? emptyModelEvidenceState();
  const supersession = validateModelEvidenceSupersession(value);
  const target = state.records[supersession.evidenceId];
  if (!target || Object.hasOwn(state.supersededBy, supersession.evidenceId))
    throw new Error("Superseded model evidence is unavailable or inactive.");
  if (
    Date.parse(supersession.supersededAt) < Date.parse(target.record.observedAt)
  )
    throw new Error(
      "Model evidence cannot be superseded before it was observed.",
    );
  const replacement = supersession.replacement;
  if (replacement) {
    if (!Number.isSafeInteger(eventSeq) || eventSeq < 1)
      throw new Error("Evidence event sequence is invalid.");
    if (state.records[replacement.evidenceId])
      throw new Error("Replacement model evidence already exists.");
    if (sourceIdentity(replacement) !== sourceIdentity(target.record))
      throw new Error(
        "Replacement model evidence must keep the same source identity.",
      );
    if (
      Object.keys(state.records).length >=
      MODEL_EVIDENCE_POLICY.maxActiveRecords
    )
      throw new Error("Active model evidence is at its bounded limit.");
  }
  return {
    ...state,
    records: replacement
      ? {
          ...state.records,
          [replacement.evidenceId]: {
            record: replacement,
            recordedEventSeq: eventSeq,
          },
        }
      : state.records,
    supersededBy: {
      ...state.supersededBy,
      [supersession.evidenceId]: replacement?.evidenceId ?? null,
    },
  };
}

function aggregateObservation(
  aggregate: ModelEvidenceAggregate,
): WeightedObservation {
  return {
    valuePpm: aggregate.valuePpm,
    confidencePpm: aggregate.confidencePpm,
    sampleCount: aggregate.sampleCount,
    observedAt: aggregate.lastObservedAt,
  };
}

function aggregateRecords(
  records: readonly ModelEvidenceRecord[],
  existing: ModelEvidenceAggregate | undefined,
  asOfMs: number,
): ModelEvidenceAggregate {
  const first = records[0];
  if (!first) throw new Error("Cannot aggregate an empty evidence set.");
  const scoreObservations: WeightedObservation[] = [];
  const outcomeCounts: Record<ModelLifecycleOutcome, number> = {
    completed: 0,
    provisioning_failed: 0,
    adapter_failed: 0,
    timed_out: 0,
    result_missing: 0,
    lost: 0,
  };
  if (existing) {
    scoreObservations.push(aggregateObservation(existing));
    for (const outcome of OUTCOMES)
      outcomeCounts[outcome] = existing.outcomeCounts?.[outcome] ?? 0;
  }
  for (const item of records) {
    if (item.evidenceKind === "score")
      scoreObservations.push({
        valuePpm: item.valuePpm,
        confidencePpm: item.confidencePpm,
        sampleCount: item.sampleCount,
        observedAt: item.observedAt,
      });
    else {
      outcomeCounts[item.outcome] += item.sampleCount;
      scoreObservations.push({
        valuePpm: item.outcome === "completed" ? PPM : 0,
        confidencePpm: PPM,
        sampleCount: item.sampleCount,
        observedAt: item.observedAt,
      });
    }
  }
  const metric = observationMetric(
    scoreObservations,
    asOfMs,
    first.evidenceKind === "lifecycle"
      ? MODEL_EVIDENCE_POLICY.lifecycleFullConfidenceSamples
      : MODEL_EVIDENCE_POLICY.qualityFullConfidenceSamples,
  );
  const times = [
    ...records.map((item) => item.observedAt),
    ...(existing ? [existing.firstObservedAt, existing.lastObservedAt] : []),
  ].sort();
  return {
    aggregateKey: aggregateKey(first),
    evidenceKind: first.evidenceKind,
    sourceKind: first.sourceKind,
    taskProfile: first.taskProfile,
    subject: first.subject,
    ...(first.evidenceKind === "score" ? { dimension: first.dimension } : {}),
    valuePpm: metric.valuePpm,
    confidencePpm: metric.confidencePpm,
    sampleCount: metric.sampleCount,
    evidenceCount: (existing?.evidenceCount ?? 0) + records.length,
    firstObservedAt: times[0]!,
    lastObservedAt: times.at(-1)!,
    ...(first.evidenceKind === "lifecycle" ? { outcomeCounts } : {}),
  };
}

function compactionPreimage(
  value: Omit<ModelEvidenceCompaction, "compactionDigest">,
): string {
  return evidenceDigest(value);
}

export function planModelEvidenceCompaction(
  stateValue: ModelEvidenceState | undefined,
  asOf: string,
  throughEventSeq: number,
): ModelEvidenceCompaction | undefined {
  const state = stateValue ?? emptyModelEvidenceState();
  const asOfMs = parseAsOf(asOf);
  if (!Number.isSafeInteger(throughEventSeq) || throughEventSeq < 1)
    throw new Error("Compaction event sequence bound is invalid.");
  const expiredIds = new Set(
    Object.values(state.records)
      .filter(
        (stored) =>
          stored.recordedEventSeq <= throughEventSeq &&
          Date.parse(stored.record.expiresAt) <= asOfMs,
      )
      .map((stored) => stored.record.evidenceId),
  );
  const predecessor = new Map<string, string>();
  for (const [evidenceId, replacementId] of Object.entries(state.supersededBy))
    if (replacementId !== null) predecessor.set(replacementId, evidenceId);
  const remaining = [...expiredIds].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const selected = new Set<string>();
  while (
    selected.size < MODEL_EVIDENCE_POLICY.maxCompactionRecords &&
    remaining.length > 0
  ) {
    let progressed = false;
    for (let index = 0; index < remaining.length;) {
      const evidenceId = remaining[index]!;
      const prior = predecessor.get(evidenceId);
      if (prior && state.records[prior] && !selected.has(prior)) {
        index++;
        continue;
      }
      selected.add(evidenceId);
      remaining.splice(index, 1);
      progressed = true;
      if (selected.size >= MODEL_EVIDENCE_POLICY.maxCompactionRecords) break;
    }
    if (!progressed) break;
  }
  const eligible = Object.values(state.records)
    .filter((stored) => selected.has(stored.record.evidenceId))
    .sort((left, right) =>
      left.record.evidenceId < right.record.evidenceId
        ? -1
        : left.record.evidenceId > right.record.evidenceId
          ? 1
          : 0,
    );
  if (eligible.length === 0) return undefined;
  const active = eligible.filter(
    (stored) => !Object.hasOwn(state.supersededBy, stored.record.evidenceId),
  );
  const grouped = new Map<string, ModelEvidenceRecord[]>();
  for (const stored of active) {
    const key = aggregateKey(stored.record);
    const group = grouped.get(key) ?? [];
    group.push(stored.record);
    grouped.set(key, group);
  }
  const aggregateUpdates: ModelEvidenceAggregate[] = [];
  for (const key of [...grouped.keys()].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  ))
    aggregateUpdates.push(
      aggregateRecords(grouped.get(key)!, state.aggregates[key], asOfMs),
    );
  const aggregateKeys = new Set([
    ...Object.keys(state.aggregates),
    ...aggregateUpdates.map((aggregate) => aggregate.aggregateKey),
  ]);
  if (aggregateKeys.size > MODEL_EVIDENCE_POLICY.maxAggregates)
    throw new Error("Model evidence aggregates are at their bounded limit.");
  const evidenceIds = eligible.map((stored) => stored.record.evidenceId);
  const withoutDigest: Omit<ModelEvidenceCompaction, "compactionDigest"> = {
    schemaVersion: 1,
    policyVersion: 1,
    asOf,
    throughEventSeq,
    evidenceIds,
    evidenceDigest: evidenceDigest(
      eligible.map((stored) => {
        const supersededBy = state.supersededBy[stored.record.evidenceId];
        return {
          evidenceId: stored.record.evidenceId,
          recordedEventSeq: stored.recordedEventSeq,
          ...(supersededBy !== undefined ? { supersededBy } : {}),
        };
      }),
    ),
    aggregates: aggregateUpdates,
  };
  return {
    ...withoutDigest,
    compactionDigest: compactionPreimage(withoutDigest),
  };
}

export function validateModelEvidenceCompaction(
  value: unknown,
): ModelEvidenceCompaction {
  const input = record(value, "Model evidence compaction");
  if (
    !exactKeys(input, [
      "schemaVersion",
      "policyVersion",
      "asOf",
      "throughEventSeq",
      "evidenceIds",
      "evidenceDigest",
      "aggregates",
      "compactionDigest",
    ]) ||
    input.schemaVersion !== 1 ||
    input.policyVersion !== 1 ||
    !Number.isSafeInteger(input.throughEventSeq) ||
    Number(input.throughEventSeq) < 1 ||
    !Array.isArray(input.evidenceIds) ||
    input.evidenceIds.length < 1 ||
    input.evidenceIds.length > MODEL_EVIDENCE_POLICY.maxCompactionRecords ||
    input.evidenceIds.some(
      (id) => typeof id !== "string" || !DIGEST.test(id),
    ) ||
    input.evidenceIds.some(
      (id, index, ids) => index > 0 && String(ids[index - 1]) >= String(id),
    ) ||
    typeof input.evidenceDigest !== "string" ||
    !DIGEST.test(input.evidenceDigest) ||
    !Array.isArray(input.aggregates) ||
    input.aggregates.length > MODEL_EVIDENCE_POLICY.maxAggregates ||
    typeof input.compactionDigest !== "string" ||
    !DIGEST.test(input.compactionDigest)
  )
    throw new Error("Model evidence compaction is invalid.");
  validTimestamp(input.asOf, "asOf");
  const normalized = input as unknown as ModelEvidenceCompaction;
  const { compactionDigest, ...withoutDigest } = normalized;
  if (compactionPreimage(withoutDigest) !== compactionDigest)
    throw new Error("Model evidence compaction digest is invalid.");
  return normalized;
}

export function applyModelEvidenceCompaction(
  stateValue: ModelEvidenceState | undefined,
  value: ModelEvidenceCompaction,
): ModelEvidenceState {
  const state = stateValue ?? emptyModelEvidenceState();
  const compacted = validateModelEvidenceCompaction(value);
  const expected = planModelEvidenceCompaction(
    state,
    compacted.asOf,
    compacted.throughEventSeq,
  );
  if (
    !expected ||
    canonicalEvidenceJson(expected) !== canonicalEvidenceJson(compacted)
  )
    throw new Error(
      "Model evidence compaction does not match durable evidence.",
    );
  const removed = new Set(compacted.evidenceIds);
  return {
    schemaVersion: 1,
    records: Object.fromEntries(
      Object.entries(state.records).filter(
        ([evidenceId]) => !removed.has(evidenceId),
      ),
    ),
    supersededBy: Object.fromEntries(
      Object.entries(state.supersededBy).filter(
        ([evidenceId, replacement]) =>
          !removed.has(evidenceId) &&
          (replacement === null || !removed.has(replacement)),
      ),
    ),
    aggregates: {
      ...state.aggregates,
      ...Object.fromEntries(
        compacted.aggregates.map((aggregate) => [
          aggregate.aggregateKey,
          aggregate,
        ]),
      ),
    },
    compactedThroughEventSeq: Math.max(
      state.compactedThroughEventSeq,
      compacted.throughEventSeq,
    ),
    lastCompactionDigest: compacted.compactionDigest,
  };
}

function candidateMatches(
  subject: RuntimeModelSubject,
  candidate: ModelEvidenceCandidate,
): boolean {
  return (
    subject.provider === candidate.provider &&
    subject.modelId === candidate.modelId &&
    subject.thinkingLevel === candidate.thinkingLevel &&
    (subject.endpointId === undefined ||
      subject.endpointId === candidate.endpointId)
  );
}

function scoreObservations(
  state: ModelEvidenceState,
  candidate: ModelEvidenceCandidate,
  taskProfile: string,
  dimension: ModelScoreDimension,
  asOfMs: number,
  canonical = false,
): WeightedObservation[] {
  const observations: WeightedObservation[] = [];
  for (const stored of activeRecords(state)) {
    const item = stored.record;
    if (
      item.evidenceKind !== "score" ||
      item.dimension !== dimension ||
      item.taskProfile !== taskProfile ||
      Date.parse(item.expiresAt) <= asOfMs
    )
      continue;
    const matches = canonical
      ? item.subject.kind === "canonical" &&
        item.subject.canonicalModelId === candidate.canonicalModelId
      : item.subject.kind === "runtime" &&
        candidateMatches(item.subject, candidate);
    if (matches)
      observations.push({
        valuePpm: item.valuePpm,
        confidencePpm: item.confidencePpm,
        sampleCount: item.sampleCount,
        observedAt: item.observedAt,
      });
  }
  for (const aggregate of Object.values(state.aggregates)) {
    if (
      aggregate.evidenceKind !== "score" ||
      aggregate.dimension !== dimension ||
      aggregate.taskProfile !== taskProfile
    )
      continue;
    const matches = canonical
      ? aggregate.subject.kind === "canonical" &&
        aggregate.subject.canonicalModelId === candidate.canonicalModelId
      : aggregate.subject.kind === "runtime" &&
        candidateMatches(aggregate.subject, candidate);
    if (matches) observations.push(aggregateObservation(aggregate));
  }
  return observations;
}

function lifecycleObservations(
  state: ModelEvidenceState,
  candidate: ModelEvidenceCandidate,
  taskProfile: string,
  asOfMs: number,
): WeightedObservation[] {
  const observations: WeightedObservation[] = [];
  for (const stored of activeRecords(state)) {
    const item = stored.record;
    if (
      item.evidenceKind !== "lifecycle" ||
      item.taskProfile !== taskProfile ||
      Date.parse(item.expiresAt) <= asOfMs ||
      item.subject.kind !== "runtime" ||
      !candidateMatches(item.subject, candidate)
    )
      continue;
    observations.push({
      valuePpm: item.outcome === "completed" ? PPM : 0,
      confidencePpm: PPM,
      sampleCount: item.sampleCount,
      observedAt: item.observedAt,
    });
  }
  for (const aggregate of Object.values(state.aggregates))
    if (
      aggregate.evidenceKind === "lifecycle" &&
      aggregate.taskProfile === taskProfile &&
      aggregate.subject.kind === "runtime" &&
      candidateMatches(aggregate.subject, candidate)
    )
      observations.push(aggregateObservation(aggregate));
  return observations;
}

function blendTaskCapability(
  local: ModelEvidenceMetric,
  prior: ModelEvidenceMetric,
): ModelEvidenceMetric & { internetContributionPpm: number } {
  if (local.status === "missing") {
    if (prior.status === "missing")
      return { ...local, internetContributionPpm: 0 };
    return {
      ...prior,
      confidencePpm: Math.min(
        prior.confidencePpm,
        MODEL_EVIDENCE_POLICY.internetBlendCapPpm,
      ),
      status: "prior_only",
      internetContributionPpm: PPM,
    };
  }
  if (prior.status === "missing")
    return { ...local, internetContributionPpm: 0 };
  const maxPriorWeight = Math.floor(
    (local.confidencePpm * MODEL_EVIDENCE_POLICY.internetBlendCapPpm) /
      (PPM - MODEL_EVIDENCE_POLICY.internetBlendCapPpm),
  );
  const priorWeight = Math.min(prior.confidencePpm, maxPriorWeight);
  if (priorWeight === 0) return { ...local, internetContributionPpm: 0 };
  const valuePpm = weightedMean([
    { value: local.valuePpm, weight: local.confidencePpm },
    { value: prior.valuePpm, weight: priorWeight },
  ]);
  const total = local.confidencePpm + priorWeight;
  return {
    valuePpm,
    confidencePpm: Math.min(PPM, total),
    sampleCount: Math.min(1_000_000, local.sampleCount + prior.sampleCount),
    status:
      local.status === "conflicting" || prior.status === "conflicting"
        ? "conflicting"
        : "observed",
    internetContributionPpm: Math.floor((priorWeight * PPM) / total),
  };
}

function candidateSortKey(candidate: ModelEvidenceCandidate): string {
  return [
    candidate.provider,
    candidate.modelId,
    candidate.thinkingLevel,
    candidate.endpointId ?? "",
  ].join("\u0000");
}

export function projectModelEvidence(
  stateValue: ModelEvidenceState | undefined,
  candidates: readonly ModelEvidenceCandidate[],
  taskProfile: string,
  asOf: string,
): ModelEvidenceProjection {
  const state = stateValue ?? emptyModelEvidenceState();
  if (!PROFILE_ID.test(taskProfile)) throw new Error("taskProfile is invalid.");
  const asOfMs = parseAsOf(asOf);
  const ordered = [...candidates].sort((left, right) => {
    const leftKey = candidateSortKey(left);
    const rightKey = candidateSortKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  for (let index = 1; index < ordered.length; index++)
    if (
      candidateSortKey(ordered[index - 1]!) ===
      candidateSortKey(ordered[index]!)
    )
      throw new Error(
        "Model evidence candidates contain a duplicate exact runtime.",
      );
  const projected = ordered.map(
    (candidate): ModelEvidenceCandidateProjection => {
      const reviewedOutputQuality = observationMetric(
        scoreObservations(
          state,
          candidate,
          taskProfile,
          "reviewed_output_quality",
          asOfMs,
        ),
        asOfMs,
        MODEL_EVIDENCE_POLICY.qualityFullConfidenceSamples,
      );
      const prior = candidate.canonicalModelId
        ? observationMetric(
            scoreObservations(
              state,
              candidate,
              taskProfile,
              "task_capability",
              asOfMs,
              true,
            ),
            asOfMs,
            MODEL_EVIDENCE_POLICY.qualityFullConfidenceSamples,
          )
        : observationMetric(
            [],
            asOfMs,
            MODEL_EVIDENCE_POLICY.qualityFullConfidenceSamples,
          );
      const taskCapability = blendTaskCapability(reviewedOutputQuality, prior);
      const protocolReliability = observationMetric(
        lifecycleObservations(state, candidate, taskProfile, asOfMs),
        asOfMs,
        MODEL_EVIDENCE_POLICY.lifecycleFullConfidenceSamples,
      );
      const speed = observationMetric(
        scoreObservations(state, candidate, taskProfile, "speed", asOfMs),
        asOfMs,
        MODEL_EVIDENCE_POLICY.qualityFullConfidenceSamples,
      );
      const effectiveCost = observationMetric(
        scoreObservations(
          state,
          candidate,
          taskProfile,
          "effective_cost",
          asOfMs,
        ),
        asOfMs,
        MODEL_EVIDENCE_POLICY.qualityFullConfidenceSamples,
      );
      const preference = observationMetric(
        scoreObservations(state, candidate, taskProfile, "preference", asOfMs),
        asOfMs,
        MODEL_EVIDENCE_POLICY.qualityFullConfidenceSamples,
      );
      const dimensions = [
        taskCapability,
        protocolReliability,
        speed,
        effectiveCost,
        preference,
      ];
      const overallConfidencePpm = Math.floor(
        dimensions.reduce((sum, metric) => sum + metric.confidencePpm, 0) /
          dimensions.length,
      );
      const preimage = {
        candidate,
        taskCapability,
        protocolReliability,
        reviewedOutputQuality,
        speed,
        effectiveCost,
        preference,
        overallConfidencePpm,
      };
      return { ...preimage, evidenceDigest: evidenceDigest(preimage) };
    },
  );
  const withoutDigest = {
    schemaVersion: 1 as const,
    policyVersion: 1 as const,
    taskProfile,
    asOf,
    candidates: projected,
  };
  return { ...withoutDigest, evidenceDigest: evidenceDigest(withoutDigest) };
}

export function modelEvidenceStateDigest(
  stateValue: ModelEvidenceState | undefined,
): string {
  return evidenceDigest(stateValue ?? emptyModelEvidenceState());
}
