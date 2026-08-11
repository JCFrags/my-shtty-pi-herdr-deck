import assert from "node:assert/strict";
import test from "node:test";
import { ResultService } from "../../src/results/service.js";
import type { QuestionBody, RunBinding } from "../../src/results/types.js";

const run: RunBinding = {
  runId: "run_question_race",
  taskId: "task_question_race",
  agentId: "agent_question_race",
  assignmentGeneration: 1,
  state: "working",
  piSettled: false,
  resultRecoveryCount: 0,
};

const question: QuestionBody = {
  schemaVersion: 1,
  prompt: "Choose an option",
  context: null,
  options: [
    { id: "accept", label: "Accept", description: null },
    { id: "reject", label: "Reject", description: null },
  ],
  allowFreeform: false,
  defaultOptionId: "accept",
  timeoutMs: 10000,
};

async function openQuestion(): Promise<{
  service: ResultService;
  questionId: string;
}> {
  const service = new ResultService();
  await service.registerRun({ ...run });
  const opened = await service.ask({ ...run, body: question });
  return { service, questionId: opened.id };
}

test("concurrent answers accept exactly one winner", async () => {
  const { service, questionId } = await openQuestion();
  const outcomes = await Promise.allSettled([
    service.answer(questionId, { optionId: "accept" }, "parent-a"),
    service.answer(questionId, { optionId: "reject" }, "parent-b"),
  ]);

  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "rejected").length,
    1,
  );
  assert.equal(service.getQuestion(questionId).state, "answered");
  assert.equal(service.runs.get(run.runId)?.state, "working");
});

test("timeout resolves the waiter and fails the blocked run", async () => {
  const { service, questionId } = await openQuestion();
  const waiting = service.waitForAnswer(questionId, 10);
  const answered = await waiting;

  assert.equal(answered.state, "timed_out");
  assert.equal(service.getQuestion(questionId).state, "timed_out");
  assert.equal(service.runs.get(run.runId)?.state, "failed");
  assert.equal(service.events.at(-1)?.type, "question.timed_out");
});

test("an answer after timeout is rejected as a late answer", async () => {
  const { service, questionId } = await openQuestion();
  await service.timeout(questionId);

  await assert.rejects(
    service.answer(questionId, { optionId: "accept" }, "late-parent"),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Question is already terminal.",
  );
  assert.equal(service.getQuestion(questionId).state, "timed_out");
});

test("answer releases the waiter with the same terminal question record", async () => {
  const { service, questionId } = await openQuestion();
  const waiting = service.waitForAnswer(questionId, 10000);
  const accepted = await service.answer(
    questionId,
    { optionId: "reject" },
    "parent",
  );
  const released = await waiting;

  assert.deepEqual(released, accepted);
  assert.equal(released.answer?.optionId, "reject");
  assert.equal(released.state, "answered");
});
