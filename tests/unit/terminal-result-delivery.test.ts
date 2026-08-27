import assert from "node:assert/strict";
import test from "node:test";
import type { PiBrokerEvent } from "../../src/pi/broker-client.js";
import {
  TERMINAL_RESULT_MESSAGE_TYPE,
  TERMINAL_RESULT_STATE_TYPE,
  TerminalResultDelivery,
} from "../../src/pi/terminal-result-delivery.js";
import type { PiApiLike } from "../../src/pi/types.js";

function brokerEvent(
  seq: number,
  taskId: string,
  state: string,
  event: "task.state_changed" | "run.state_changed" = "task.state_changed",
): PiBrokerEvent {
  return {
    seq,
    id: `evt_${seq}`,
    event,
    timestamp: "2026-08-27T00:00:00.000Z",
    refs: { taskId },
    data: event === "run.state_changed" ? { state } : { to: state },
  };
}

function harness() {
  const entries: Array<{ customType: string; data: unknown }> = [];
  const messages: Array<{
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: Record<string, unknown>;
    };
    options: unknown;
  }> = [];
  const api = {
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
    sendMessage: (
      message: (typeof messages)[number]["message"],
      options: unknown,
    ) => {
      messages.push({ message, options });
    },
  } as unknown as PiApiLike;
  return { api, entries, messages };
}

function binding(tasks: Record<string, Record<string, unknown>>, epoch = 1) {
  let current = true;
  let retries = 0;
  return {
    value: {
      epoch,
      parentAgentId: () => "agt_parent",
      request: async (_method: string, params: Record<string, unknown>) =>
        tasks[String(params.taskId)],
      isCurrent: () => current,
      retry: () => {
        retries++;
      },
    },
    setCurrent: (value: boolean) => {
      current = value;
    },
    retries: () => retries,
  };
}

