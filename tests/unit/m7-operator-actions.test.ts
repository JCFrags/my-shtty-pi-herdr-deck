import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOperationPlan,
  createOperationPlan,
  createRollbackRecord,
  digestEvidence,
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

test("operation plans require exact identities and retain rollback evidence", () => {
  const value = plan();
  assert.equal(value.dryRun, true);
  assert.equal(value.executionEnabled, false);
  assert.equal(value.confirmationRequired, true);
  assert.deepEqual(value.rollback.resourceIdentities, ["broker-v1"]);
  assert.equal(verifyOperationPlan(value, commit, [resource]).ok, true);
  assert.deepEqual(
    verifyOperationPlan(value, commit, [
      { ...resource, identity: "replacement" },
    ]).reasons,
    ["resource identity changed: broker"],
  );
});

test("dirty, missing, and changed resources fail closed", () => {
  const value = plan();
  assert.equal(
    verifyOperationPlan(value, commit, [{ ...resource, state: "dirty" }]).ok,
    false,
  );
  assert.deepEqual(verifyOperationPlan(value, commit, []).reasons, [
    "resource is missing: broker",
  ]);
  assert.throws(
    () =>
      createOperationPlan({
        ...value,
        expectedResources: [{ ...resource, state: "unknown" }],
      }),
    /not clean/,
  );
});

test("apply requires confirmation and an injected fake runner", async () => {
  const value = plan();
  await assert.rejects(() => applyOperationPlan(value), /confirmation/);
  const calls: string[] = [];
  const result = await applyOperationPlan(value, {
    confirmed: true,
    execute: true,
    runner: {
      async run(command, args, options) {
        calls.push(`${command}:${args[0]}:${options.timeoutMs}`);
        return { status: 0, outputDigest: digestEvidence("fake-runner") };
      },
    },
  });
  assert.equal(result.applied, true);
  assert.deepEqual(calls, [`restart:${commit}:5000`]);
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
