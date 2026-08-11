import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkflowState,
  cancelWorkflow,
  fanInWorkflow,
  workflowReadiness,
  type WorkflowExecution,
} from "../../src/scheduler/workflow-engine.js";
import {
  planWorkflow,
  type WorkflowDefinition,
} from "../../src/scheduler/workflows.js";

const definition: WorkflowDefinition = {
  version: 1,
  id: "fan-in",
  name: "Fan-in",
  description: "focused workflow test",
  mode: "dag",
  failureMode: "collect_all",
  maxCorrectionLoops: 0,
  steps: [
    {
      key: "a",
      profileId: "scout",
      title: "A",
      objectiveTemplate: "A",
      constraints: [],
      dependsOn: [],
      resultProjection: [],
      isolationMode: "shared-readonly",
    },
    {
      key: "b",
      profileId: "scout",
      title: "B",
      objectiveTemplate: "B",
      constraints: [],
      dependsOn: [],
      resultProjection: [],
      isolationMode: "shared-readonly",
    },
    {
      key: "join",
      profileId: "reviewer",
      title: "Join",
      objectiveTemplate: "Join",
      constraints: [],
      dependsOn: ["a", "b"],
      resultProjection: [],
      isolationMode: "shared-readonly",
    },
  ],
};

const plan = planWorkflow(definition, { objective: "run" });
const state = (value: WorkflowExecution["state"]): WorkflowExecution => ({
  state: value,
});

test("workflow readiness admits independent steps, then deterministic fan-in", () => {
  const initial = workflowReadiness(plan, new Map());
  assert.deepEqual(
    initial.ready.map((step) => step.key),
    ["a", "b"],
  );
  assert.deepEqual(
    initial.waiting.map((step) => step.key),
    ["join"],
  );
  const next = workflowReadiness(
    plan,
    new Map([
      ["a", state("succeeded")],
      ["b", state("succeeded")],
    ]),
  );
  assert.deepEqual(
    next.ready.map((step) => step.key),
    ["join"],
  );
});

test("failed dependency blocks descendants and fan-in does not report success", () => {
  const states = new Map<string, WorkflowExecution>([
    ["a", state("failed")],
    ["b", state("succeeded")],
  ]);
  assert.deepEqual(
    workflowReadiness(plan, states).blocked.map((step) => step.key),
    ["join"],
  );
  assert.equal(fanInWorkflow(plan, states).state, "failed");
});

test("cancellation is idempotent and late events cannot reverse it", () => {
  const cancelled = cancelWorkflow(
    plan,
    new Map([
      ["a", state("running")],
      ["b", state("succeeded")],
    ]),
  );
  assert.equal(cancelled.get("a")?.state, "cancelled");
  assert.equal(cancelled.get("b")?.state, "succeeded");
  assert.deepEqual(
    applyWorkflowState(
      cancelled.get("a") ?? state("queued"),
      state("succeeded"),
    ),
    state("cancelled"),
  );
  assert.equal(cancelWorkflow(cancelled, plan).get("a")?.state, "cancelled");
});

test("fan-in preserves plan order and distinguishes running from queued", () => {
  const states = new Map<string, WorkflowExecution>([
    ["a", state("succeeded")],
    ["b", state("running")],
  ]);
  const result = fanInWorkflow(plan, states);
  assert.equal(result.state, "running");
  assert.deepEqual(
    result.tasks.map((task) => task.key),
    ["a", "b", "join"],
  );
});
