import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOperationPlan,
  createOperationPlan,
  createRollbackRecord,
  digestEvidence,
  loadCurrentEvidence,
  loadOperationPlan,
  verifyOperationPlan,
} from "../../src/ops/operator-actions.js";

const commit = "0e43cc217756909482abb5cf722060c38d33e5fe";
const rollback = "1e43cc217756909482abb5cf722060c38d33d3aa";
const resource = {
  id: "broker",
  identity: "broker-v1",
  state: "clean" as const,
};

function plan() {
  return createOperationPlan({
    action: "restart",
    expectedCommit: commit,
    expectedResources: [resource],
    preflight: [{ name: "validate", digest: digestEvidence("validate-pass") }],
    timeoutMs: 5_000,
    rollback: createRollbackRecord({
      candidateCommit: commit,
      rollbackCommit: rollback,
      stateGeneration: 3,
      resourceIdentities: [resource.identity],
    }),
  });
}

function current(value = plan()) {
  return {
    format: "pi-herdr-operator-current/v1" as const,
    commit,
    resources: [resource],
    preflight: value.preflight,
  };
}

test("operation plans require exact identities and retain rollback evidence", () => {
  const value = plan();
  assert.equal(value.dryRun, true);
  assert.equal(value.executionEnabled, false);
  assert.equal(value.confirmationRequired, true);
  assert.deepEqual(value.rollback.resourceIdentities, ["broker-v1"]);
  assert.equal(
    verifyOperationPlan(value, commit, [resource], value.preflight).ok,
    true,
  );
  assert.deepEqual(
    verifyOperationPlan(
      value,
      commit,
      [{ ...resource, identity: "replacement" }],
      value.preflight,
    ).reasons,
    ["resource identity changed: broker"],
  );
});

test("dirty, missing, extra, and changed resources fail closed", () => {
  const value = plan();
  assert.equal(
    verifyOperationPlan(
      value,
      commit,
      [{ ...resource, state: "dirty" }],
      value.preflight,
    ).ok,
    false,
  );
  assert.deepEqual(
    verifyOperationPlan(value, commit, [], value.preflight).reasons,
    ["resource is missing: broker"],
  );
  assert.match(
    verifyOperationPlan(
      value,
      commit,
      [resource, { id: "extra", identity: "extra-v1", state: "unknown" }],
      value.preflight,
    ).reasons[0]!,
    /unknown resource/,
  );
  assert.throws(
    () =>
      createOperationPlan({
        ...value,
        expectedResources: [{ ...resource, state: "unknown" }],
      }),
    /not clean/,
  );
});

test("stale preflight evidence fails closed", () => {
  const value = plan();
  const stale = [{ name: "validate", digest: digestEvidence("stale") }];
  assert.deepEqual(
    verifyOperationPlan(value, commit, [resource], stale).reasons,
    ["preflight evidence changed: validate"],
  );
  assert.match(
    verifyOperationPlan(value, commit, [resource], []).reasons[0]!,
    /missing/,
  );
  assert.match(
    verifyOperationPlan(
      value,
      commit,
      [resource],
      [...value.preflight, { name: "extra", digest: digestEvidence("extra") }],
    ).reasons[0]!,
    /extra/,
  );
});

test("apply revalidates immediately before the fake runner", async () => {
  const value = plan();
  let calls = 0;
  await assert.rejects(
    () =>
      applyOperationPlan(value, {
        confirmed: true,
        execute: true,
        readCurrentEvidence: async () => ({
          ...current(),
          resources: [{ ...resource, identity: "replacement" }],
        }),
        runner: {
          async run() {
            calls++;
            return { status: 0 };
          },
        },
      }),
    /evidence is stale/,
  );
  assert.equal(calls, 0);
  const result = await applyOperationPlan(value, {
    confirmed: true,
    execute: true,
    readCurrentEvidence: async () => current(value),
    runner: {
      async run(command, args, options) {
        assert.equal(command, "restart");
        assert.deepEqual(args, [commit]);
        assert.equal(options.timeoutMs, 5000);
        calls++;
        return { status: 0 };
      },
    },
  });
  assert.equal(result.applied, true);
  assert.equal(calls, 1);
});

test("strict private plan and current files reject malformed and duplicate entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-m7-operator-files-"));
  const planPath = join(root, "plan.json");
  const currentPath = join(root, "current.json");
  await writeFile(planPath, JSON.stringify(plan()), { mode: 0o600 });
  await writeFile(currentPath, JSON.stringify(current()), { mode: 0o600 });
  assert.equal((await loadOperationPlan(planPath)).expectedCommit, commit);
  assert.equal((await loadCurrentEvidence(currentPath)).commit, commit);
  await writeFile(
    planPath,
    JSON.stringify({ ...plan(), expectedResources: [resource, resource] }),
    { mode: 0o600 },
  );
  await assert.rejects(() => loadOperationPlan(planPath), /duplicate/);
  await writeFile(currentPath, "[]", { mode: 0o600 });
  await assert.rejects(() => loadCurrentEvidence(currentPath), /object/);
});

test("invalid commit, evidence, timeout, and rollback values are refused", () => {
  assert.throws(
    () =>
      createRollbackRecord({
        candidateCommit: "bad",
        rollbackCommit: rollback,
        stateGeneration: 0,
        resourceIdentities: [],
      }),
    /commit ID/,
  );
  assert.throws(
    () =>
      createOperationPlan({
        action: "deploy",
        expectedCommit: commit,
        expectedResources: [],
        preflight: [{ name: "x", digest: "bad" }],
        timeoutMs: 1,
        rollback: createRollbackRecord({
          candidateCommit: commit,
          rollbackCommit: rollback,
          stateGeneration: 0,
          resourceIdentities: [],
        }),
      }),
    /SHA-256/,
  );
  assert.throws(
    () =>
      createOperationPlan({
        action: "deploy",
        expectedCommit: commit,
        expectedResources: [],
        preflight: [{ name: "x", digest: digestEvidence("x") }],
        timeoutMs: 0,
        rollback: createRollbackRecord({
          candidateCommit: commit,
          rollbackCommit: rollback,
          stateGeneration: 0,
          resourceIdentities: [],
        }),
      }),
    /timeout/,
  );
});
