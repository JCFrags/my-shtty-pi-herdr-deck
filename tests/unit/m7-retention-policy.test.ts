import test from "node:test";
import assert from "node:assert/strict";
import {
  planDeletion,
  planExport,
  planRetention,
  type RetentionResource,
} from "../../src/ops/retention-policy.js";

const digest = "a".repeat(64);
const resource = (
  overrides: Partial<RetentionResource> = {},
): RetentionResource => ({
  id: "artifact-1",
  path: "artifacts/one.tgz",
  kind: "artifact",
  bytes: 10,
  modifiedAt: 90,
  status: "clean",
  deletionEligible: true,
  sha256: digest,
  ...overrides,
});

test("retention is bounded, deterministic, and dry-run only", () => {
  const plan = planRetention(
    [
      resource(),
      resource({
        id: "artifact-2",
        path: "artifacts/two.tgz",
        bytes: 20,
        modifiedAt: 80,
      }),
      resource({
        id: "log-1",
        path: "logs/one.jsonl",
        kind: "log",
        bytes: 5,
        modifiedAt: 99,
      }),
    ],
    {
      now: 100,
      maxAgeMs: { artifact: 1_000, log: 1_000 },
      maxBytes: { artifact: 20, log: 100 },
      maxItems: 10,
    },
  );
  assert.equal(plan.dryRun, true);
  assert.deepEqual(
    plan.candidates.map((candidate) => candidate.path),
    ["artifacts/two.tgz"],
  );
  assert.deepEqual(plan.retained, ["artifacts/one.tgz", "logs/one.jsonl"]);
  assert.deepEqual(planDeletion(plan), {
    dryRun: true,
    paths: ["artifacts/two.tgz"],
    refusals: [],
  });
});

test("unsafe and unknown resources are refused and retained", () => {
  const plan = planRetention(
    [
      resource({ id: "dirty", path: "dirty", status: "dirty" }),
      resource({ id: "live", path: "live", status: "live" }),
      resource({ id: "unknown", path: "unknown", status: "unknown" }),
      resource({ id: "kind", path: "kind", kind: "cache" }),
    ],
    {
      now: 100,
      maxAgeMs: { artifact: 0, log: 0 },
      maxBytes: { artifact: 0, log: 0 },
      maxItems: 0,
    },
  );
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.retained.sort(), ["dirty", "kind", "live", "unknown"]);
  assert.deepEqual(
    plan.refusals.map((refusal) => refusal.reason),
    [
      "dirty-resource",
      "unknown-kind",
      "live-resource",
      "unknown-resource",
    ].sort(),
  );
});

test("export produces a sorted digest manifest and refuses unsafe entries", () => {
  const plan = planExport([
    resource({ id: "b", path: "b", sha256: digest }),
    resource({ id: "a", path: "a", sha256: digest, bytes: 3 }),
    resource({ id: "live", path: "live", status: "live" }),
    resource({ id: "bad", path: "bad", sha256: "not-a-digest" }),
  ]);
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.manifest, [
    `a\t3\tsha256:${digest}`,
    `b\t10\tsha256:${digest}`,
  ]);
  assert.deepEqual(
    plan.refusals.map((refusal) => refusal.path),
    ["bad", "live"],
  );
});

test("invalid retention limits are rejected", () => {
  assert.throws(
    () =>
      planRetention([], {
        now: 0,
        maxAgeMs: { artifact: -1, log: 0 },
        maxBytes: { artifact: 0, log: 0 },
        maxItems: 0,
      }),
    /non-negative safe integers/,
  );
});
