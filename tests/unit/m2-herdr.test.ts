import assert from "node:assert/strict";
import { test } from "node:test";
import { projectCapabilities } from "../../src/herdr/capabilities.js";
import { herdrName, branchSlug, tokenDigest } from "../../src/herdr/names.js";
import { normalizeSnapshot } from "../../src/herdr/normalizers.js";
import { parsePorcelainV2 } from "../../src/git/porcelain.js";

test("M2 projects mandatory and optional Herdr capabilities", () => {
  const caps = projectCapabilities({
    methods: ["session.snapshot", "agent.start", "agent.list", "agent.focus"],
  });
  assert.equal(caps.supports("agent.start"), true);
  assert.equal(caps.mandatory["worktree.create"], false);
  assert.equal(caps.optional["agent.interrupt"], false);
  assert.match(caps.schemaHash, /^[0-9a-f]{64}$/);
});
test("M2 names are bounded, deterministic, and collision safe", () => {
  const first = herdrName("Code Review", "agt-test", []);
  assert.match(first, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.notEqual(herdrName("Code Review", "agt-test", [first]), first);
  assert.equal(branchSlug("Review / unsafe branch"), "review-unsafe-branch");
  assert.match(tokenDigest("test"), /^[0-9a-f]{64}$/);
});
test("M2 normalizers ignore additive fields", () => {
  const snapshot = normalizeSnapshot({
    sequence: 4,
    workspaces: [{ workspace_id: "w1", future: true }],
    panes: [{ pane_id: "p1", terminal_id: "t1", extra: { ok: true } }],
    future: "ignored",
  });
  assert.equal(snapshot.workspaces[0]?.id, "w1");
  assert.equal(snapshot.panes[0]?.terminalId, "t1");
});
test("M2 parses NUL-delimited porcelain records without shell parsing", () => {
  const entries = parsePorcelainV2(
    "1 .M N... 100644 100644 100644 a b c file with spaces.txt\0",
  );
  assert.equal(entries[0]?.path, "file with spaces.txt");
  assert.equal(entries[0]?.worktree, "M");
});
