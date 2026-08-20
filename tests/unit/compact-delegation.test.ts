import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptedCompactWorkflow,
  CompactDelegationError,
  compileCompactDelegation,
} from "../../src/broker/compact-delegation.js";
import { ParentToolService } from "../../src/pi/parent-tools.js";

const resolver = (id: string) =>
  new Set(["implementer", "reviewer", "scout"]).has(id)
    ? { profileId: id }
    : undefined;

test("compact delegation compiles a DAG into canonical delegate steps", () => {
  const text =
    "- [ ] build: Build it [profile:implementer] [mode:write]\n- [x] check: Check it [after:build] [profile:reviewer] [mode:read] :: describe only\n";
  const value = compileCompactDelegation(text, resolver);
  assert.equal(value.stepCount, 2);
  assert.deepEqual(value.steps[1], {
    id: "check",
    profileId: "reviewer",
    mode: "read",
    dependencyIds: ["build"],
    placement: "background",
    isolation: "shared-readonly",
    completedInput: true,
  });
  assert.equal(value.workflow.steps[1]?.objective, "Check it");
  assert.doesNotMatch(JSON.stringify(value), /describe only/u);
  assert.equal(
    compileCompactDelegation(text, resolver).workflowDigest,
    value.workflowDigest,
  );
});

test("compact scheduling requires explicit matching digest", () => {
  const value = compileCompactDelegation(
    "1. work: Do work [profile:scout]",
    resolver,
  );
  assert.throws(
    () => acceptedCompactWorkflow(value, undefined),
    /explicit acceptance/u,
  );
  assert.throws(
    () => acceptedCompactWorkflow(value, "0".repeat(64)),
    /current digest/u,
  );
  assert.equal(
    acceptedCompactWorkflow(value, value.workflowDigest),
    value.workflow,
  );
});

test("compact parser rejects cycles, duplicate IDs, unknown tags, and shell control data", () => {
  for (const input of [
    "- [ ] a: A [after:b]\n- [ ] b: B [after:a]",
    "- [ ] a: A\n- [ ] a: B",
    "- [ ] a: A [timeout:4]",
    "- [ ] a: A :: echo x; rm y",
  ]) {
    assert.throws(
      () => compileCompactDelegation(input, resolver),
      CompactDelegationError,
    );
  }
});

test("compact parent tool routes preview and acceptance to the one broker method", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const digest = "a".repeat(64);
  const service = new ParentToolService({
    invoke: async (method, params) => {
      calls.push({ method, params });
      return params.accept === true
        ? { scheduled: true }
        : { schemaVersion: 1, workflowDigest: digest, stepCount: 1, steps: [] };
    },
  });
  const principal = {
    id: "parent",
    kind: "pi_parent" as const,
    agentId: "agt_parent",
    permissions: ["delegate"],
  };
  const input = "- [ ] work: Do work [profile:implementer]";
  const preview = await service.execute(
    { tool: "delegate_compact", input: { text: input } },
    principal,
  );
  assert.equal(preview.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "compact.delegate");
  const scheduled = await service.execute(
    {
      tool: "delegate_compact",
      input: { text: input, accept: true, workflowDigest: digest },
    },
    principal,
  );
  assert.equal(scheduled.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.method, "compact.delegate");
  assert.equal(calls[1]?.params.workflowDigest, digest);
});

test("compact parser enforces UTF-8, profile, and bounded input", () => {
  assert.throws(
    () => compileCompactDelegation(new Uint8Array([0xff]), resolver),
    (error: unknown) =>
      (error as CompactDelegationError).code === "COMPACT_UTF8_INVALID",
  );
  assert.throws(() =>
    compileCompactDelegation("- [ ] a: A [profile:unknown]", resolver),
  );
  assert.throws(() =>
    compileCompactDelegation(`- [ ] a: ${"x".repeat(241)}`, resolver),
  );
  assert.throws(() => compileCompactDelegation("\n".repeat(33), resolver));
});
