import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyModelEvidenceCompaction,
  applyModelEvidenceRecord,
  applyModelEvidenceSupersession,
  canonicalEvidenceJson,
  emptyModelEvidenceState,
  modelEvidenceStateDigest,
  MODEL_EVIDENCE_POLICY,
  normalizeModelEvidence,
  planModelEvidenceCompaction,
  projectModelEvidence,
  type ModelEvidenceInput,
  type ModelEvidenceState,
} from "../../src/model-intelligence/model-evidence.js";
import { validateEndpointPolicyConfig } from "../../src/broker/endpoint-policy.js";
import { createId } from "../../src/shared/ids.js";
import { canonicalJson } from "../../src/shared/canonical-json.js";
import { EventStore } from "../../src/state/event-store.js";

const observedAt = "2026-01-01T00:00:00.000Z";
const expiresAt = "2026-02-01T00:00:00.000Z";
const activeAsOf = "2026-01-08T00:00:00.000Z";
const compactAsOf = "2026-03-01T00:00:00.000Z";

function runtime(endpointId = "local_one") {
  return {
    kind: "runtime" as const,
    provider: "local",
    modelId: "model-q4",
    thinkingLevel: "medium",
    endpointId,
  };
}

function reviewInput(
  sourceKey: string,
  valuePpm: number,
  endpointId = "local_one",
): ModelEvidenceInput {
  return {
    schemaVersion: 1,
    evidenceKind: "score",
    sourceKind: "independent_review",
    sourceName: "broker-review",
    sourceKey,
    taskProfile: "coding",
    subject: runtime(endpointId),
    sampleCount: 1,
    observedAt,
    expiresAt,
    dimension: "reviewed_output_quality",
    valuePpm,
    confidencePpm: 900_000,
    binding: {
      kind: "review",
      taskId: createId("tsk"),
      runId: createId("run"),
      resultId: createId("res"),
      reviewerAgentId: createId("agt"),
      reviewerModelFamily: `reviewer-${sourceKey}`,
      resultDigest: "a".repeat(64),
      rubricVersion: "quality-v1",
    },
  };
}

function add(
  state: ModelEvidenceState,
  input: ModelEvidenceInput,
  seq: number,
): ModelEvidenceState {
  return applyModelEvidenceRecord(state, normalizeModelEvidence(input), seq);
}

test("model evidence canonicalization and authority fail closed", () => {
  assert.equal(
    canonicalEvidenceJson({ z: 1, A: 2, a: 3 }),
    '{"A":2,"a":3,"z":1}',
  );
  assert.throws(() => canonicalEvidenceJson(-0), /not canonical/);
  const sparse = Array(2);
  sparse[1] = "x";
  assert.throws(() => canonicalEvidenceJson(sparse), /Sparse arrays/);

  const foundation = normalizeModelEvidence({
    schemaVersion: 1,
    evidenceKind: "score",
    sourceKind: "foundation",
    sourceName: "openrouter",
    sourceKey: "benchmark-1",
    taskProfile: "coding",
    subject: { kind: "canonical", canonicalModelId: "vendor/model" },
    sampleCount: 1,
    observedAt,
    expiresAt,
    dimension: "task_capability",
    valuePpm: 800_000,
    confidencePpm: 700_000,
  });
  assert.match(foundation.evidenceId, /^[a-f0-9]{64}$/);
  const { evidenceId: _evidenceId, ...foundationInput } = foundation;
  assert.equal(
    normalizeModelEvidence(foundationInput).evidenceId,
    foundation.evidenceId,
  );
  assert.throws(
    () =>
      normalizeModelEvidence({
        ...reviewInput("bad-review", 800_000),
        sourceKind: "foundation",
      }),
    /Foundation evidence authority/,
  );
  assert.throws(
    () =>
      normalizeModelEvidence({
        ...reviewInput("bad-speed", 800_000),
        sourceKind: "broker_measurement",
        dimension: "speed",
        subject: {
          kind: "runtime",
          provider: "local",
          modelId: "model-q4",
          thinkingLevel: "medium",
        },
        binding: { kind: "run", runId: createId("run") },
      }),
    /Broker measurement evidence authority/,
  );
  const humanQuality = normalizeModelEvidence({
    schemaVersion: 1,
    evidenceKind: "score",
    sourceKind: "human",
    sourceName: "operator",
    sourceKey: "quality-1",
    taskProfile: "coding",
    subject: runtime(),
    sampleCount: 1,
    observedAt,
    expiresAt,
    dimension: "reviewed_output_quality",
    valuePpm: 750_000,
    confidencePpm: 800_000,
  });
  assert.equal(humanQuality.evidenceKind, "score");
});

