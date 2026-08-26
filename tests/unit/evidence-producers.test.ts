import assert from "node:assert/strict";
import test from "node:test";
import {
  automaticEvidenceForRun,
  correctedHumanEvidence,
  humanEvidenceForRun,
  independentReviewEvidence,
  modelFamily,
  runtimeSubjectForRun,
} from "../../src/model-intelligence/evidence-producers.js";
import { createId } from "../../src/shared/ids.js";
import { emptyState, reduce } from "../../src/state/reducer.js";
import type {
  ModelEvidenceRecord,
  ModelLifecycleEvidence,
  ModelScoreEvidence,
} from "../../src/model-intelligence/model-evidence.js";
import type {
  Agent,
  OrchestrationState,
  Run,
  Task,
} from "../../src/state/types.js";

function lifecycleRecord(
  record: ModelEvidenceRecord | undefined,
): ModelLifecycleEvidence {
  assert.equal(record?.evidenceKind, "lifecycle");
  return record as ModelLifecycleEvidence;
}

function scoreRecord(
  record: ModelEvidenceRecord | undefined,
): ModelScoreEvidence {
  assert.equal(record?.evidenceKind, "score");
  return record as ModelScoreEvidence;
}

const taskId = createId("tsk");
const runId = createId("run");
const agentId = createId("agt");
const reviewerAgentId = createId("agt");
const resultId = createId("res");
const reviewContractId = createId("rvc");

const task: Task = {
  id: taskId,
  title: "test",
  objective: "test",
  state: "succeeded",
  createdAt: "2026-08-26T12:00:00.000Z",
  profileId: "reviewer",
};
const agent: Agent = {
  id: agentId,
  state: "idle",
  generation: 1,
  actualModel: {
    provider: "local",
    modelId: "qwen3",
    thinkingLevel: "high",
  },
};
const run: Run = {
  id: runId,
  taskId: task.id,
  agentId: agent.id,
  assignmentGeneration: 1,
  endpointId: "local_one",
  state: "succeeded",
  startedAt: "2026-08-26T12:00:00.000Z",
  terminalAt: "2026-08-26T12:01:00.000Z",
  settled: true,
};

function state(): OrchestrationState {
  return {
    ...emptyState(),
    tasks: { [task.id]: { ...task } },
    agents: { [agent.id]: { ...agent } },
    runs: { [run.id]: { ...run } },
  };
}

test("automatic producers require an attested endpoint runtime and emit deterministic lifecycle and speed evidence", () => {
  const current = state();
  assert.deepEqual(runtimeSubjectForRun(current, run), {
    kind: "runtime",
    provider: "local",
    modelId: "qwen3",
    thinkingLevel: "high",
    endpointId: "local_one",
  });
  const records = automaticEvidenceForRun(current, run);
  assert.equal(records.length, 2);
  const lifecycle = lifecycleRecord(records[0]);
  const speed = scoreRecord(records[1]);
  assert.equal(lifecycle.sourceKind, "broker_lifecycle");
  assert.equal(lifecycle.outcome, "completed");
  assert.deepEqual(lifecycle.binding, { kind: "run", runId: run.id });
  assert.equal(speed.sourceKind, "broker_measurement");
  assert.equal(speed.dimension, "speed");
  assert.equal(speed.valuePpm, 983_050);
  assert.deepEqual(
    automaticEvidenceForRun(current, run).map((item) => item.evidenceId),
    records.map((item) => item.evidenceId),
  );

  const missingIdentity = state();
  delete missingIdentity.agents[agent.id]!.actualModel;
  assert.deepEqual(automaticEvidenceForRun(missingIdentity, run), []);
  const missingTerminal = { ...run };
  delete missingTerminal.terminalAt;
  assert.deepEqual(automaticEvidenceForRun(current, missingTerminal), []);
});

test("automatic producer maps terminal failures without inventing speed measurements", () => {
  const current = state();
  const failed: Run = {
    ...run,
    state: "failed",
    terminalReason: {
      code: "RESULT_MISSING",
      message: "The managed result was not published.",
    },
  };
  const records = automaticEvidenceForRun(current, failed);
  assert.equal(records.length, 1);
  const lifecycle = lifecycleRecord(records[0]);
  assert.equal(lifecycle.outcome, "result_missing");
});

test("model family uses an explicit canonical mapping and otherwise keeps provider identity", () => {
  const qwen = { provider: "local", modelId: "qwen3" };
  assert.equal(modelFamily(qwen, {}), "runtime:local/qwen3");
  const policy = {
    mappings: [
      {
        provider: "local",
        modelId: "qwen3",
        endpointId: "local_one",
        canonicalModelId: "qwen/qwen3",
      },
      {
        provider: "openrouter",
        modelId: "qwen/qwen3",
        endpointId: "remote",
        canonicalModelId: "qwen/qwen3",
      },
    ],
  };
  assert.equal(modelFamily(qwen, policy), "canonical:qwen/qwen3");
  assert.equal(
    modelFamily({ provider: "openrouter", modelId: "qwen/qwen3" }, policy),
    "canonical:qwen/qwen3",
  );
});

