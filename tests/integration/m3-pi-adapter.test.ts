import assert from "node:assert/strict";
import { Socket } from "node:net";
import test from "node:test";
import { PiBrokerClient } from "../../src/pi/broker-client.js";
import { PiControlRouter } from "../../src/pi/controls.js";
import type { PiAssignment } from "../../src/pi/types.js";
import { FakePi, FakePiBroker, withTimeout } from "../helpers/m3-fake-pi.js";

const assignment: PiAssignment = {
  id: "asg_01J00000000000000000000000",
  taskId: "tsk_01J00000000000000000000000",
  runId: "run_01J00000000000000000000000",
  agentId: "agt_01J00000000000000000000000",
  generation: 1,
  assignmentGeneration: 1,
  piSessionId: "session-fake-1",
  objective: "Run a deterministic fake integration",
  constraints: ["Use local adapters only"],
  deadline: "2030-01-01T00:00:00.000Z",
};

function lifecycle(type: "turn_start" | "agent_settled", cycle = "cycle-1") {
  return {
    type,
    agentId: assignment.agentId,
    generation: assignment.generation,
    piSessionId: assignment.piSessionId,
    assignmentGeneration: assignment.assignmentGeneration,
    agentCycleId: cycle,
    turnIndex: 1,
  } as const;
}

test("peer ask waits for and returns the assistant answer", async () => {
  const fake = new FakePi(
    assignment.agentId,
    assignment.generation,
    assignment.piSessionId,
  );
  const entries: unknown[] = [];
  fake.context.sessionManager.getEntries = () => entries;
  const pending = fake.adapter.handleControl("control.ask", {
    agentId: assignment.agentId,
    generation: assignment.generation,
    piSessionId: assignment.piSessionId,
    message: "What changed?",
    delivery: "normal",
    timeoutMs: 1_000,
  });
  await Promise.resolve();
  entries.push({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Two files changed." }],
    },
  });
  fake.lifecycle({
    ...lifecycle("turn_start"),
    type: "agent_end",
  });
  assert.deepEqual(await pending, { ok: true, answer: "Two files changed." });
});

test("M3 fake Pi binds the exact assignment and settles its lifecycle", async () => {
  const fake = new FakePi(
    assignment.agentId,
    assignment.generation,
    assignment.piSessionId,
  );

  assert.equal(await fake.adapter.deliver(assignment), "accepted");
  assert.equal(fake.sentMessages.length, 1);
  assert.equal(fake.lifecycle(lifecycle("turn_start")), "bound");
  assert.equal(fake.lifecycle(lifecycle("agent_settled")), "settled");
  assert.equal(fake.adapter.correlator.state.kind, "settled");
});

test("M3 fake Pi treats late events from another cycle as manual activity", async () => {
  const fake = new FakePi(
    assignment.agentId,
    assignment.generation,
    assignment.piSessionId,
  );

  await fake.adapter.deliver(assignment);
  assert.equal(fake.lifecycle(lifecycle("turn_start", "cycle-late")), "bound");
  assert.equal(
    fake.lifecycle(lifecycle("agent_settled", "cycle-late")),
    "settled",
  );
  assert.equal(fake.lifecycle(lifecycle("turn_start", "cycle-old")), "manual");
});

test("M3 fake Pi times out a blocked prompt without accepting a late lifecycle", async () => {
  const fake = new FakePi(
    assignment.agentId,
    assignment.generation,
    assignment.piSessionId,
  );
  fake.blockPrompt();

  await assert.rejects(
    withTimeout(fake.adapter.deliver(assignment), 10),
    /PI_ASSIGNMENT_TIMEOUT/,
  );
  assert.equal(fake.adapter.correlator.state.kind, "pending");
  assert.equal(fake.lifecycle(lifecycle("turn_start")), "manual");

  fake.adapter.correlator.cancel();
  assert.equal(fake.lifecycle(lifecycle("agent_settled")), "manual");
  fake.releasePrompt();
  assert.equal(
    await fake.adapter.deliver({
      ...assignment,
      id: "asg_01J00000000000000000000001",
    }),
    "accepted",
  );
});

test("M3 fake Pi registers, heartbeats, and does not duplicate a connection", async () => {
  const fake = new FakePi(
    assignment.agentId,
    assignment.generation,
    assignment.piSessionId,
  );
  const broker = await FakePiBroker.start();
  const client = new PiBrokerClient({
    socketPath: broker.path,
    sessionKey: "fake-session-key",
    agentId: assignment.agentId,
    generation: assignment.generation,
    piSessionId: assignment.piSessionId,
    token: "fake-agent-token",
  });

  try {
    await client.connect();
    await client.connect();
    await client.register(fake.adapter.safeState());
    await client.heartbeat({
      ...fake.adapter.safeState(),
      turnIndex: 2,
    });

    assert.equal(broker.helloCount, 1);
    assert.deepEqual(
      broker.requests.map((request) => request.method),
      ["agent.register_managed", "agent.heartbeat"],
    );
    assert.deepEqual(
      (
        broker.requests[1]!.params as {
          agentId: string;
          state: { turnIndex: number };
        }
      ).agentId,
      assignment.agentId,
    );
    assert.deepEqual(
      (broker.requests[1]!.params as { state: { turnIndex: number } }).state,
      { sessionId: assignment.piSessionId, activity: "idle", turnIndex: 2 },
    );
  } finally {
    client.close();
    await broker.stop();
  }
});

test("M3 broker client fails closed on a post-handshake socket error", async () => {
  const broker = await FakePiBroker.start();
  const originalOn = Socket.prototype.on;
  const errorHandlers: Array<(error: Error) => void> = [];
  Socket.prototype.on = function (
    event: string | symbol,
    listener: (...args: any[]) => void,
  ): Socket {
    if (event === "error")
      errorHandlers.push(listener as (error: Error) => void);
    return (originalOn as any).call(this, event, listener);
  };
  const client = new PiBrokerClient({
    socketPath: broker.path,
    sessionKey: "fake-session-key",
    piSessionId: assignment.piSessionId,
    secret: "fake-secret",
  });
  try {
    await client.connect();
    assert.ok(errorHandlers.length > 0);
    for (const handler of errorHandlers)
      handler(new Error("injected socket error"));
    assert.equal(client.connected, false);
  } finally {
    Socket.prototype.on = originalOn;
    client.close();
    await broker.stop();
  }
});

test("M3 fake Pi control routing has no offline queue", async () => {
  const fake = new FakePi(
    assignment.agentId,
    assignment.generation,
    assignment.piSessionId,
  );
  const router = new PiControlRouter();
  router.register(assignment.agentId, fake.adapter);
  router.unregister(assignment.agentId);

  const disconnectedControls = [
    () => router.prompt(assignment.agentId, "must not queue"),
    () => router.steer(assignment.agentId, "must not queue"),
    () => router.followUp(assignment.agentId, "must not queue"),
    () => router.abort(assignment.agentId),
    () => router.compact(assignment.agentId),
    () => router.setModel(assignment.agentId, "fake", "fake-model"),
    () => router.setThinking(assignment.agentId, "medium"),
    () => router.setTools(assignment.agentId, []),
  ];

  for (const control of disconnectedControls) {
    await assert.rejects(control, /AGENT_DISCONNECTED/);
  }
  assert.deepEqual(fake.sentMessages, []);
});
