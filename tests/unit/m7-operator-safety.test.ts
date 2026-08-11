import test from "node:test";
import assert from "node:assert/strict";
import {
  planGarbageCollection,
  planUninstall,
  projectSafeMetadata,
  stableJson,
} from "../../src/ops/operator-safety.js";

test("safe metadata excludes secrets, environment, and prompts", () => {
  const projected = projectSafeMetadata({
    role: "reviewer",
    task: { id: "task-1", state: "running", prompt: "private objective" },
    token: "do-not-copy",
    env: { HOME: "/private" },
    nested: { count: 2 },
  });
  assert.deepEqual(projected, {
    nested: { count: 2 },
    role: "reviewer",
    task: { id: "task-1", state: "running" },
  });
  assert.equal(JSON.stringify(projected).includes("private"), false);
});

test("stable JSON sorts keys and produces no terminal formatting", () => {
  assert.equal(
    stableJson({ z: 1, a: { y: true, b: "x" } }),
    '{"a":{"b":"x","y":true},"z":1}',
  );
});

test("GC is a dry-run and retains dirty, unknown, and live resources", () => {
  const plan = planGarbageCollection([
    {
      id: "dirty-worktree",
      kind: "worktree",
      ageMs: 100,
      retentionMs: 1,
      state: "dirty",
    },
    {
      id: "live-log",
      kind: "log",
      ageMs: 100,
      retentionMs: 1,
      state: "live",
    },
    {
      id: "old-log",
      kind: "log",
      ageMs: 100,
      retentionMs: 1,
      state: "clean",
    },
    {
      id: "verified-old-snapshot",
      kind: "snapshot",
      ageMs: 100,
      retentionMs: 1,
      state: "clean",
      superseded: true,
      verified: true,
    },
  ]);
  assert.equal(plan.dryRun, true);
  assert.deepEqual(
    plan.candidates.map(({ id, reason }) => ({ id, reason })),
    [
      { id: "old-log", reason: "expired" },
      { id: "verified-old-snapshot", reason: "superseded" },
    ],
  );
  assert.deepEqual(
    plan.retained.map(({ id }) => id),
    ["dirty-worktree", "live-log"],
  );
});

test("uninstall plan preserves state and worktrees without actions", () => {
  const plan = planUninstall([
    { id: "worktree-1", kind: "worktrees" },
    { id: "state-1", kind: "state" },
  ]);
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.preserve, ["state", "results", "logs", "worktrees"]);
  assert.deepEqual(
    plan.resources.map(({ id }) => id),
    ["state-1", "worktree-1"],
  );
  assert.deepEqual(plan.destructiveActions, []);
  assert.deepEqual(plan.liveActions, []);
});