test("independent review evidence freezes reviewer, result, rubric, profile, and reviewed runtime", () => {
  const current = state();
  const record = independentReviewEvidence({
    state: current,
    reviewedRun: run,
    sourceKey: reviewContractId,
    reviewerAgentId,
    reviewerModelFamily: "canonical:openai/gpt",
    resultId,
    resultDigest: "a".repeat(64),
    rubricVersion: "quality-v1",
    valuePpm: 750_000,
    confidencePpm: 800_000,
    observedAt: "2026-08-26T13:00:00.000Z",
  });
  assert.equal(record.taskProfile, "reviewer");
  assert.equal(record.sourceKind, "independent_review");
  const score = scoreRecord(record);
  assert.equal(score.dimension, "reviewed_output_quality");
  assert.deepEqual(record.binding, {
    kind: "review",
    taskId: task.id,
    runId: run.id,
    resultId,
    reviewerAgentId,
    reviewerModelFamily: "canonical:openai/gpt",
    resultDigest: "a".repeat(64),
    rubricVersion: "quality-v1",
  });
  assert.deepEqual(record.subject, runtimeSubjectForRun(current, run));
});

test("human corrections retain authority identity and produce a new immutable evidence ID", () => {
  const prior = humanEvidenceForRun({
    state: state(),
    run,
    sourceName: "operator:prn_test",
    sourceKey: "human-v1:test",
    dimension: "preference",
    valuePpm: 400_000,
    confidencePpm: 500_000,
    observedAt: "2026-08-26T13:00:00.000Z",
  });
  const replacement = correctedHumanEvidence(prior, {
    valuePpm: 900_000,
    confidencePpm: 700_000,
    observedAt: "2026-08-26T14:00:00.000Z",
  });
  assert.notEqual(replacement.evidenceId, prior.evidenceId);
  assert.equal(replacement.sourceKind, "human");
  const score = scoreRecord(replacement);
  assert.equal(replacement.sourceName, prior.sourceName);
  assert.equal(replacement.sourceKey, prior.sourceKey);
  assert.equal(replacement.taskProfile, prior.taskProfile);
  assert.deepEqual(replacement.subject, prior.subject);
  assert.equal(score.valuePpm, 900_000);
  assert.throws(
    () =>
      correctedHumanEvidence(
        independentReviewEvidence({
          state: state(),
          reviewedRun: run,
          sourceKey: reviewContractId,
          reviewerAgentId,
          reviewerModelFamily: "runtime:other/model",
          resultId,
          resultDigest: "b".repeat(64),
          rubricVersion: "quality-v1",
          valuePpm: 1,
          confidencePpm: 1,
          observedAt: "2026-08-26T13:00:00.000Z",
        }),
        {
          valuePpm: 1,
          confidencePpm: 1,
          observedAt: "2026-08-26T14:00:00.000Z",
        },
      ),
    /Only active human score evidence/,
  );
});

test("run timestamps come from durable event timestamps and survive terminal replay", () => {
  let current = emptyState();
  current = {
    ...current,
    tasks: {
      [taskId]: {
        ...task,
        state: "queued",
        timeoutAt: "2026-08-26T13:00:00.000Z",
      },
    },
    agents: { [agentId]: { ...agent } },
  };
  current = reduce(current, {
    type: "run.created",
    actor: { principalId: "prn_test", kind: "system" },
    entityRefs: { taskId, runId, agentId },
    payload: {
      runId,
      taskId,
      agentId,
      assignmentId: "asn_test",
      assignmentGeneration: 1,
      agentGeneration: 1,
      timeoutAt: "2026-08-26T13:00:00.000Z",
      endpointId: "local_one",
    },
    timestamp: "2026-08-26T12:00:10.000Z",
  } as never);
  assert.equal(current.runs[runId]?.startedAt, "2026-08-26T12:00:10.000Z");
  current = reduce(current, {
    type: "run.state_changed",
    actor: { principalId: "prn_test", kind: "system" },
    entityRefs: { taskId, runId },
    payload: { runId, state: "succeeded" },
    timestamp: "2026-08-26T12:02:10.000Z",
  } as never);
  assert.equal(current.runs[runId]?.terminalAt, "2026-08-26T12:02:10.000Z");
  const replay = reduce(current, {
    type: "run.state_changed",
    actor: { principalId: "prn_test", kind: "system" },
    entityRefs: { taskId, runId },
    payload: { runId, state: "succeeded" },
    timestamp: "2026-08-26T12:02:10.000Z",
  } as never);
  assert.equal(replay.runs[runId]?.terminalAt, "2026-08-26T12:02:10.000Z");
});
