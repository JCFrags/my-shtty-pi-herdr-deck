import assert from "node:assert/strict";
import test from "node:test";
import {
  derivedEndpointId,
  resolveEndpoint,
} from "../../src/broker/endpoint-policy.js";
import { scalarSchedulerLimits, validateConfig } from "../../src/ops/config.js";
import { planAdmission } from "../../src/scheduler/admission.js";
import { DeterministicScheduler } from "../../src/scheduler/scheduler.js";
import type { SchedulerTask } from "../../src/scheduler/types.js";
import { emptyState, reduce } from "../../src/state/reducer.js";
import type { EventInput } from "../../src/state/types.js";

const selection = {
  provider: "local-provider",
  modelId: "model-a",
  thinkingLevel: "medium" as const,
};

const endpointConfig = {
  endpoints: {
    "local-host": { maxConcurrentAgents: 1 },
    "remote-host": { maxConcurrentAgents: 8 },
  },
  mappings: [
    { provider: "local-provider", endpointId: "remote-host" },
    {
      provider: "local-provider",
      modelId: "model-a",
      endpointId: "local-host",
    },
  ],
};

function schedulerTask(
  id: string,
  state: SchedulerTask["state"],
  endpointId = "local-host",
  queuedAt = 0,
): SchedulerTask {
  return {
    id,
    parentAgentId: `agt_${id}`,
    profileId: "scout",
    priority: "normal",
    queuedAt,
    depth: 0,
    dependencies: [],
    state,
    endpointId,
  };
}

function event(
  type: string,
  entityRefs: Record<string, string>,
  payload: Record<string, unknown>,
): EventInput {
  return {
    type,
    actor: { principalId: "prn_test", kind: "system" },
    entityRefs,
    payload,
  };
}

test("endpoint configuration validates mappings and keeps scheduler scalars separate", () => {
  const config = validateConfig({
    version: 1,
    scheduler: {
      maxActiveAgents: 4,
      endpoints: endpointConfig.endpoints,
    },
    modelIntelligence: {
      schemaVersion: 1,
      mappings: endpointConfig.mappings,
    },
  });
  assert.deepEqual(config.scheduler?.endpoints, endpointConfig.endpoints);
  assert.deepEqual(scalarSchedulerLimits(config.scheduler), {
    maxActiveAgents: 4,
  });
  assert.throws(
    () =>
      validateConfig({
        version: 1,
        scheduler: { endpoints: endpointConfig.endpoints },
        modelIntelligence: {
          schemaVersion: 1,
          mappings: [
            {
              provider: "local-provider",
              endpointId: "missing-host",
            },
          ],
        },
      }),
    /invalid/u,
  );
  assert.throws(
    () =>
      validateConfig({
        version: 1,
        scheduler: {
          endpoints: {
            "derived-v1-user": { maxConcurrentAgents: 1 },
          },
        },
      }),
    /invalid endpoint ID/u,
  );
  assert.throws(
    () =>
      validateConfig({
        version: 1,
        scheduler: { endpoints: endpointConfig.endpoints },
        modelIntelligence: {
          schemaVersion: 1,
          mappings: [
            { provider: "local-provider", endpointId: "local-host" },
            { provider: "local-provider", endpointId: "remote-host" },
          ],
        },
      }),
    /duplicate mapping/u,
  );
});

test("exact endpoint mapping wins and provider fallback is stable", () => {
  assert.deepEqual(resolveEndpoint(selection, endpointConfig, 4), {
    endpointId: "local-host",
    maxConcurrentAgents: 1,
    mapping: "exact",
  });
  assert.deepEqual(
    resolveEndpoint({ ...selection, modelId: "model-b" }, endpointConfig, 4),
    {
      endpointId: "remote-host",
      maxConcurrentAgents: 8,
      mapping: "provider",
    },
  );
  const fallback = resolveEndpoint(selection, {}, 4);
  assert.equal(fallback.endpointId, derivedEndpointId(selection.provider));
  assert.equal(fallback.maxConcurrentAgents, 4);
  assert.equal(fallback.mapping, "derived");
});

test("capacity-one endpoint queues aliases while collecting still holds the lease", () => {
  const scheduler = new DeterministicScheduler(
    { maxActiveAgents: 4, maxActivePerParent: 4 },
    { "local-host": 1 },
  );
  const tasks = new Map<string, SchedulerTask>([
    ["active", schedulerTask("active", "collecting")],
    ["alias", schedulerTask("alias", "queued", "local-host", 1)],
    ["remote", schedulerTask("remote", "queued", "remote-host", 2)],
  ]);
  const plan = planAdmission(scheduler, tasks);
  assert.deepEqual(plan.admittedTaskIds, ["remote"]);
  assert.equal(
    plan.decisions.find((decision) => decision.taskId === "alias")?.reason,
    "endpoint_capacity",
  );

  tasks.set("active", schedulerTask("active", "succeeded"));
  assert.deepEqual(planAdmission(scheduler, tasks).admittedTaskIds, [
    "alias",
    "remote",
  ]);
});

test("durable task and run projections bind one endpoint lease and queue reason", () => {
  let state = emptyState();
  state = reduce(
    state,
    event(
      "task.created_m3",
      { taskId: "tsk_endpoint" },
      {
        taskId: "tsk_endpoint",
        title: "Endpoint task",
        objective: "Hold one capacity slot",
        createdAt: "2026-08-26T00:00:00.000Z",
        endpointId: "local-host",
      },
    ),
  );
  state = reduce(
    state,
    event(
      "scheduler.blocked",
      { taskId: "tsk_endpoint" },
      { taskId: "tsk_endpoint", reason: "endpoint_capacity" },
    ),
  );
  assert.equal(state.tasks.tsk_endpoint?.admissionReason, "endpoint_capacity");

  state = reduce(
    state,
    event(
      "run.created",
      {
        taskId: "tsk_endpoint",
        runId: "run_endpoint",
        agentId: "agt_endpoint",
      },
      {
        taskId: "tsk_endpoint",
        runId: "run_endpoint",
        agentId: "agt_endpoint",
        assignmentId: "asg_endpoint",
        assignmentGeneration: 1,
        endpointId: "local-host",
      },
    ),
  );
  assert.equal(state.tasks.tsk_endpoint?.endpointId, "local-host");
  assert.equal(state.tasks.tsk_endpoint?.admissionReason, undefined);
  assert.equal(state.runs.run_endpoint?.endpointId, "local-host");

  state = reduce(
    state,
    event(
      "run.state_changed",
      { taskId: "tsk_endpoint", runId: "run_endpoint" },
      { runId: "run_endpoint", state: "failed" },
    ),
  );
  assert.equal(state.tasks.tsk_endpoint?.state, "failed");
  assert.equal(state.runs.run_endpoint?.state, "failed");
});
