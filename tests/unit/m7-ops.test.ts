import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../../src/ops/config.js";
import { planRetention } from "../../src/ops/retention.js";
import { appendSafeLog, redact } from "../../src/ops/logging.js";

test("M7 config validation rejects unknown and secret fields", () => {
  assert.equal(validateConfig({ version: 1 }).version, 1);
  assert.throws(() => validateConfig({ version: 1, command: "rm" }), /Unknown/);
  assert.throws(
    () => validateConfig({ version: 1, api_key: "sk-test" }),
    /Unknown|forbidden/,
  );
});

test("M7 log output redacts secret-like values", async () => {
  assert.equal(redact("token=abc Bearer xyz"), "[REDACTED] [REDACTED]");
  const root = await mkdtemp(join(tmpdir(), "orch-m7-log-"));
  const path = join(root, "broker.jsonl");
  await appendSafeLog(path, {
    timestamp: new Date().toISOString(),
    level: "info",
    event: "test",
    data: { value: "sk-secret" },
  });
  const { readFile } = await import("node:fs/promises");
  assert.match(await readFile(path, "utf8"), /REDACTED/);
});

test("M7 retention plan never proposes canonical state or secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-m7-"));
  await writeFile(join(root, "broker-old-20200101.jsonl"), "diagnostic\n", {
    mode: 0o600,
  });
  await utimes(join(root, "broker-old-20200101.jsonl"), 1, 1);
  await writeFile(join(root, "x.events.jsonl"), "", { mode: 0o600 });
  const plan = await planRetention(root, Date.now(), 1);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.candidates.length, 1);
  assert.ok(plan.retained.includes("x.events.jsonl"));
});
