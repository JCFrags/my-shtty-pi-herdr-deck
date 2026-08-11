import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  resolveIsolation,
  resolveWorkflowIsolation,
} from "../../src/broker/isolation-policy.js";

test("isolation policy projection matches shipped profile JSON", async () => {
  for (const id of [
    "implementer",
    "planner",
    "reviewer",
    "scout",
    "test-runner",
  ]) {
    const profile = JSON.parse(
      await readFile(
        new URL(`../../profiles/${id}.json`, import.meta.url),
        "utf8",
      ),
    ) as {
      id: string;
      isolation: { mode: string; allowSharedOverride: boolean };
    };
    assert.equal(profile.id, id);
    assert.equal(resolveIsolation(id, undefined), profile.isolation.mode);
    assert.equal(profile.isolation.allowSharedOverride, false);
  }
});

test("isolation policy uses shipped profile defaults and fails closed", () => {
  assert.equal(resolveIsolation("implementer", undefined), "worktree");
  assert.equal(
    resolveIsolation("reviewer", "profile-default"),
    "shared-readonly",
  );
  assert.equal(resolveIsolation("reviewer", "worktree"), "worktree");
  assert.equal(
    resolveWorkflowIsolation("reviewer", "reuse-worktree"),
    "shared-readonly",
  );
  assert.equal(
    resolveWorkflowIsolation("implementer", "reuse-worktree"),
    "worktree",
  );
  assert.throws(
    () => resolveIsolation("implementer", "shared-readonly"),
    /shared-readonly/,
  );
  assert.throws(
    () => resolveIsolation("unknown", undefined),
    /shipped profile/,
  );
  assert.throws(
    () => resolveIsolation("reviewer", "reuse-worktree"),
    /not supported/,
  );
});
