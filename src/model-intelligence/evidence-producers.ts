import type { EndpointPolicyConfig } from "../broker/endpoint-policy.js";
import type { OrchestrationState, Run } from "../state/types.js";
import {
  normalizeModelEvidence,
  type ModelEvidenceRecord,
  type ModelLifecycleOutcome,
  type ModelScoreDimension,
  type RuntimeModelSubject,
} from "./model-evidence.js";

export const MODEL_EVIDENCE_PRODUCER_POLICY = Object.freeze({
  version: 1 as const,
  expiresAfterMs: 365 * 86_400_000,
  speedFastMs: 30_000,
  speedSlowMs: 30 * 60_000,
});

function expiresAt(observedAt: string): string {
  return new Date(
    Date.parse(observedAt) + MODEL_EVIDENCE_PRODUCER_POLICY.expiresAfterMs,
  ).toISOString();
}

export function runtimeSubjectForRun(
  state: OrchestrationState,
  run: Run,
): RuntimeModelSubject | undefined {
  const model = run.agentId
    ? state.agents[run.agentId]?.actualModel
    : undefined;
  if (
    !model?.provider ||
    !model.modelId ||
    !model.thinkingLevel ||
    !run.endpointId
  )
    return undefined;
  return {
    kind: "runtime",
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel: model.thinkingLevel,
    endpointId: run.endpointId,
  };
}

export function modelFamily(
  subject: Pick<RuntimeModelSubject, "provider" | "modelId">,
  policy: EndpointPolicyConfig,
): string {
  const mapping = policy.mappings?.find(
    (item) =>
      item.provider === subject.provider && item.modelId === subject.modelId,
  );
  return mapping?.canonicalModelId
    ? `canonical:${mapping.canonicalModelId}`
    : `runtime:${subject.provider}/${subject.modelId}`;
}

function lifecycleOutcome(run: Run): ModelLifecycleOutcome | undefined {
  if (run.terminalReason?.code === "RESULT_MISSING") return "result_missing";
  if (run.state === "succeeded") return "completed";
  if (run.state === "timed_out") return "timed_out";
  if (run.state === "lost") return "lost";
  if (run.state === "failed") return "adapter_failed";
  return undefined;
}

export function automaticEvidenceForRun(
  state: OrchestrationState,
  run: Run,
): ModelEvidenceRecord[] {
  const task = state.tasks[run.taskId];
  const subject = runtimeSubjectForRun(state, run);
  const outcome = lifecycleOutcome(run);
  if (!task?.profileId || !subject || !outcome || !run.terminalAt) return [];
  const records: ModelEvidenceRecord[] = [
    normalizeModelEvidence({
      schemaVersion: 1,
      evidenceKind: "lifecycle",
      sourceKind: "broker_lifecycle",
      sourceName: "broker-terminal-v1",
      sourceKey: run.id,
      taskProfile: task.profileId,
      subject,
      sampleCount: 1,
      observedAt: run.terminalAt,
      expiresAt: expiresAt(run.terminalAt),
      binding: { kind: "run", runId: run.id },
      outcome,
    }),
  ];
  if (outcome === "completed" && run.startedAt) {
    const duration = Date.parse(run.terminalAt) - Date.parse(run.startedAt);
    if (Number.isSafeInteger(duration) && duration >= 0) {
      const { speedFastMs, speedSlowMs } = MODEL_EVIDENCE_PRODUCER_POLICY;
      const valuePpm =
        duration <= speedFastMs
          ? 1_000_000
          : duration >= speedSlowMs
            ? 0
            : Math.floor(
                ((speedSlowMs - duration) * 1_000_000) /
                  (speedSlowMs - speedFastMs),
              );
      records.push(
        normalizeModelEvidence({
          schemaVersion: 1,
          evidenceKind: "score",
          sourceKind: "broker_measurement",
          sourceName: "broker-wall-speed-v1",
          sourceKey: run.id,
          taskProfile: task.profileId,
          subject,
          sampleCount: 1,
          observedAt: run.terminalAt,
          expiresAt: expiresAt(run.terminalAt),
          binding: { kind: "run", runId: run.id },
          dimension: "speed",
          valuePpm,
          confidencePpm: 1_000_000,
        }),
      );
    }
  }
  return records;
}

export function humanEvidenceForRun(input: {
  state: OrchestrationState;
  run: Run;
  sourceName: string;
  sourceKey: string;
  dimension: "preference" | "reviewed_output_quality";
  valuePpm: number;
  confidencePpm: number;
  observedAt: string;
  expiresAt?: string;
}): ModelEvidenceRecord {
  const task = input.state.tasks[input.run.taskId];
  const subject = runtimeSubjectForRun(input.state, input.run);
  if (!task?.profileId || !subject)
    throw new Error("The rated run has no attested runtime identity.");
  return normalizeModelEvidence({
    schemaVersion: 1,
    evidenceKind: "score",
    sourceKind: "human",
    sourceName: input.sourceName,
    sourceKey: input.sourceKey,
    taskProfile: task.profileId,
    subject,
    sampleCount: 1,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt ?? expiresAt(input.observedAt),
    dimension: input.dimension,
    valuePpm: input.valuePpm,
    confidencePpm: input.confidencePpm,
  });
}

export function independentReviewEvidence(input: {
  state: OrchestrationState;
  reviewedRun: Run;
  sourceKey: string;
  reviewerAgentId: string;
  reviewerModelFamily: string;
  resultId: string;
  resultDigest: string;
  rubricVersion: string;
  valuePpm: number;
  confidencePpm: number;
  observedAt: string;
}): ModelEvidenceRecord {
  const task = input.state.tasks[input.reviewedRun.taskId];
  const subject = runtimeSubjectForRun(input.state, input.reviewedRun);
  if (!task?.profileId || !subject)
    throw new Error("The reviewed run has no attested runtime identity.");
  return normalizeModelEvidence({
    schemaVersion: 1,
    evidenceKind: "score",
    sourceKind: "independent_review",
    sourceName: "broker-review-contract-v1",
    sourceKey: input.sourceKey,
    taskProfile: task.profileId,
    subject,
    sampleCount: 1,
    observedAt: input.observedAt,
    expiresAt: expiresAt(input.observedAt),
    binding: {
      kind: "review",
      taskId: task.id,
      runId: input.reviewedRun.id,
      resultId: input.resultId,
      reviewerAgentId: input.reviewerAgentId,
      reviewerModelFamily: input.reviewerModelFamily,
      resultDigest: input.resultDigest,
      rubricVersion: input.rubricVersion,
    },
    dimension: "reviewed_output_quality",
    valuePpm: input.valuePpm,
    confidencePpm: input.confidencePpm,
  });
}

export function correctedHumanEvidence(
  prior: ModelEvidenceRecord,
  input: {
    valuePpm: number;
    confidencePpm: number;
    observedAt: string;
    expiresAt?: string;
  },
): ModelEvidenceRecord {
  if (prior.sourceKind !== "human" || prior.evidenceKind !== "score")
    throw new Error("Only active human score evidence can be corrected.");
  return normalizeModelEvidence({
    schemaVersion: 1,
    evidenceKind: "score",
    sourceKind: "human",
    sourceName: prior.sourceName,
    sourceKey: prior.sourceKey,
    taskProfile: prior.taskProfile,
    subject: prior.subject,
    sampleCount: 1,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt ?? expiresAt(input.observedAt),
    dimension: prior.dimension as ModelScoreDimension,
    valuePpm: input.valuePpm,
    confidencePpm: input.confidencePpm,
  });
}