test("fixed-point projection caps the internet prior and keeps endpoint and lifecycle evidence separate", () => {
  let state = emptyModelEvidenceState();
  state = add(
    state,
    {
      schemaVersion: 1,
      evidenceKind: "score",
      sourceKind: "foundation",
      sourceName: "openrouter",
      sourceKey: "coding-prior",
      taskProfile: "coding",
      subject: { kind: "canonical", canonicalModelId: "vendor/model" },
      sampleCount: 10,
      observedAt,
      expiresAt,
      dimension: "task_capability",
      valuePpm: 1_000_000,
      confidencePpm: 1_000_000,
    },
    1,
  );
  for (let index = 0; index < 5; index++)
    state = add(state, reviewInput(`review-${index}`, 200_000), index + 2);
  const runId = createId("run");
  state = add(
    state,
    {
      schemaVersion: 1,
      evidenceKind: "lifecycle",
      sourceKind: "broker_lifecycle",
      sourceName: "broker",
      sourceKey: runId,
      taskProfile: "coding",
      subject: runtime(),
      sampleCount: 1,
      observedAt,
      expiresAt,
      outcome: "result_missing",
      binding: { kind: "run", runId },
    },
    7,
  );
  const speedRun = createId("run");
  state = add(
    state,
    {
      schemaVersion: 1,
      evidenceKind: "score",
      sourceKind: "broker_measurement",
      sourceName: "broker-timing",
      sourceKey: "speed-local-one",
      taskProfile: "coding",
      subject: runtime(),
      sampleCount: 1,
      observedAt,
      expiresAt,
      dimension: "speed",
      valuePpm: 900_000,
      confidencePpm: 800_000,
      binding: { kind: "run", runId: speedRun },
    },
    8,
  );
  const candidates = [
    {
      provider: "local",
      modelId: "model-q4",
      thinkingLevel: "medium",
      endpointId: "remote_two",
      canonicalModelId: "vendor/model",
    },
    {
      provider: "local",
      modelId: "model-q4",
      thinkingLevel: "medium",
      endpointId: "local_one",
      canonicalModelId: "vendor/model",
      quantization: "q4_k_m",
    },
  ];
  const first = projectModelEvidence(state, candidates, "coding", activeAsOf);
  const second = projectModelEvidence(
    state,
    [...candidates].reverse(),
    "coding",
    activeAsOf,
  );
  assert.deepEqual(second, first);
  assert.equal(first.candidates[0]?.candidate.endpointId, "local_one");
  const local = first.candidates[0]!;
  const remote = first.candidates[1]!;
  assert.ok(local.taskCapability.internetContributionPpm <= 200_000);
  assert.ok(local.taskCapability.valuePpm < 400_000);
  assert.equal(local.protocolReliability.valuePpm, 0);
  assert.equal(local.reviewedOutputQuality.valuePpm, 200_000);
  assert.equal(local.speed.valuePpm, 900_000);
  assert.equal(remote.speed.status, "missing");
  assert.equal(remote.protocolReliability.status, "missing");
  assert.match(first.evidenceDigest, /^[a-f0-9]{64}$/);
});

test("stale and sparse evidence has less confidence than fresh dense evidence", () => {
  let sparse = emptyModelEvidenceState();
  sparse = add(
    sparse,
    {
      ...reviewInput("sparse", 700_000),
      expiresAt: "2027-02-01T00:00:00.000Z",
    },
    1,
  );
  let dense = emptyModelEvidenceState();
  for (let index = 0; index < 5; index++)
    dense = add(
      dense,
      {
        ...reviewInput(`dense-${index}`, 700_000),
        expiresAt: "2027-02-01T00:00:00.000Z",
      },
      index + 1,
    );
  const candidate = [
    {
      provider: "local",
      modelId: "model-q4",
      thinkingLevel: "medium",
      endpointId: "local_one",
    },
  ];
  const freshSparse = projectModelEvidence(
    sparse,
    candidate,
    "coding",
    activeAsOf,
  );
  const staleSparse = projectModelEvidence(
    sparse,
    candidate,
    "coding",
    "2026-12-31T00:00:00.000Z",
  );
  const freshDense = projectModelEvidence(
    dense,
    candidate,
    "coding",
    activeAsOf,
  );
  assert.ok(
    staleSparse.candidates[0]!.reviewedOutputQuality.confidencePpm <
      freshSparse.candidates[0]!.reviewedOutputQuality.confidencePpm,
  );
  assert.ok(
    freshSparse.candidates[0]!.reviewedOutputQuality.confidencePpm <
      freshDense.candidates[0]!.reviewedOutputQuality.confidencePpm,
  );
  assert.throws(
    () =>
      projectModelEvidence(
        sparse,
        candidate,
        "coding",
        "2025-12-31T00:00:00.000Z",
      ),
    /too far in the future/,
  );
});

