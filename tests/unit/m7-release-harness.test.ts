import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const script = join(process.cwd(), "scripts/m7-release-harness.mjs");
const candidate = "0123456789abcdef0123456789abcdef01234567";
const rollback = "fedcba9876543210fedcba9876543210fedcba98";

function run(command: string, extra: string[] = []) {
  return spawnSync(process.execPath, [script, command, ...extra], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PI_HERDR_ORCH_CANDIDATE_COMMIT: candidate,
      PI_HERDR_ORCH_ROLLBACK_COMMIT: rollback,
      PI_HERDR_ORCH_SOAK_ITERATIONS: "4",
      PI_HERDR_ORCH_SOAK_SEED: "test-seed",
    },
  });
}

test("release commands produce finite dry-run plans", () => {
  for (const command of ["plan", "deploy", "canary", "soak", "rollback"]) {
    const result = run(command);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.safety.executesCommands, false);
    assert.equal(plan.commitPair.exact, true);
    assert.equal(plan.soak.iterations, 4);
  }
});

test("the exact candidate and rollback pair is captured", () => {
  const plan = JSON.parse(run("plan").stdout);
  assert.deepEqual(plan.commitPair, {
    candidate,
    rollback,
    exact: true,
  });
});

test("soak metadata is repeatable for the same inputs", () => {
  const first = JSON.parse(run("soak").stdout).soak;
  const second = JSON.parse(run("soak").stdout).soak;
  assert.deepEqual(first, second);
  assert.match(first.planId, /^m7-soak-[0-9a-f]{16}$/);
});

test("package privacy check rejects private package paths and secret-like fields", () => {
  const result = run("plan", [
    "--candidate",
    candidate,
    "--rollback",
    rollback,
  ]);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.packagePrivacy.ok, true);
  assert.deepEqual(plan.packagePrivacy.privateFiles, []);
  assert.equal(plan.packagePrivacy.secretLike, false);
});

test("execute mode is rejected", () => {
  const result = run("deploy", ["--execute"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

test("missing rollback commit fails closed", () => {
  const result = spawnSync(process.execPath, [script, "rollback"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PI_HERDR_ORCH_CANDIDATE_COMMIT: candidate,
      PI_HERDR_ORCH_ROLLBACK_COMMIT: "",
    },
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).commitPair.exact, false);
});
