import test from "node:test";
import assert from "node:assert/strict";
import {
  M5BrokerIntegrationAdapter,
  type M5BrokerCommand,
} from "../../src/broker/m5-integration.js";
import { planWorkflow } from "../../src/scheduler/workflows.js";
import type { Admission } from "../../src/scheduler/scheduler.js";
import type { SchedulerTask } from "../../src/scheduler/types.js";

const task: SchedulerTask = {
  id: "tsk_child",
  parentAgentId: "agt_parent",
  profileId: "scout",
  priority: "high",
  queuedAt: 1,
  depth: 1,
  dependencies: [],
  state: "queued",
};

const workflow = {
  version: 1 as const,
  id: "wf",
  name: "single",
  description: "test",
  mode: "single" as const,
  failureMode: "fail_fast" as const,
  maxCorrectionLoops: 0,
  steps: [
    {
      key: "inspect",
      profileId: "scout",
      title: "Inspect",
      objectiveTemplate: "{{input.objective}}",
      constraints: ["read only"],
      dependsOn: [],
      resultProjection: ["/summary"],
      isolationMode: "shared-readonly" as const,
    },
  ],
};

test("integration adapter maps admission decisions without opening a broker", () => {
  const adapter = new M5BrokerIntegrationAdapter({
    send: async () => {
      throw new Error("not called");
    },
  });
  const admitted: Admission = {
    taskId: task.id,
    admitted: true,
    reason: "admitted",
  };
  const blocked: Admission = {
    taskId: task.id,
    admitted: false,
    reason: "parent_limit",
  };
  assert.deepEqual(adapter.prepareAdmission(admitted, task), {
    method: "scheduler.admit",
    params: {
      taskId: task.id,
      parentAgentId: task.parentAgentId,
      profileId: task.profileId,
      depth: 1,
    },
    idempotencyKey: "m5:scheduler.admit:tsk_child",
  });
  assert.equal(
    adapter.prepareAdmission(blocked, task).method,
    "scheduler.block",
  );
  assert.throws(
    () => adapter.prepareAdmission({ ...admitted, taskId: "tsk_other" }, task),
    /ADMISSION_TASK_MISMATCH/,
  );
});

test("workflow and cancellation commands are immutable snapshots", () => {
  const adapter = new M5BrokerIntegrationAdapter({
    send: async () => undefined,
  });
  const plan = planWorkflow(workflow, { objective: "inspect", dryRun: true });
  const command = adapter.prepareWorkflow(plan);
  assert.equal(command.method, "workflow.plan");
  assert.equal(
    (command.params.steps as Array<{ objective: string }>)[0]?.objective,
    "inspect",
  );
  assert.deepEqual(adapter.prepareCancellation(task.id), {
    method: "task.cancel",
    params: { taskId: task.id, reason: "cancelled" },
    idempotencyKey: "m5:task.cancel:tsk_child",
  });
  assert.throws(() => adapter.prepareCancellation(""), /TASK_ID_REQUIRED/);
});

test("dispatch uses only the injected transport and preserves command order", async () => {
  const calls: M5BrokerCommand[] = [];
  const adapter = new M5BrokerIntegrationAdapter({
    send: async (command) => {
      calls.push(command);
      return { accepted: true, method: command.method };
    },
  });
  const commands = [
    adapter.prepareCancellation("tsk_a"),
    adapter.prepareCancellation("tsk_b", "operator"),
  ];
  const result = await adapter.dispatch(commands);
  assert.deepEqual(
    calls.map((command) => command.params.taskId),
    ["tsk_a", "tsk_b"],
  );
  assert.deepEqual(
    result.map((item) => item.result),
    [
      { accepted: true, method: "task.cancel" },
      { accepted: true, method: "task.cancel" },
    ],
  );
});
