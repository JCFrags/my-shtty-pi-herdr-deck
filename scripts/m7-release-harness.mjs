#!/usr/bin/env node
/**
 * M7 deployment rehearsal harness.
 *
 * This file creates finite, repeatable dry-run plans. It never executes a
 * deployment, canary, soak, rollback, publication, tag, or deletion command.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMANDS = new Set(["plan", "deploy", "canary", "soak", "rollback"]);
const MAX_ITERATIONS = 1000;
const SHA = /^[0-9a-f]{40}$/;
const PRIVATE_PATH =
  /(?:^|\/)(?:\.git|\.agents|evidence|node_modules|\.env(?:\.|$))(?:\/|$)/;

function valueOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function readCommit(ref, fallbackToHead = false) {
  const configured = valueOrNull(ref);
  if (configured) return configured;
  if (!fallbackToHead) return null;
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function captureCommitPair({ candidateCommit, rollbackCommit } = {}) {
  const candidate = readCommit(candidateCommit, true);
  const rollback = readCommit(rollbackCommit, false);
  return {
    candidate,
    rollback,
    exact: SHA.test(candidate ?? "") && SHA.test(rollback ?? ""),
  };
}

export function checkPackagePrivacy(packagePath = join(ROOT, "package.json")) {
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const files = Array.isArray(packageJson.files) ? packageJson.files : [];
  const privateFiles = files.filter((entry) => PRIVATE_PATH.test(entry));
  const serialized = JSON.stringify(packageJson);
  const secretLike =
    /(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]/i.test(serialized);
  return {
    ok: privateFiles.length === 0 && !secretLike,
    packagePrivate: packageJson.private === true,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    privateFiles,
    secretLike,
  };
}

function integerInRange(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_ITERATIONS
    ? parsed
    : null;
}

export function createSoakMetadata({ iterations, seed, commitPair } = {}) {
  const count = integerInRange(iterations, 10);
  const soakSeed = valueOrNull(seed) ?? "m7-release-soak-v1";
  const metadata = {
    format: "m7-release-soak/v1",
    seed: soakSeed,
    iterations: count,
    stopOnFailure: true,
    liveElapsedTimeClaim: false,
    commitPair,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(metadata))
    .digest("hex");
  return { ...metadata, planId: `m7-soak-${digest.slice(0, 16)}` };
}

function planFor(command, commitPair, packagePrivacy, soak) {
  const actions = {
    preflight: ["npm", "run", "validate"],
    packageSmoke: ["npm", "pack", "--dry-run", "--json"],
    canary: [
      "fake-validation",
      "package-smoke",
      "disposable-fake-stack",
      "selected-low-risk-task",
    ],
    rollback: [
      "restore-candidate-compatible-with-state",
      "doctor",
      "status",
      "reconcile",
    ],
  };
  return {
    format: "m7-release-rehearsal/v1",
    command,
    dryRun: true,
    root: ROOT,
    commitPair,
    packagePrivacy,
    soak,
    actions,
    safety: {
      executesCommands: false,
      liveHerdrOrPi: false,
      publication: false,
      tags: false,
      deletion: false,
    },
    finite: {
      maxSoakIterations: MAX_ITERATIONS,
      canaryStages: actions.canary.length,
      rollbackStages: actions.rollback.length,
    },
  };
}

export function createPlan({
  command = "plan",
  candidateCommit,
  rollbackCommit,
  iterations,
  seed,
  packagePath,
} = {}) {
  if (!COMMANDS.has(command))
    throw new Error(`Unsupported command: ${command}`);
  const commitPair = captureCommitPair({ candidateCommit, rollbackCommit });
  const packagePrivacy = checkPackagePrivacy(packagePath);
  const soak = createSoakMetadata({
    iterations: integerInRange(
      iterations,
      process.env.PI_HERDR_ORCH_SOAK_ITERATIONS ?? 10,
    ),
    seed: seed ?? process.env.PI_HERDR_ORCH_SOAK_SEED,
    commitPair,
  });
  return planFor(command, commitPair, packagePrivacy, soak);
}

function usage() {
  return "Usage: node scripts/m7-release-harness.mjs plan|deploy|canary|soak|rollback [--candidate COMMIT] [--rollback COMMIT] [--iterations N] [--seed VALUE]";
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const command = argv[0] ?? "plan";
  if (!COMMANDS.has(command) || argv.includes("--execute")) {
    console.error(usage());
    return 2;
  }
  const option = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const iterations =
    option("--iterations") ?? env.PI_HERDR_ORCH_SOAK_ITERATIONS;
  const plan = createPlan({
    command,
    candidateCommit:
      option("--candidate") ?? env.PI_HERDR_ORCH_CANDIDATE_COMMIT,
    rollbackCommit: option("--rollback") ?? env.PI_HERDR_ORCH_ROLLBACK_COMMIT,
    iterations,
    seed: option("--seed") ?? env.PI_HERDR_ORCH_SOAK_SEED,
  });
  if (
    !plan.commitPair.exact ||
    !plan.packagePrivacy.ok ||
    plan.soak.iterations === null
  ) {
    console.error(JSON.stringify(plan));
    return 1;
  }
  console.log(JSON.stringify(plan));
  return 0;
}

if (
  isAbsolute(process.argv[1] ?? "") &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main();
}
