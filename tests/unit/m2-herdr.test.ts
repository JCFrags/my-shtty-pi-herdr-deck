import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectCapabilities } from "../../src/herdr/capabilities.js";
import { herdrName, branchSlug, tokenDigest } from "../../src/herdr/names.js";
import { normalizeSnapshot } from "../../src/herdr/normalizers.js";
import { parsePorcelainV2 } from "../../src/git/porcelain.js";
import {
  HerdrProcessError,
  HerdrProcessRunner,
} from "../../src/herdr/runner.js";

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

test("M2 process runner uses argv-only execution and a minimal environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-runner-"));
  const script = join(root, "argv-env.mjs");
  const capture = join(root, "capture.json");
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs"; writeFileSync(process.env.HERDR_CONFIG_PATH, JSON.stringify({ argv: process.argv.slice(2), secret: process.env.TEST_SECRET ?? null })); process.stdout.write("ok");`,
  );
  await chmod(script, 0o755);
  const oldCapture = process.env.HERDR_CONFIG_PATH;
  const oldSecret = process.env.TEST_SECRET;
  process.env.HERDR_CONFIG_PATH = capture;
  process.env.TEST_SECRET = "must-not-cross";
  try {
    const result = await new HerdrProcessRunner({
      binary: process.execPath,
    }).run([script, "safe arg", "$(not-shell-expanded)"]);
    assert.equal(result.stdout, "ok");
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), {
      argv: ["safe arg", "$(not-shell-expanded)"],
      secret: null,
    });
  } finally {
    if (oldCapture === undefined) delete process.env.HERDR_CONFIG_PATH;
    else process.env.HERDR_CONFIG_PATH = oldCapture;
    if (oldSecret === undefined) delete process.env.TEST_SECRET;
    else process.env.TEST_SECRET = oldSecret;
  }
});

test("M2 process runner classifies missing executable and malformed JSON deterministically", async () => {
  await assert.rejects(
    () =>
      new HerdrProcessRunner({
        binary: "/no/such/herdr",
        timeoutMs: 3_001,
      }).run([]),
    (error: unknown) =>
      error instanceof HerdrProcessError && error.code === "HERDR_UNAVAILABLE",
  );
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-json-"));
  const script = join(root, "bad-json.mjs");
  await writeFile(script, "process.stdout.write('not-json');");
  const runner = new HerdrProcessRunner({
    binary: process.execPath,
    timeoutMs: 3_001,
  });
  await assert.rejects(
    () => runner.json([script]),
    (error: unknown) =>
      error instanceof HerdrProcessError &&
      error.code === "HERDR_INVALID_OUTPUT",
  );
});
