#!/usr/bin/env node
/** M7 local operations harness. It is dry-run by default and never removes data. */
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
const dryRun = true;
if (process.argv.includes("--execute")) {
  console.error("Execution is disabled. Use an injected fake runner in tests.");
  process.exit(2);
}
function record(name, value) {
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  writeFileSync(join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
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
    "--execute is rejected; use an injected fake runner in tests.",
  ],
};
if (!["plan", "deploy", "canary", "soak", "rollback"].includes(command)) {
  console.error(
    "Usage: node scripts/m7-ops.mjs plan|deploy|canary|soak|rollback [--execute]",
  );
  process.exit(2);
}
record(`${command}-plan.json`, plan);
console.log(JSON.stringify(plan));
process.exit(0);
