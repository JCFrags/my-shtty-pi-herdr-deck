import assert from "node:assert/strict";
import test from "node:test";
import { DeckStore, snapshotFromBroker } from "../../src/deck/store.js";

test("store replaces snapshots without retaining mutable input or state maps", () => {
  const workflow = {
    id: "wf_1",
    state: "running" as const,
    taskIds: ["tsk_1"],
  };
  const snapshot = {
    seq: 4,
    agents: [{ id: "agt_1", state: "idle" as const, generation: 1 }],
    tasks: [
      {
        id: "tsk_1",
        title: "Build",
        objective: "x",
        state: "queued" as const,
        createdAt: "now",
      },
    ],
    workflows: [workflow],
  };
  const store = new DeckStore();
  store.replace(snapshot);
  const before = store.state;
  workflow.taskIds.push("tsk_2");
  const sourceTask = snapshot.tasks[0];
  assert.ok(sourceTask);
  sourceTask.title = "changed outside store";
  assert.equal(store.state.tasks.get("tsk_1")?.title, "Build");
  assert.equal(store.state.workflows.get("wf_1")?.taskIds.length, 1);

  store.apply({
    seq: 5,
    id: "evt_1",
    event: "task.state_changed",
    refs: { taskId: "tsk_1" },
    data: { to: "running" },
  });
  assert.notEqual(store.state, before);
  assert.equal(before.tasks.get("tsk_1")?.state, "queued");
});

test("replay is ordered and stale events do not overwrite newer state", () => {
  const store = new DeckStore();
  store.replace({
    seq: 0,
    agents: [{ id: "agt_1", state: "idle", generation: 1 }],
    tasks: [],
    workflows: [],
  });
  assert.equal(
    store.applyReplay([
      {
        seq: 3,
        id: "evt_3",
        event: "agent.blocked",
        refs: { agentId: "agt_1" },
        data: {},
      },
      {
        seq: 1,
        id: "evt_1",
        event: "agent.state_changed",
        refs: { agentId: "agt_1" },
        data: { state: "working" },
      },
      {
        seq: 2,
        id: "evt_2",
        event: "agent.state_changed",
        refs: { agentId: "agt_1" },
        data: { state: "idle" },
      },
    ]),
    3,
  );
  assert.equal(store.state.seq, 3);
  assert.equal(store.state.agents.get("agt_1")?.state, "blocked");
  assert.equal(
    store.apply({
      seq: 2,
      id: "old",
      event: "agent.state_changed",
      refs: { agentId: "agt_1" },
      data: { state: "failed" },
    }),
    false,
  );
});

test("events map entities and normalize questions and results", () => {
  const store = new DeckStore();
  store.replace({
    seq: 10,
    agents: [],
    tasks: [
      {
        id: "tsk_1",
        title: "T",
        objective: "O",
        state: "running",
        createdAt: "now",
      },
    ],
    workflows: [],
  });
  store.apply({
    seq: 11,
    id: "question_1",
    event: "task.question",
    refs: { taskId: "tsk_1" },
    data: { prompt: "Choose", options: ["a", 2, "b"] },
  });
  store.apply({
    seq: 12,
    id: "result_1",
    event: "task.result",
    refs: { taskId: "tsk_1" },
    data: { status: "pending", evidence: ["a", 3], tests: ["ok"] },
  });
  assert.deepEqual(store.state.questions.get("question_1")?.options, [
    { id: "a", label: "a" },
    { id: "b", label: "b" },
  ]);
  assert.equal(store.state.results.get("result_1")?.status, "pending");
  assert.deepEqual(store.state.results.get("result_1")?.evidence, ["a"]);
  assert.deepEqual(store.state.results.get("result_1")?.tests, ["ok"]);
});

test("notifications deduplicate and collections are bounded", () => {
  const store = new DeckStore();
  store.replace({ seq: 0, agents: [], tasks: [], workflows: [] });
  for (let seq = 1; seq <= 80; seq++)
    store.apply({
      seq,
      id: `evt_${seq}`,
      event: "task.blocked",
      refs: {},
      data: { prompt: "blocked" },
    });
  assert.equal(store.notifications.length, 32);
  assert.equal(store.notifications[0]?.id, "evt_80");
  const snapshot = snapshotFromBroker({
    seq: 1,
    agents: Array.from({ length: 5000 }, (_, i) => ({
      id: `a${i}`,
      state: "idle",
      generation: 1,
    })),
    tasks: [],
    workflows: [],
  });
  assert.equal(snapshot.agents.length, 4096);
});
