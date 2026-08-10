import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyRecovery,
  confirmRecoveryEvidence,
  digestExportedFile,
  exportBeforeRepair,
  planRecovery,
} from "../../src/ops/recovery.js";
import type { ResolvedPaths } from "../../src/shared/paths.js";

function paths(root: string): ResolvedPaths {
  return {
    root,
    runtime: root,
    events: join(root, "state.events.jsonl"),
    snapshot: join(root, "state.snapshot.json"),
    lock: join(root, "state.lock"),
    socket: join(root, "state.sock"),
    secret: join(root, "state.secret"),
  };
}

test("recovery classification and plan stay read-only", () => {
  const verification = {
    valid: false,
    lastSeq: 12,
    lastHash: "a".repeat(64),
    readOnly: true,
    corruption: "invalid suffix",
  };

  assert.equal(classifyRecovery(verification), "read_only_recovery");
  assert.deepEqual(
    planRecovery({
      verification,
      expectedSeq: verification.lastSeq,
      expectedHash: verification.lastHash,
    }),
    {
      class: "read_only_recovery",
      verified: true,
      exportRequired: true,
      mutation: "none",
      reason: "invalid suffix",
      confirmed: { sequence: true, digest: true },
    },
  );
  assert.equal(
    confirmRecoveryEvidence({ verification, expectedSeq: 13 }),
    false,
  );
  assert.equal(
    confirmRecoveryEvidence({ verification, expectedHash: "b".repeat(64) }),
    false,
  );
  assert.equal(
    planRecovery({ verification, expectedSeq: 13 }).mutation,
    "none",
  );
});

test("export-before-repair copies only verified state and supports digest checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-m7-recovery-"));
  const state = paths(root);
  await writeFile(state.events, "event\n", { mode: 0o600 });
  await writeFile(state.snapshot, "snapshot\n", { mode: 0o600 });
  const output = join(root, "export");
  const evidence = {
    verification: {
      valid: false,
      lastSeq: 3,
      lastHash: "c".repeat(64),
      readOnly: true,
      corruption: "checksum mismatch",
    },
    expectedSeq: 3,
    expectedHash: "c".repeat(64),
  };

  const exported = await exportBeforeRepair(state, output, evidence);
  assert.equal(exported.output, output);
  assert.deepEqual(exported.source, evidence.verification);
  assert.equal(exported.manifest[0], "recovery-class:read_only_recovery");
  assert.equal(exported.manifest[1], "sequence:3");
  assert.equal(exported.manifest[2], `digest:${"c".repeat(64)}`);
  assert.match(await readFile(join(output, "MANIFEST.txt"), "utf8"), /sha256:/);
  assert.equal(
    await digestExportedFile(
      output,
      "state.events.jsonl",
      "d8073d788ee641f2f54333c3246b08951f721c3f8090cdcb1f0fa9e80eaef504",
    ),
    true,
  );
  assert.equal(
    await digestExportedFile(output, "state.events.jsonl", "a".repeat(64)),
    false,
  );
  assert.equal(
    await digestExportedFile(output, "../state.events.jsonl", "a".repeat(64)),
    false,
  );
  await assert.rejects(
    exportBeforeRepair(state, join(root, "healthy-export"), {
      verification: {
        valid: true,
        lastSeq: 3,
        lastHash: "d".repeat(64),
        readOnly: false,
      },
    }),
    /required only for recovery/,
  );
});
