import assert from "node:assert/strict";
import test from "node:test";
import {
  ManagedChildTools,
  ParentResultTools,
} from "../../src/results/tools.js";
import { ResultService } from "../../src/results/service.js";
import type { ResultBody, RunBinding } from "../../src/results/types.js";

const run: RunBinding = {
  runId: "run_01J00000000000000000000000",
  taskId: "tsk_01J00000000000000000000000",
  agentId: "agt_01J00000000000000000000000",
  assignmentGeneration: 1,
  state: "working",
  piSettled: false,
  resultRecoveryCount: 0,
};

const result: ResultBody = {
  schemaVersion: 1,
  status: "succeeded",
  summary: "fake child completed the task",
  findings: [],
  changedFiles: [],
  commandsRun: [{ command: "npm test", exitCode: 0, outcome: "passed" }],
  tests: [
    {
      name: "fake integration",
      command: "npm test",
      status: "passed",
      passed: 1,
      failed: 0,
      skipped: 0,
      evidence: null,
    },
  ],
  commits: [],
  artifacts: [],
  unresolved: [],
  questions: [],
  recommendedNextAction: null,
};

const question = {
  schemaVersion: 1 as const,
  prompt: "Select the recovery action.",
  context: "The fake child needs parent input.",
  options: [
    { id: "retry", label: "Retry", description: null },
    { id: "stop", label: "Stop", description: null },
  ],
  allowFreeform: false,
  defaultOptionId: "retry",
  timeoutMs: 10_000,
};

class FakeResultStack {
  constructor(readonly service: ResultService) {}

  async publish(body: ResultBody) {
    return this.service.publish({ ...run, body });
  }

  async terminal(error = false) {
    return this.service.settle(run.runId, error);
  }
}

test("fake stack accepts result before the terminal settle event", async () => {
  const stack = new FakeResultStack(new ResultService());
  await stack.service.registerRun({ ...run });

  const published = await stack.publish(result);
  assert.equal(published.state, "result_pending");
  assert.equal((await stack.terminal()).state, "succeeded");

  const stored = stack.service.getResult(published.resultId);
  assert.equal(stored.validation.piSettled, true);
  assert.equal(stack.service.runs.get(run.runId)?.state, "succeeded");
});

test("fake stack recovers a result published after settle-before-result", async () => {
  let recoveryRequests = 0;
  const stack = new FakeResultStack(
    new ResultService({
      recover: async () => {
        recoveryRequests += 1;
      },
    }),
  );
  await stack.service.registerRun({
    ...run,
    runId: "run_01J00000000000000000000001",
    taskId: "tsk_01J00000000000000000000001",
  });
  const recoveryRun = stack.service.runs.get("run_01J00000000000000000000001");
  assert.ok(recoveryRun);

  const settled = await stack.service.settle(recoveryRun.runId);
  assert.equal(settled.state, "result_pending_missing");
  assert.equal(recoveryRequests, 1);

  const recovered = await stack.service.publish({
    ...recoveryRun,
    body: result,
  });
  assert.equal(recovered.state, "succeeded");
  assert.equal(
    stack.service.getResult(recovered.resultId).validation.piSettled,
    true,
  );
});

test("structured question blocks the child and releases the answer waiter", async () => {
  const service = new ResultService();
  await service.registerRun({
    ...run,
    runId: "run_01J00000000000000000000002",
    taskId: "tsk_01J00000000000000000000002",
  });
  const childRun = service.runs.get("run_01J00000000000000000000002");
  assert.ok(childRun);
  const child = new ManagedChildTools(service);
  const parent = new ParentResultTools(service);

  const answerPromise = child.orchestratorAsk(
    { run: childRun, principalId: "agt_child" },
    question,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const open = service.events.find((event) => event.type === "question.opened");
  assert.ok(open);
  const questionId = open.refs.questionId;
  assert.ok(questionId);
  assert.equal(service.runs.get(childRun.runId)?.state, "blocked");

  const answered = await parent.answer(
    { run: childRun, principalId: "prn_parent" },
    questionId,
    { optionId: "retry" },
  );
  assert.equal(answered.state, "answered");
  const childResult = await answerPromise;
  assert.deepEqual(childResult, {
    questionId,
    answer: { optionId: "retry" },
    state: "answered",
  });
  assert.equal(service.runs.get(childRun.runId)?.state, "working");
});

test("late terminal events do not reopen a completed run or permit a late result", async () => {
  const stack = new FakeResultStack(new ResultService());
  await stack.service.registerRun({ ...run });
  const lateRun = stack.service.runs.get(run.runId);
  assert.ok(lateRun);
  const published = await stack.publish(result);
  await stack.service.settle(lateRun.runId);
  await assert.rejects(() => stack.service.settle(lateRun.runId), {
    code: "RUN_MISMATCH",
  });
  assert.equal(stack.service.runs.get(lateRun.runId)?.state, "succeeded");
  await assert.rejects(() => stack.publish(result), { code: "RUN_MISMATCH" });
  assert.equal(
    stack.service.getResult(published.resultId).summary,
    result.summary,
  );
});
