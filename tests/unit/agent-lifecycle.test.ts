import assert from "node:assert/strict";
import test from "node:test";
import { projectAgentLifecycle } from "../../src/broker/agent-lifecycle.js";
import type { Agent, OrchestrationState, Task } from "../../src/state/types.js";

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
