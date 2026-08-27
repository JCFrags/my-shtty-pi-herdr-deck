import assert from "node:assert/strict";
import test from "node:test";
import {
  agentWithLifecycle,
  projectTaskProgress,
  taskWithProgress,
  type AgentProgress,
} from "../../src/broker/agent-lifecycle.js";
import { DeckStore } from "../../src/deck/store.js";
import {
  renderAgentInspector,
  renderTaskDetail,
} from "../../src/deck/views.js";
import { emptyState } from "../../src/state/reducer.js";
import type { Agent, Run, Task } from "../../src/state/types.js";

const startedAt = "2026-08-27T16:00:00.000Z";
const now = Date.parse("2026-08-27T16:00:10.000Z");
const taskDeadline = "2026-08-27T16:01:00.000Z";

function fixture() {
  const state = emptyState();
  const task: Task = {
    id: "tsk_01M80000000000000000000000",
    title: "Slow provision",
    objective: "Expose bounded progress.",
    state: "provisioning",
    createdAt: "2026-08-27T15:59:59.000Z",
    currentRunId: "run_01M80000000000000000000000",
    assignedAgentId: "agt_01M80000000000000000000000",
    timeoutAt: taskDeadline,
  };
  const run: Run = {
    id: task.currentRunId!,
    taskId: task.id,
    state: "created",
    agentId: task.assignedAgentId!,
    assignmentGeneration: 1,
    startedAt,
    timeoutAt: taskDeadline,
    settled: false,
  };
  const agent: Agent = {
    id: task.assignedAgentId!,
    state: "provisioning",
    generation: 1,
    currentRunId: run.id,
  };
  state.tasks[task.id] = task;
  state.runs[run.id] = run;
  state.agents[agent.id] = agent;
  state.herdrResources = {
    [agent.id]: { agentId: agent.id, state: "provisioning" },
  };
  return { state, task, run, agent };
}

function progressOf(value: unknown): AgentProgress {
  const progress = (value as { progress?: AgentProgress }).progress;
  if (!progress) throw new Error("Expected a progress projection.");
  return progress;
}

test("derived progress shows resource creation with elapsed and wall deadline", () => {
  const { state, task, agent } = fixture();
  assert.deepEqual(projectTaskProgress(task, state, now), {
    phase: "creating_resources",
    startedAt,
    elapsedMs: 10_000,
    deadlineAt: taskDeadline,
    deadlineKind: "task",
    remainingMs: 50_000,
  });
  assert.deepEqual(
    progressOf(agentWithLifecycle(agent, state, now)),
    progressOf(taskWithProgress(task, state, now)),
  );
});

test("derived progress identifies the bounded registration wait", () => {
  const { state, task } = fixture();
  state.herdrResources![task.assignedAgentId!] = {
    agentId: task.assignedAgentId!,
    state: "pending",
    registrationDeadline: "2026-08-27T16:00:30.000Z",
  };
  assert.deepEqual(projectTaskProgress(task, state, now), {
    phase: "waiting_for_registration",
    startedAt,
    elapsedMs: 10_000,
    deadlineAt: "2026-08-27T16:00:30.000Z",
    deadlineKind: "registration",
    remainingMs: 20_000,
  });
});

test("derived progress reports Pi startup and omits terminal tasks", () => {
  const { state, task, agent } = fixture();
  task.state = "assigned";
  agent.state = "starting";
  assert.equal(projectTaskProgress(task, state, now)?.phase, "starting");
  task.state = "succeeded";
  assert.equal(projectTaskProgress(task, state, now), undefined);
  assert.equal(
    (taskWithProgress(task, state, now) as { progress?: AgentProgress })
      .progress,
    undefined,
  );
});

test("Agent Board detail views show the broker-derived progress", () => {
  const { state, task, run, agent } = fixture();
  const taskView = taskWithProgress(task, state, now);
  const agentView = agentWithLifecycle(agent, state, now);
  const store = new DeckStore();
  store.replace({
    seq: 1,
    agents: [agentView],
    tasks: [taskView],
    runs: [run],
    workflows: [],
  });
  assert.match(
    renderAgentInspector(agentView, store.state, 500).join("\n"),
    /Progress: creating_resources; elapsed 10s; task deadline .*; 50s remaining/u,
  );
  assert.match(
    renderTaskDetail(taskView, store.state, 500).join("\n"),
    /Progress: creating_resources; elapsed 10s; task deadline .*; 50s remaining/u,
  );
});
