import assert from "node:assert/strict";
import test from "node:test";
import { LifecycleCorrelator } from "../../src/pi/correlation.js";
import { renderAssignment } from "../../src/pi/adapter.js";
import { PiControlRouter } from "../../src/pi/controls.js";
import { registerManagedChildTools } from "../../src/pi/tools.js";
import type {
  PiAssignment,
  PiControl,
  PiSafeState,
} from "../../src/pi/types.js";
const assignment: PiAssignment = {
  id: "asg_01J00000000000000000000000",
  taskId: "tsk_01J00000000000000000000000",
  runId: "run_01J00000000000000000000000",
  agentId: "agt_01J00000000000000000000000",
  generation: 1,
  assignmentGeneration: 1,
  piSessionId: "session-1",
  objective: "Use the fake adapter",
  constraints: ["No live process"],
  deadline: "2030-01-01T00:00:00.000Z",
};
const safe: PiSafeState = {
  agentId: assignment.agentId,
  generation: 1,
  sessionId: "session-1",
  idle: true,
  pendingMessages: 0,
  activity: "idle",
  activeTools: [],
  capabilities: {
    core: true,
    prompt: true,
    steer: true,
    followUp: true,
    abort: true,
    compact: true,
    model: true,
    thinking: true,
    tools: true,
    toolExpansion: false,
  },
};
test("M3 correlator binds only the exact next Pi lifecycle", () => {
  const c = new LifecycleCorrelator();
  assert.equal(c.deliver(assignment, safe), "accepted");
  c.markCustomEntryWritten();
  c.accept();
  assert.equal(
    c.lifecycle({
      type: "turn_start",
      agentId: assignment.agentId,
      generation: 1,
      piSessionId: "session-1",
      assignmentGeneration: 1,
      agentCycleId: "cycle-1",
      turnIndex: 4,
    }),
    "bound",
  );
  assert.equal(
    c.lifecycle({
      type: "agent_settled",
      agentId: assignment.agentId,
      generation: 1,
      piSessionId: "session-1",
      assignmentGeneration: 1,
      agentCycleId: "cycle-1",
      turnIndex: 4,
    }),
    "settled",
  );
});
test("M3 correlator rejects stale session and manual activity", () => {
  const c = new LifecycleCorrelator();
  assert.throws(
    () => c.deliver(assignment, { ...safe, sessionId: "other" }),
    /PI_IDENTITY_MISMATCH/,
  );
  assert.equal(
    c.lifecycle({
      type: "turn_start",
      agentId: assignment.agentId,
      generation: 1,
      piSessionId: "session-1",
      assignmentGeneration: 1,
      agentCycleId: "manual",
      turnIndex: 1,
    }),
    "manual",
  );
});
test("M3 assignment rendering excludes secrets and transcript text", () => {
  const message = renderAssignment(assignment);
  assert.match(message, /Managed Orchestrator Task/);
  assert.doesNotMatch(message, /token|session-1/);
});
test("M3 orchestrator_ask settles when the waiter terminalizes before open acknowledgement", async () => {
  const tools: Array<{
    name: string;
    execute: (...args: any[]) => Promise<unknown>;
  }> = [];
  const pendingOpen = new Promise<never>(() => undefined);
  const client = {
    connected: true,
    request: async () => pendingOpen,
    registerQuestionWaiter: async () => ({ state: "cancelled" as const }),
    discardQuestionWaiter: () => undefined,
  } as never;
  registerManagedChildTools(
    {
      registerTool: (tool: unknown) =>
        tools.push(tool as (typeof tools)[number]),
    } as never,
    {
      assignmentForTools: () => ({ ...assignment, assignmentGeneration: 2 }),
    } as never,
    client,
  );
  const ask = tools.find((tool) => tool.name === "orchestrator_ask");
  assert.ok(ask);
  const result = await Promise.race([
    ask.execute(
      "call-1",
      {
        schemaVersion: 1,
        prompt: "Choose",
        context: null,
        options: [],
        allowFreeform: true,
        defaultOptionId: null,
        timeoutMs: 10_000,
      },
      new AbortController().signal,
      undefined,
      {},
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("QUESTION_OPEN_HUNG")), 100),
    ),
  ]);
  assert.match(JSON.stringify(result), /cancelled/);
});

test("M3 controls reject disconnected agents and never queue commands", async () => {
  const router = new PiControlRouter();
  await assert.rejects(
    () => router.prompt(assignment.agentId, "hello"),
    /AGENT_DISCONNECTED/,
  );
  const calls: string[] = [];
  const control: PiControl = {
    prompt: async () => {
      calls.push("prompt");
    },
    steer: async () => {
      calls.push("steer");
    },
    followUp: async () => {
      calls.push("follow");
    },
    abort: async () => {
      calls.push("abort");
    },
    compact: async () => {
      calls.push("compact");
    },
    setModel: async () => {
      calls.push("model");
    },
    setThinking: async () => {
      calls.push("thinking");
    },
    setTools: async () => {
      calls.push("tools");
    },
    expandTool: async () => {
      calls.push("expand");
    },
  };
  router.register(assignment.agentId, control);
  await router.prompt(assignment.agentId, "hello");
  assert.deepEqual(calls, ["prompt"]);
  router.unregister(assignment.agentId);
  await assert.rejects(
    () => router.prompt(assignment.agentId, "retry"),
    /AGENT_DISCONNECTED/,
  );
});
