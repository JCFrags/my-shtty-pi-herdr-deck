import assert from "node:assert/strict";
import test from "node:test";
import { DeckStore, snapshotFromBroker } from "../../src/deck/store.js";
import {
  renderAgents,
  renderTasks,
  renderNotifications,
} from "../../src/deck/views.js";
import { DeckActions } from "../../src/deck/actions.js";
import { BrokerClient } from "../../src/deck/broker-client.js";

test("deck store applies snapshots and ordered events exactly once", () => {
  const store = new DeckStore();
  store.replace({
    seq: 10,
    agents: [{ id: "agt_1", state: "working", generation: 1 }],
    tasks: [
      {
        id: "tsk_1",
        title: "Build",
        objective: "x",
        state: "running",
        createdAt: "now",
        currentRunId: "run_1",
      },
    ],
    runs: [
      {
        id: "run_1",
        taskId: "tsk_1",
        state: "working",
        assignmentGeneration: 1,
        settled: false,
        agentId: "agt_1",
      },
    ],
    workflows: [],
  });
  assert.equal(
    store.apply({
      seq: 11,
      id: "evt_1",
      event: "task.state_changed",
      refs: { taskId: "tsk_1" },
      data: { to: "blocked" },
    }),
    true,
  );
  assert.equal(
    store.apply({
      seq: 11,
      id: "evt_1",
      event: "task.state_changed",
      refs: { taskId: "tsk_1" },
      data: { to: "failed" },
    }),
    false,
  );
  assert.equal(store.state.tasks.get("tsk_1")?.state, "blocked");
  assert.match(renderAgents(store.state, 120).join("\n"), /working/);
  assert.match(renderTasks(store.state, 120).join("\n"), /blocked/);
});

test("production snapshot records normalize groups, durable questions, and results", () => {
  const snapshot = snapshotFromBroker({
    seq: 8,
    agents: [],
    tasks: [],
    workflows: [],
    groups: [
      {
        groupId: "grp_1",
        status: "blocked",
        name: "Reviewers",
        agentIds: ["agt_1"],
        blockedReason: "Needs an answer",
      },
    ],
    questions: [
      {
        id: "que_1",
        taskId: "tsk_1",
        agentId: "agt_1",
        state: "open",
        payload: {
          prompt: "Proceed?",
          options: [{ id: "yes", label: "Yes" }],
          allowFreeform: false,
        },
      },
    ],
    results: [
      {
        id: "res_1",
        taskId: "tsk_1",
        status: "succeeded",
        payload: { summary: "Complete", tests: ["focused"] },
      },
    ],
  });
  assert.equal(snapshot.groups?.[0]?.id, "grp_1");
  assert.equal(snapshot.questions?.[0]?.prompt, "Proceed?");
  assert.equal(snapshot.questions?.[0]?.options?.[0]?.id, "yes");
  assert.equal(snapshot.results?.[0]?.status, "accepted");
  assert.equal(snapshot.results?.[0]?.tests?.[0], "focused");
});

test("canonical question and result events retain nested detail", () => {
  const store = new DeckStore();
  store.apply({
    seq: 1,
    id: "evt_question",
    event: "question.opened",
    refs: {
      questionId: "qst_1",
      taskId: "tsk_1",
      runId: "run_1",
      agentId: "agt_1",
    },
    data: {
      payload: {
        prompt: "Choose a target.",
        options: [{ id: "linux", label: "Linux" }],
      },
    },
  });
  assert.equal(store.state.questions.get("qst_1")?.prompt, "Choose a target.");
  assert.equal(store.state.questions.get("qst_1")?.runId, "run_1");
  store.apply({
    seq: 2,
    id: "evt_answer",
    event: "question.answered",
    refs: { questionId: "qst_1", taskId: "tsk_1", runId: "run_1" },
    data: { answer: { optionId: "linux", text: null } },
  });
  assert.equal(store.state.questions.get("qst_1")?.answered, true);
  assert.equal(store.state.questions.get("qst_1")?.state, "answered");
  store.apply({
    seq: 3,
    id: "evt_result",
    event: "result.published",
    refs: { resultId: "res_1", taskId: "tsk_1", runId: "run_1" },
    data: {
      status: "succeeded",
      payload: { summary: "Complete", artifacts: ["REPORT.md"] },
    },
  });
  assert.equal(store.state.results.get("res_1")?.summary, "Complete");
  assert.equal(store.state.results.get("res_1")?.artifacts?.[0], "REPORT.md");
});

test("notifications are text and deduplicated by event id", () => {
  const store = new DeckStore();
  store.apply({
    seq: 1,
    id: "evt_q",
    event: "task.blocked",
    refs: { taskId: "tsk_1" },
    data: { prompt: "Choose" },
  });
  store.apply({
    seq: 1,
    id: "evt_q",
    event: "task.blocked",
    refs: { taskId: "tsk_1" },
    data: { prompt: "Choose" },
  });
  assert.equal(store.notifications.length, 1);
  assert.match(
    renderNotifications(store.notifications, 80).join("\n"),
    /blocked/,
  );
});

test("deck actions fail closed for missing occupant identity", () => {
  const client = new BrokerClient({
    socketPath: "/tmp/m6-unused.sock",
    secret: "test",
  });
  const actions = new DeckActions(client);
  assert.match(actions.authorize("stop", {}) ?? "", /agent/);
  assert.match(actions.authorize("answer", {}) ?? "", /question/);
});