test("conflicting evidence lowers confidence and supersession is atomic", () => {
  let state = emptyModelEvidenceState();
  const low = normalizeModelEvidence(reviewInput("same-source", 100_000));
  state = applyModelEvidenceRecord(state, low, 1);
  const high = normalizeModelEvidence({
    ...reviewInput("same-source", 900_000),
  });
  state = applyModelEvidenceSupersession(
    state,
    {
      schemaVersion: 1,
      evidenceId: low.evidenceId,
      replacement: high,
      reason: "corrected",
      supersededAt: "2026-01-02T00:00:00.000Z",
    },
    2,
  );
  assert.equal(state.supersededBy[low.evidenceId], high.evidenceId);
  assert.ok(state.records[high.evidenceId]);
  const corrected = projectModelEvidence(
    state,
    [
      {
        provider: "local",
        modelId: "model-q4",
        thinkingLevel: "medium",
        endpointId: "local_one",
      },
    ],
    "coding",
    activeAsOf,
  );
  assert.equal(
    corrected.candidates[0]?.reviewedOutputQuality.valuePpm,
    900_000,
  );

  let conflicting = add(state, reviewInput("opposite-source", 100_000), 3);
  const projection = projectModelEvidence(
    conflicting,
    [
      {
        provider: "local",
        modelId: "model-q4",
        thinkingLevel: "medium",
        endpointId: "local_one",
      },
    ],
    "coding",
    activeAsOf,
  );
  assert.equal(
    projection.candidates[0]?.reviewedOutputQuality.status,
    "conflicting",
  );
  assert.ok(
    projection.candidates[0]!.reviewedOutputQuality.confidencePpm <
      corrected.candidates[0]!.reviewedOutputQuality.confidencePpm,
  );
  conflicting = state;
  assert.equal(
    modelEvidenceStateDigest(conflicting),
    modelEvidenceStateDigest(state),
  );
});

test("compaction keeps a supersession chain closed and cannot resurrect old evidence", () => {
  let state = emptyModelEvidenceState();
  const target = normalizeModelEvidence({
    ...reviewInput("long-lived-correction", 100_000),
    expiresAt: "2026-04-01T00:00:00.000Z",
  });
  state = applyModelEvidenceRecord(state, target, 1);
  const replacement = normalizeModelEvidence({
    ...reviewInput("long-lived-correction", 900_000),
    expiresAt,
  });
  state = applyModelEvidenceSupersession(
    state,
    {
      schemaVersion: 1,
      evidenceId: target.evidenceId,
      replacement,
      reason: "corrected",
      supersededAt: "2026-01-02T00:00:00.000Z",
    },
    2,
  );
  const unrelated = normalizeModelEvidence(
    reviewInput("independently-expired", 500_000, "other_endpoint"),
  );
  state = applyModelEvidenceRecord(state, unrelated, 3);

  const plan = planModelEvidenceCompaction(state, compactAsOf, 3);
  assert.ok(plan);
  assert.deepEqual(plan!.evidenceIds, [unrelated.evidenceId]);
  const compacted = applyModelEvidenceCompaction(state, plan!);
  assert.ok(compacted.records[target.evidenceId]);
  assert.ok(compacted.records[replacement.evidenceId]);
  assert.equal(
    compacted.supersededBy[target.evidenceId],
    replacement.evidenceId,
  );
  const projection = projectModelEvidence(
    compacted,
    [
      {
        provider: "local",
        modelId: "model-q4",
        thinkingLevel: "medium",
        endpointId: "local_one",
      },
    ],
    "coding",
    compactAsOf,
  );
  assert.equal(
    projection.candidates[0]?.reviewedOutputQuality.status,
    "missing",
  );
});

