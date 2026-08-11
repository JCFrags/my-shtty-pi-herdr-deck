import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const bin = join(root, "bin", "pi-herdr-orchestrator");
const commit = "0e43cc217756909482abb5cf722060c38d33e5fe";
const rollback = "1e43cc217756909482abb5cf722060c38d33d3aa";
const digest = "a".repeat(64);

function run(
  stateRoot: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_HERDR_ORCH_STATE_ROOT: stateRoot,
  };
  delete env.HERDR_SOCKET_PATH;
  Object.assign(env, environment);
  return spawnSync(bin, args, {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

test("offline operations ignore Herdr identity and do not initialize session paths", async (t) => {
  const rootPath = await mkdtemp(join(tmpdir(), "orch-m7-cli-offline-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const firstState = join(rootPath, "first-state");
  const secondState = join(rootPath, "second-state");
  const args = [
    "ops",
    "plan",
    "--action",
    "restart",
    "--commit",
    commit,
    "--rollback",
    rollback,
    "--evidence",
    `validate:${digest}`,
  ];
  const clean = run(firstState, args);
  const hostile = run(secondState, args, {
    HERDR_SOCKET_PATH: "relative-attacker-selected.sock",
    PI_HERDR_ORCH_RUNTIME_ROOT: join(rootPath, "r".repeat(200)),
  });
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(hostile.status, 0, hostile.stderr);
  assert.deepEqual(JSON.parse(hostile.stdout), JSON.parse(clean.stdout));
  await assert.rejects(lstat(firstState), { code: "ENOENT" });
  await assert.rejects(lstat(secondState), { code: "ENOENT" });
});

test("CLI plan and verify use separate strict expected/current evidence", async (t) => {
  const rootPath = await mkdtemp(join(tmpdir(), "orch-m7-cli-ops-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const stateRoot = join(rootPath, "state");
  const planned = run(stateRoot, [
    "ops",
    "plan",
    "--action",
    "restart",
    "--commit",
    commit,
    "--rollback",
    rollback,
    "--evidence",
    `validate:${digest}`,
    "--resource",
    "broker:broker-v1:clean",
  ]);
  assert.equal(planned.status, 0, planned.stderr);
  const planPath = join(rootPath, "plan.json");
  const currentPath = join(rootPath, "current.json");
  await writeFile(planPath, planned.stdout, { mode: 0o600 });
  const current = {
    format: "pi-herdr-operator-current/v1",
    commit,
    resources: [{ id: "broker", identity: "broker-v1", state: "clean" }],
    preflight: [{ name: "validate", digest }],
  };
  await writeFile(currentPath, JSON.stringify(current), { mode: 0o600 });
  const verified = run(stateRoot, [
    "ops",
    "verify",
    "--plan",
    planPath,
    "--current",
    currentPath,
  ]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).ok, true);
  await writeFile(
    currentPath,
    JSON.stringify({
      ...current,
      resources: [{ id: "broker", identity: "replacement", state: "replaced" }],
    }),
    { mode: 0o600 },
  );
  const stale = run(stateRoot, [
    "ops",
    "verify",
    "--plan",
    planPath,
    "--current",
    currentPath,
  ]);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /resource identity changed/);
});

test("CLI rejects malformed, duplicate, extra, and stale current evidence", async (t) => {
  const rootPath = await mkdtemp(join(tmpdir(), "orch-m7-cli-invalid-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const stateRoot = join(rootPath, "state");
  const planResult = run(stateRoot, [
    "ops",
    "plan",
    "--action",
    "restart",
    "--commit",
    commit,
    "--rollback",
    rollback,
    "--evidence",
    `validate:${digest}`,
  ]);
  const planPath = join(rootPath, "plan.json");
  const currentPath = join(rootPath, "current.json");
  await writeFile(planPath, planResult.stdout, { mode: 0o600 });
  await writeFile(
    currentPath,
    JSON.stringify({
      format: "pi-herdr-operator-current/v1",
      commit,
      resources: [],
      preflight: [
        { name: "validate", digest: "b".repeat(64) },
        { name: "extra", digest },
      ],
    }),
    { mode: 0o600 },
  );
  const result = run(stateRoot, [
    "ops",
    "verify",
    "--plan",
    planPath,
    "--current",
    currentPath,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /preflight evidence/);
  await writeFile(planPath, "{}", { mode: 0o600 });
  const malformed = run(stateRoot, [
    "ops",
    "verify",
    "--plan",
    planPath,
    "--current",
    currentPath,
  ]);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Invalid operation plan/);
});
