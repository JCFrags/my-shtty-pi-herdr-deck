import assert from "node:assert/strict";
import test from "node:test";
import { DeckStore } from "../../src/deck/store.js";
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
  assert.match(actions.authorize("stop", {}) ?? "", /Pane identity/);
  assert.match(actions.authorize("answer", {}) ?? "", /question/);
});
