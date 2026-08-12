import assert from "node:assert/strict";
import test from "node:test";
import { registerManagedChildTools } from "../../src/pi/tools.js";

const assignment = {
  id: "asg",
  taskId: "task",
  runId: "run",
  agentId: "agent",
  generation: 1,
  assignmentGeneration: 1,
  piSessionId: "session",
  objective: "test",
  constraints: [],
  deadline: "2030-01-01T00:00:00Z",
};
const question = {
  schemaVersion: 1,
  prompt: "Choose",
  context: null,
  options: [],
  allowFreeform: true,
  defaultOptionId: null,
  timeoutMs: 10_000,
};

function setup(request: () => Promise<unknown>) {
  const tools: Array<{
    name: string;
    execute: (...args: never[]) => Promise<unknown>;
  }> = [];
  const events: Array<{ event: string; data: unknown }> = [];
  const api = {
    registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
    events: {
      emit: (event: string, data: unknown) => events.push({ event, data }),
    },
  };
  const adapter = { assignmentForTools: () => assignment };
  const client = {
    connected: true,
    request,
    registerQuestionWaiter: () => new Promise(() => undefined),
    discardQuestionWaiter: () => undefined,
  };
  registerManagedChildTools(api as never, { adapter, client } as never);
  return {
    ask: tools.find((tool) => tool.name === "orchestrator_ask")!,
    events,
  };
}

test("managed broker questions project and clear Herdr blocked state", async () => {
  const state = setup(async () => ({
    questionId: "q-1",
    runId: "run",
    assignmentGeneration: 1,
    toolCallId: "call",
    state: "answered",
    answer: { optionId: null, text: "answer" },
  }));
  await (
    state.ask.execute as unknown as (...args: unknown[]) => Promise<unknown>
  )("call", question, AbortSignal.timeout(1000), undefined, {});
  assert.deepEqual(state.events, [
    {
      event: "herdr:blocked",
      data: { active: true, label: "Waiting for an orchestrator answer" },
    },
    { event: "herdr:blocked", data: { active: false } },
  ]);
});

test("managed broker questions clear Herdr blocked state after broker failure", async () => {
  const state = setup(async () => {
    throw new Error("BROKER_FAILED");
  });
  await assert.rejects(
    () =>
      (
        state.ask.execute as unknown as (...args: unknown[]) => Promise<unknown>
      )("call", question, AbortSignal.timeout(1000), undefined, {}),
    /BROKER_FAILED/,
  );
  assert.equal(state.events.length, 2);
  assert.deepEqual(state.events.at(-1), {
    event: "herdr:blocked",
    data: { active: false },
  });
});
