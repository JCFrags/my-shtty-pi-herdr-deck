import test from "node:test";
import assert from "node:assert/strict";
import { DeterministicScheduler } from "../../src/scheduler/scheduler.js";
import { isReusableCandidate, planAdmission, selectReusableAgent } from "../../src/scheduler/admission.js";
import type { ReuseCandidate, ReuseRequest, SchedulerTask } from "../../src/scheduler/types.js";

const task = (id: string, queuedAt: number): SchedulerTask => ({
  id,
  parentAgentId: "agt_parent",
  profileId: "scout",
  priority: "normal",
  queuedAt,
  depth: 1,
  dependencies: [],
  state: "queued",
});

const request: ReuseRequest = {
  profileId: "scout",
  projectKey: "project-a",
  worktreeKey: "worktree-a",
  trustKey: "trust-a",
  toolPolicyHash: "tools-a",
  modelPolicyHash: "model-a",
};

const candidate = (overrides: Partial<ReuseCandidate> = {}): ReuseCandidate => ({
  agentId: "agt_a",
  ...request,
  cleanupPending: false,
  idle: true,
  ...overrides,
});

test("admission plan delegates deterministic ordering and does not mutate the scheduler", () => {
  const scheduler = new DeterministicScheduler({ maxActiveAgents: 1 });
  scheduler.enqueue(task("tsk_b", 2));
  scheduler.enqueue(task("tsk_a", 1));

  const before = scheduler.snapshot();
  const plan = planAdmission(scheduler);

  assert.deepEqual(plan.admittedTaskIds, ["tsk_a"]);
  assert.deepEqual(plan.blockedTaskIds, ["tsk_b"]);
  assert.equal(plan.decisions[1]?.reason, "global_limit");
  assert.deepEqual(scheduler.snapshot(), before);
});

test("admission plan accepts an external frozen task map", () => {
  const scheduler = new DeterministicScheduler({ maxActiveAgents: 1 });
  const tasks = new Map<string, SchedulerTask>([["tsk_external", task("tsk_external", 1)]]);

  assert.deepEqual(planAdmission(scheduler, tasks).admittedTaskIds, ["tsk_external"]);
  assert.deepEqual(scheduler.snapshot(), { queued: [], active: [], provisioning: 0 });
});

test("reuse requires all policy identity fields and clean idle state", () => {
  assert.equal(isReusableCandidate(request, candidate()), true);
  assert.equal(isReusableCandidate(request, candidate({ cleanupPending: true })), false);
  assert.equal(isReusableCandidate(request, candidate({ idle: false })), false);
  assert.equal(isReusableCandidate(request, candidate({ trustKey: "other" })), false);
  assert.equal(isReusableCandidate(request, candidate({ worktreeKey: "other" })), false);
});

test("reuse selection is deterministic and excludes incompatible candidates", () => {
  const selected = selectReusableAgent(request, [
    candidate({ agentId: "agt_z" }),
    candidate({ agentId: "agt_a", toolPolicyHash: "other" }),
    candidate({ agentId: "agt_b" }),
    candidate({ agentId: "agt_c", cleanupPending: true }),
  ]);

  assert.equal(selected, "agt_b");
  assert.equal(selectReusableAgent(request, [candidate({ idle: false })]), undefined);
});
