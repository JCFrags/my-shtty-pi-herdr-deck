import assert from "node:assert/strict";
import test from "node:test";
import { PiControlRouter } from "../../src/pi/controls.js";
import type { PiAssignment } from "../../src/pi/types.js";
import { FakePi, withTimeout } from "../helpers/m3-fake-pi.js";

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
  fake.releasePrompt();
  assert.equal(
    await fake.adapter.deliver({
      ...assignment,
      id: "asg_01J00000000000000000000001",
    }),
    "accepted",
  );
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

  await assert.rejects(
    router.prompt(assignment.agentId, "must not queue"),
    /AGENT_DISCONNECTED/,
  );
  assert.deepEqual(fake.sentMessages, []);
});
