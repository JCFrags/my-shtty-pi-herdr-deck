import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  modelEvidenceStateDigest,
  normalizeModelEvidence,
  projectModelEvidence,
} from "../../src/model-intelligence/model-evidence.js";
import { createId } from "../../src/shared/ids.js";
import { canonicalJson } from "../../src/shared/canonical-json.js";
import { EventStore } from "../../src/state/event-store.js";
import { SnapshotStore } from "../../src/state/snapshot-store.js";

const actor = { principalId: createId("prn"), kind: "system" };
const snapshotKey = "snapshot-key-material-that-is-long-enough";

function preference(sourceKey: string, valuePpm: number) {
  return normalizeModelEvidence({
    schemaVersion: 1,
    evidenceKind: "score",
    sourceKind: "human",
    sourceName: "operator",
    sourceKey,
    taskProfile: "coding",
    subject: {
      kind: "runtime",
      provider: "provider-a",
      modelId: "model-a",
      thinkingLevel: "high",
    },
    sampleCount: 1,
    observedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    dimension: "preference",
    valuePpm,
    confidencePpm: 800_000,
  });
}

test("authenticated snapshot plus suffix rebuilds the same model evidence projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-evidence-snapshot-"));
  const eventsPath = join(root, "events.jsonl");
  const snapshotPath = join(root, "snapshot.json");
  try {
    const store = new EventStore(eventsPath, actor);
    const snapshots = new SnapshotStore(snapshotPath);
    await store.open();
    await store.append({
      type: "model.evidence_recorded",
      actor,
      payload: { record: preference("preference-1", 600_000) },
    });
    await snapshots.write(store.state, snapshotKey);
    await store.append({
      type: "model.evidence_recorded",
      actor,
      payload: { record: preference("preference-2", 700_000) },
    });

    const snapshot = await snapshots.read(snapshotKey);
    assert.ok(snapshot);
    const replay = new EventStore(eventsPath, actor);
    await replay.open(snapshot);
    assert.equal(replay.readOnly, false);
    assert.equal(replay.replayReductionCount, 1);
    assert.equal(
      canonicalJson(replay.state.modelEvidence),
      canonicalJson(store.state.modelEvidence),
    );
    assert.equal(
      modelEvidenceStateDigest(replay.state.modelEvidence),
      modelEvidenceStateDigest(store.state.modelEvidence),
    );
    const candidates = [
      {
        provider: "provider-a",
        modelId: "model-a",
        thinkingLevel: "high",
      },
    ];
    const originalProjection = projectModelEvidence(
      store.state.modelEvidence,
      candidates,
      "coding",
      "2026-01-08T00:00:00.000Z",
    );
    const replayProjection = projectModelEvidence(
      replay.state.modelEvidence,
      candidates,
      "coding",
      "2026-01-08T00:00:00.000Z",
    );
    assert.deepEqual(replayProjection, originalProjection);
    assert.equal(replayProjection.candidates[0]?.preference.status, "observed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
