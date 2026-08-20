import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptedCompactWorkflow,
  CompactDelegationError,
  compileCompactDelegation,
} from "../../src/broker/compact-delegation.js";
import { ParentToolService } from "../../src/pi/parent-tools.js";
import {
  PARENT_TOOL_METADATA,
  PARENT_TOOL_NAMES,
} from "../../src/pi/parent-tool-schema.js";

const policyContext = {
  parentContextHash: "b".repeat(64),
  workspacePolicyHash: "c".repeat(64),
  parentGeneration: 1,
  parentDepth: 0,
  delegatedDepth: 1,
  maxDelegationDepth: 2,
  depthDecision: "allow" as const,
  budgetPolicyHash: "d".repeat(64),
  admissionLimits: {
    maxActiveAgents: 4,
    maxActivePerParent: 4,
    maxQueuedTasks: 32,
    maxTasksPerDelegate: 8,
    maxProvisioning: 2,
  },
  admissionSnapshot: {
    queuedTasks: 0,
    activeTasks: 0,
    parentActiveTasks: 0,
    provisioningTasks: 0,
  },
  admissionDecision: {
    decision: "allow" as const,
    requestedTasks: 2,
    queueAfterAcceptance: 2,
    initialDispatch: "eligible" as const,
  },
};

const resolver = (id: string, isolation: "shared-readonly" | "worktree") =>
  new Set(["implementer", "reviewer", "scout"]).has(id)
    ? {
        profileId: id,
        policy: {
          decision: "allow" as const,
          placement: "current-workspace" as const,
          isolation,
          modelProfileId: "subagent" as const,
          providerQualifiedModel: "openai-codex/gpt-5.6-luna",
          thinkingLevel: "medium",
          modelPolicyHash: "a".repeat(64),
          context: policyContext,
        },
      }
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
    placement: "current-workspace",
    isolation: "shared-readonly",
  });
  assert.equal(value.workflow.steps[1]?.objective, "Check it");
  assert.deepEqual(value.workflow.steps[1]?.resultProjection, []);
  assert.equal(value.workflow.transcriptPolicy, "retain-tab");
  assert.equal(JSON.stringify(value.steps).includes("modelPolicyHash"), false);
  assert.doesNotMatch(JSON.stringify(value), /describe only/u);
  assert.equal(
    compileCompactDelegation(text, resolver).workflowDigest,
    value.workflowDigest,
  );
});

test("compact digest binds parent, workspace, depth, and budget policy context", () => {
  const input = "- [ ] bind: Bind policy [profile:reviewer] [mode:read]";
  const compileWith = (context: typeof policyContext) =>
    compileCompactDelegation(input, (id, isolation) => {
      const resolved = resolver(id, isolation);
      return resolved
        ? { ...resolved, policy: { ...resolved.policy, context } }
        : undefined;
    });
  const baseline = compileWith(policyContext);
  for (const context of [
    {
      ...policyContext,
      parentGeneration: 2,
      parentContextHash: "e".repeat(64),
    },
    {
      ...policyContext,
      parentDepth: 1,
      delegatedDepth: 2,
      parentContextHash: "f".repeat(64),
    },
    {
      ...policyContext,
      workspacePolicyHash: "1".repeat(64),
      parentContextHash: "2".repeat(64),
    },
    {
      ...policyContext,
      budgetPolicyHash: "3".repeat(64),
      admissionLimits: {
        ...policyContext.admissionLimits,
        maxQueuedTasks: 31,
      },
    },
    {
      ...policyContext,
      admissionSnapshot: {
        ...policyContext.admissionSnapshot,
        queuedTasks: 1,
      },
      admissionDecision: {
        ...policyContext.admissionDecision,
        queueAfterAcceptance: 3,
      },
    },
  ])
    assert.notEqual(
      compileWith(context).workflowDigest,
      baseline.workflowDigest,
    );
  assert.doesNotMatch(JSON.stringify(baseline), /workspace-secret|\/home\//u);
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
  assert.throws(() =>
    compileCompactDelegation(
      Array.from(
        { length: 33 },
        (_, index) => `- [ ] s${index}: Step ${index} [profile:scout]`,
      ).join("\n"),
      resolver,
    ),
  );
});

test("compact parser counts non-empty lines and keeps physical error lines", () => {
  const accepted = compileCompactDelegation(
    `${"\n".repeat(32)}- [ ] work: Do work [profile:scout]${"\n".repeat(32)}`,
    resolver,
  );
  assert.equal(accepted.stepCount, 1);
  assert.throws(
    () =>
      compileCompactDelegation(
        "\n\n- [ ] good: Good [profile:scout]\n\nnot-a-step",
        resolver,
      ),
    (error: unknown) =>
      (error as CompactDelegationError).code === "COMPACT_MARKER_INVALID" &&
      (error as CompactDelegationError).line === 5,
  );
});

test("authoritative parent schema equals runtime names and method metadata", () => {
  const schema = JSON.parse(
    readFileSync(
      join(process.cwd(), "schemas/parent-tool-request.schema.json"),
      "utf8",
    ),
  ) as { properties: { tool: { enum: string[] } } };
  assert.deepEqual(schema.properties.tool.enum, [...PARENT_TOOL_NAMES]);
  assert.deepEqual(Object.keys(PARENT_TOOL_METADATA), [...PARENT_TOOL_NAMES]);
  assert.equal(
    new Set(Object.values(PARENT_TOOL_METADATA).map((item) => item.method))
      .size,
    PARENT_TOOL_NAMES.length,
  );
});