test("terminal result delivery ignores blocked, wakes for success, and deduplicates replay", async () => {
  const fake = harness();
  const delivery = new TerminalResultDelivery(fake.api);
  const tasks = {
    tsk_one: {
      id: "tsk_one",
      title: "Focused check",
      parentAgentId: "agt_parent",
      assignedAgentId: "agt_one",
      state: "succeeded",
      resultId: "res_one",
    },
  };
  const active = binding(tasks);
  delivery.beginEpoch(1);
  delivery.handle(
    brokerEvent(10, "tsk_one", "blocked", "run.state_changed"),
    active.value,
  );
  delivery.handle(
    brokerEvent(11, "tsk_one", "succeeded", "run.state_changed"),
    active.value,
  );
  delivery.handle(
    brokerEvent(12, "tsk_one", "succeeded", "run.state_changed"),
    active.value,
  );
  await delivery.flush();

  assert.equal(fake.messages.length, 1);
  assert.equal(
    fake.messages[0]?.message.customType,
    TERMINAL_RESULT_MESSAGE_TYPE,
  );
  assert.deepEqual(fake.messages[0]?.options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
  assert.deepEqual(fake.messages[0]?.message.details, {
    schemaVersion: 1,
    eventSeq: 11,
    deliveryKey: "tsk_one:succeeded:res_one",
    taskId: "tsk_one",
    state: "succeeded",
    resultId: "res_one",
    assignedAgentId: "agt_one",
  });
  assert.equal(
    fake.messages[0]?.message.content,
    "Managed task tsk_one (Focused check) reached succeeded for agent agt_one. Use task_collect for tsk_one to record its structured result if available. If agent agt_one remains open and is no longer needed, use agent_close. Continue the remaining work without waiting for a user prompt.",
  );
  assert.deepEqual(
    fake.entries.map((entry) => [entry.customType, entry.data]),
    [
      [TERMINAL_RESULT_STATE_TYPE, { schemaVersion: 1, eventSeq: 10 }],
      [
        TERMINAL_RESULT_STATE_TYPE,
        {
          schemaVersion: 1,
          eventSeq: 11,
          deliveryKey: "tsk_one:succeeded:res_one",
        },
      ],
      [
        TERMINAL_RESULT_STATE_TYPE,
        {
          schemaVersion: 1,
          eventSeq: 12,
          deliveryKey: "tsk_one:succeeded:res_one",
        },
      ],
    ],
  );
  assert.equal(active.retries(), 0);
});

test("terminal result delivery restores cursor and message dedupe across reload", async () => {
  const fake = harness();
  const delivery = new TerminalResultDelivery(fake.api);
  delivery.restore([
    {
      type: "custom",
      customType: TERMINAL_RESULT_STATE_TYPE,
      data: { schemaVersion: 1, eventSeq: 20 },
    },
    {
      type: "custom_message",
      customType: TERMINAL_RESULT_MESSAGE_TYPE,
      details: {
        schemaVersion: 1,
        eventSeq: 21,
        deliveryKey: "tsk_done:succeeded:res_done",
        taskId: "tsk_done",
        state: "succeeded",
        resultId: "res_done",
      },
    },
  ]);
  assert.equal(delivery.subscriptionCursor(30), 21);
  assert.equal(delivery.subscriptionCursor(15), 15);

  const active = binding({
    tsk_done: {
      id: "tsk_done",
      title: "Already delivered",
      parentAgentId: "agt_parent",
      state: "succeeded",
      resultId: "res_done",
    },
  });
  delivery.beginEpoch(1);
  delivery.handle(
    brokerEvent(22, "tsk_done", "succeeded", "run.state_changed"),
    active.value,
  );
  await delivery.flush();
  assert.equal(fake.messages.length, 0);
  assert.deepEqual(fake.entries.at(-1), {
    customType: TERMINAL_RESULT_STATE_TYPE,
    data: {
      schemaVersion: 1,
      eventSeq: 22,
      deliveryKey: "tsk_done:succeeded:res_done",
    },
  });
});

test("terminal result delivery binds the parent and supports failure without a result", async () => {
  const fake = harness();
  const delivery = new TerminalResultDelivery(fake.api);
  const active = binding({
    tsk_other: {
      id: "tsk_other",
      parentAgentId: "agt_other",
      state: "failed",
    },
    tsk_failed: {
      id: "tsk_failed",
      title: "Failed check",
      parentAgentId: "agt_parent",
      state: "failed",
    },
  });
  delivery.beginEpoch(1);
  delivery.handle(brokerEvent(1, "tsk_other", "failed"), active.value);
  delivery.handle(brokerEvent(2, "tsk_failed", "failed"), active.value);
  await delivery.flush();

  assert.equal(fake.messages.length, 1);
  assert.deepEqual(fake.messages[0]?.message.details, {
    schemaVersion: 1,
    eventSeq: 2,
    deliveryKey: "tsk_failed:failed:",
    taskId: "tsk_failed",
    state: "failed",
  });
  assert.equal(
    fake.messages[0]?.message.content,
    "Managed task tsk_failed (Failed check) reached failed. Use task_collect for tsk_failed to record its structured result if available. Continue the remaining work without waiting for a user prompt.",
  );
  assert.doesNotMatch(fake.messages[0]?.message.content ?? "", /agent_close/);
});

test("terminal result delivery rejects an invalid assigned agent without advancing", async () => {
  const fake = harness();
  const delivery = new TerminalResultDelivery(fake.api);
  const active = binding({
    tsk_invalid_agent: {
      id: "tsk_invalid_agent",
      title: "Invalid agent",
      parentAgentId: "agt_parent",
      assignedAgentId: "bad\nagent",
      state: "succeeded",
      resultId: "res_invalid_agent",
    },
  });
  delivery.beginEpoch(1);
  delivery.handle(
    brokerEvent(3, "tsk_invalid_agent", "succeeded", "run.state_changed"),
    active.value,
  );
  await delivery.flush();
  assert.equal(fake.messages.length, 0);
  assert.equal(fake.entries.length, 0);
  assert.equal(active.retries(), 1);
});

test("terminal result delivery rejects a task response with a different task ID", async () => {
  const fake = harness();
  const delivery = new TerminalResultDelivery(fake.api);
  const active = binding({
    tsk_requested: {
      id: "tsk_other",
      title: "Wrong task",
      parentAgentId: "agt_parent",
      state: "succeeded",
      resultId: "res_other",
    },
  });
  delivery.beginEpoch(1);
  delivery.handle(
    brokerEvent(4, "tsk_requested", "succeeded", "run.state_changed"),
    active.value,
  );
  await delivery.flush();

  assert.equal(fake.messages.length, 0);
  assert.equal(fake.entries.length, 0);
  assert.equal(active.retries(), 1);
});

test("terminal result delivery retries a failed injection without advancing past it", async () => {
  const fake = harness();
  let fail = true;
  fake.api.sendMessage = () => {
    if (fail) throw new Error("MESSAGE_FAILED");
  };
  const delivery = new TerminalResultDelivery(fake.api);
  const tasks = {
    tsk_retry: {
      id: "tsk_retry",
      title: "Retry check",
      parentAgentId: "agt_parent",
      state: "succeeded",
      resultId: "res_retry",
    },
  };
  const first = binding(tasks, 1);
  delivery.beginEpoch(1);
  delivery.handle(
    brokerEvent(5, "tsk_retry", "succeeded", "run.state_changed"),
    first.value,
  );
  delivery.handle(
    brokerEvent(6, "tsk_retry", "succeeded", "run.state_changed"),
    first.value,
  );
  await delivery.flush();
  assert.equal(first.retries(), 1);
  assert.equal(fake.entries.length, 0);

  fail = false;
  first.setCurrent(false);
  const second = binding(tasks, 2);
  delivery.beginEpoch(2);
  delivery.handle(
    brokerEvent(5, "tsk_retry", "succeeded", "run.state_changed"),
    second.value,
  );
  await delivery.flush();
  assert.equal(second.retries(), 0);
  assert.deepEqual(fake.entries.at(-1), {
    customType: TERMINAL_RESULT_STATE_TYPE,
    data: {
      schemaVersion: 1,
      eventSeq: 5,
      deliveryKey: "tsk_retry:succeeded:res_retry",
    },
  });
});