test("compaction batches large expired sets and emits only aggregate deltas", () => {
  let state = emptyModelEvidenceState();
  const total = MODEL_EVIDENCE_POLICY.maxCompactionRecords + 1;
  for (let index = 0; index < total; index++)
    state = add(
      state,
      {
        schemaVersion: 1,
        evidenceKind: "score",
        sourceKind: "human",
        sourceName: "operator",
        sourceKey: `preference-${index}`,
        taskProfile: "coding",
        subject: {
          kind: "runtime",
          provider: "local",
          modelId: `model-${index}`,
          thinkingLevel: "medium",
          endpointId: "local_one",
        },
        sampleCount: 1,
        observedAt,
        expiresAt,
        dimension: "preference",
        valuePpm: 500_000,
        confidencePpm: 800_000,
      },
      index + 1,
    );
  const first = planModelEvidenceCompaction(state, compactAsOf, total);
  assert.ok(first);
  assert.equal(
    first!.evidenceIds.length,
    MODEL_EVIDENCE_POLICY.maxCompactionRecords,
  );
  assert.equal(
    first!.aggregates.length,
    MODEL_EVIDENCE_POLICY.maxCompactionRecords,
  );
  assert.ok(Buffer.byteLength(canonicalEvidenceJson(first), "utf8") < 900_000);
  const afterFirst = applyModelEvidenceCompaction(state, first!);
  assert.equal(Object.keys(afterFirst.records).length, 1);
  const second = planModelEvidenceCompaction(afterFirst, compactAsOf, total);
  assert.ok(second);
  assert.equal(second!.evidenceIds.length, 1);
  assert.equal(second!.aggregates.length, 1);
  const complete = applyModelEvidenceCompaction(afterFirst, second!);
  assert.equal(Object.keys(complete.records).length, 0);
  assert.equal(Object.keys(complete.aggregates).length, total);
});

test("same-log evidence compaction is deterministic and replay is byte-stable", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-evidence-"));
  const path = join(root, "events.jsonl");
  try {
    const actor = { principalId: createId("prn"), kind: "system" };
    const store = new EventStore(path, actor);
    await store.open();
    const first = normalizeModelEvidence(reviewInput("expired-1", 300_000));
    const second = normalizeModelEvidence(reviewInput("expired-2", 700_000));
    for (const record of [first, second])
      await store.append({
        type: "model.evidence_recorded",
        actor,
        payload: { record },
      });
    const prefix = await readFile(path, "utf8");
    const plan = planModelEvidenceCompaction(
      store.state.modelEvidence,
      compactAsOf,
      store.state.lastEventSeq,
    );
    assert.ok(plan);
    await store.append({
      type: "model.evidence_compacted",
      actor,
      payload: plan!,
    });
    const after = await readFile(path, "utf8");
    assert.ok(after.startsWith(prefix));
    assert.equal(
      Object.keys(store.state.modelEvidence?.records ?? {}).length,
      0,
    );
    assert.equal(
      Object.keys(store.state.modelEvidence?.aggregates ?? {}).length,
      1,
    );

    const replay = new EventStore(path, actor);
    await replay.open();
    assert.equal(replay.readOnly, false);
    assert.equal(
      canonicalJson(replay.state.modelEvidence),
      canonicalJson(store.state.modelEvidence),
    );
    assert.equal(
      modelEvidenceStateDigest(replay.state.modelEvidence),
      modelEvidenceStateDigest(store.state.modelEvidence),
    );
    assert.deepEqual(
      planModelEvidenceCompaction(
        replay.state.modelEvidence,
        compactAsOf,
        replay.state.lastEventSeq,
      ),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("event and endpoint mapping validation reject malformed rating state", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-evidence-invalid-"));
  try {
    const actor = { principalId: createId("prn"), kind: "system" };
    const store = new EventStore(join(root, "events.jsonl"), actor);
    await store.open();
    const record = normalizeModelEvidence(reviewInput("strict", 500_000));
    await assert.rejects(
      store.append({
        type: "model.evidence_recorded",
        actor,
        payload: { record: { ...record, valuePpm: 500_001 } },
      }),
      /Event payload is invalid/,
    );
    assert.equal(store.state.lastEventSeq, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const accepted = validateEndpointPolicyConfig(
    { local_one: { maxConcurrentAgents: 1 } },
    {
      schemaVersion: 1,
      mappings: [
        {
          provider: "local",
          modelId: "model-q4",
          endpointId: "local_one",
          canonicalModelId: "vendor/model",
          quantization: "q4_k_m",
        },
      ],
    },
  );
  assert.equal(
    accepted.modelIntelligence?.mappings[0]?.canonicalModelId,
    "vendor/model",
  );
  assert.throws(
    () =>
      validateEndpointPolicyConfig(
        { local_one: { maxConcurrentAgents: 1 } },
        {
          schemaVersion: 1,
          mappings: [
            {
              provider: "local",
              endpointId: "local_one",
              canonicalModelId: "vendor/model",
            },
          ],
        },
      ),
    /invalid/,
  );
});
