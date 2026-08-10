#!/usr/bin/env node
/** M7 local operations harness. It is dry-run by default and never removes data. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(
  process.env.PI_HERDR_ORCH_STATE_ROOT ??
    join(process.env.HOME ?? ".", ".pi/agent/pi-herdr-orchestrator"),
);
const evidence = resolve(
  process.env.PI_HERDR_ORCH_OPS_EVIDENCE ?? join(root, "ops-evidence"),
);
const command = process.argv[2] ?? "plan";
const dryRun = !process.argv.includes("--execute");
function record(name, value) {
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  writeFileSync(join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}
function run(label, argv) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 120000,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    label,
    argv,
    status: result.status,
    ok: result.status === 0,
    stdoutDigest: result.stdout ? result.stdout.length : 0,
    stderrDigest: result.stderr ? result.stderr.length : 0,
  };
}
const plan = {
  command,
  dryRun,
  stateRoot: root,
  evidenceRoot: evidence,
  actions: {
    preflight: ["npm", "run", "validate"],
    doctor: ["pi-herdr-orchestrator", "doctor", "--json"],
    verify: ["pi-herdr-orchestrator", "events", "verify", "--json"],
    rollback:
      "Restore the recorded package and compatible state generation. Never run older code against newer state.",
  },
  safety: [
    "No live Herdr/Pi action is issued by this harness.",
    "No publication, tag, or deletion is performed.",
    "--execute is reserved for a separately approved operator run.",
  ],
};
if (!["plan", "deploy", "canary", "soak", "rollback"].includes(command)) {
  console.error(
    "Usage: node scripts/m7-ops.mjs plan|deploy|canary|soak|rollback [--execute]",
  );
  process.exit(2);
}
if (command === "plan" || dryRun) {
  record(`${command}-plan.json`, plan);
  console.log(JSON.stringify(plan));
  process.exit(0);
}
const results = [];
if (command === "deploy")
  results.push(run("validate", ["npm", "run", "validate"]));
if (command === "canary")
  results.push(run("focused", ["npm", "run", "test:unit"]));
if (command === "soak") {
  const iterations = Math.min(
    Number(process.env.PI_HERDR_ORCH_SOAK_ITERATIONS ?? 10),
    1000,
  );
  for (let i = 0; i < iterations; i++)
    results.push(run(`iteration-${i + 1}`, ["npm", "run", "test:integration"]));
}
if (command === "rollback")
  results.push(run("rollback-check", ["npm", "run", "typecheck"]));
record(`${command}-result.json`, { ...plan, results });
console.log(JSON.stringify({ ...plan, results }));
process.exit(results.every((result) => result.ok) ? 0 : 1);
