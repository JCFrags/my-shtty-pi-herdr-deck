import assert from "node:assert/strict";
import test from "node:test";
import { projectAgentLifecycle } from "../../src/broker/agent-lifecycle.js";
import type { Agent, OrchestrationState, Task } from "../../src/state/types.js";
import { emptyState, reduce } from "../../src/state/reducer.js";

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: "agt_child",
  managed: true,
  generation: 1,
  parentAgentId: "agt_parent",
  state: "idle",
  ...overrides,
});
const task = (overrides: Partial<Task> = {}): Task => ({
  id: "tsk_1",
  title: "Done",
  objective: "Finish.",
  parentAgentId: "agt_parent",
  assignedAgentId: "agt_child",
  state: "succeeded",
  resultId: "res_1",
  resultCollectedAt: "2026-08-21T18:00:00.000Z",
  createdAt: "2026-08-21T17:00:00.000Z",
  ...overrides,
});
const state = (
  candidate: Agent,
  candidateTask = task(),
): OrchestrationState => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  lastEventHash: "0".repeat(64),
  agents: { [candidate.id]: candidate },
  tasks: { [candidateTask.id]: candidateTask },
  runs: {},
  workflows: {},
  results: {},
  questions: {},
  groups: {},
  idempotency: {},
});

test("collected terminal temporary agents are recommended for close", () => {
  const candidate = agent({ lifecycleClass: "temporary" });
  assert.deepEqual(projectAgentLifecycle(candidate, state(candidate)), {
    lifecycleClass: "temporary",
    keepForReuse: false,
    closeRecommendation: "close",
    closeReason: "The temporary task is complete and its result was collected.",
  });
});

test("startup timeout becomes terminal work and is not active", () => {
  let current = reduce(emptyState(), {
    type: "task.created_m3",
    actor: { principalId: "p", kind: "system" },
    entityRefs: { taskId: "tsk_1" },
    payload: {
      taskId: "tsk_1",
      title: "Start",
      objective: "Start",
      state: "provisioning",
      createdAt: "2026-08-21T00:00:00.000Z",
    },
  });
  current = reduce(current, {
    type: "agent.registered",
    actor: { principalId: "p", kind: "system" },
    entityRefs: { agentId: "agt_child" },
    payload: {
      agentId: "agt_child",
      generation: 1,
      state: "starting",
      parentAgentId: "agt_parent",
    },
  });
  current = reduce(current, {
    type: "run.created",
    actor: { principalId: "p", kind: "system" },
    entityRefs: { runId: "run_1", taskId: "tsk_1", agentId: "agt_child" },
    payload: {
      runId: "run_1",
      taskId: "tsk_1",
      agentId: "agt_child",
      assignmentGeneration: 1,
      state: "created",
    },
  });
  current = reduce(current, {
    type: "run.state_changed",
    actor: { principalId: "p", kind: "system" },
    entityRefs: { runId: "run_1", taskId: "tsk_1" },
    payload: {
      runId: "run_1",
      state: "timed_out",
      reason: { code: "TIMEOUT", message: "The task wall deadline expired." },
    },
  });
  assert.equal(current.tasks.tsk_1?.state, "timed_out");
});

test("active, blocked, uncollected, reusable, retained, and pinned agents never recommend close", () => {
  const uncollected = task();
  delete uncollected.resultCollectedAt;
  for (const [candidate, candidateTask] of [
    [agent({ state: "working" }), task()],
    [agent({ state: "blocked" }), task()],
    [agent(), uncollected],
    [agent({ lifecycleClass: "reusable", keepForReuse: true }), task()],
    [agent({ lifecycleClass: "retained" }), task()],
    [agent({ lifecycleClass: "pinned" }), task()],
  ] as Array<[Agent, Task]>)
    assert.notEqual(
      projectAgentLifecycle(candidate, state(candidate, candidateTask))
        .closeRecommendation,
      "close",
    );
});
