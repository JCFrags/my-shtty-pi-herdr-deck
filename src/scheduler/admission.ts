import {
  DeterministicScheduler,
  findReusableAgent as findFrozenReusableAgent,
  type Admission,
} from "./scheduler.js";
import type { ReuseCandidate, ReuseRequest, SchedulerTask } from "./types.js";

/** A read-only admission result that keeps scheduler policy in one place. */
export interface AdmissionPlan {
  readonly decisions: readonly Admission[];
  readonly admittedTaskIds: readonly string[];
  readonly blockedTaskIds: readonly string[];
}

/**
 * Evaluate queued work without changing scheduler state.
 *
 * The scheduler remains the source of truth for ordering, dependencies, and
 * limits. This wrapper only projects the result for broker callers.
 */
export function planAdmission(
  scheduler: DeterministicScheduler,
  tasks?: ReadonlyMap<string, SchedulerTask>,
): AdmissionPlan {
  const decisions = scheduler.admitReady(tasks);
  return {
    decisions,
    admittedTaskIds: decisions
      .filter((decision) => decision.admitted)
      .map((decision) => decision.taskId),
    blockedTaskIds: decisions
      .filter((decision) => !decision.admitted)
      .map((decision) => decision.taskId),
  };
}

/** Return true only when every reuse identity and lifecycle condition matches. */
export function isReusableCandidate(
  request: ReuseRequest,
  candidate: ReuseCandidate,
): boolean {
  return (
    candidate.idle &&
    !candidate.cleanupPending &&
    candidate.profileId === request.profileId &&
    candidate.projectKey === request.projectKey &&
    candidate.worktreeKey === request.worktreeKey &&
    candidate.trustKey === request.trustKey &&
    candidate.toolPolicyHash === request.toolPolicyHash &&
    candidate.modelPolicyHash === request.modelPolicyHash
  );
}

/**
 * Select the stable, deterministic compatible idle agent.
 *
 * Reuse is opt-in at the caller. This function never relaxes policy identity
 * or reuses an agent with pending cleanup.
 */
export function selectReusableAgent(
  request: ReuseRequest,
  candidates: readonly ReuseCandidate[],
): string | undefined {
  return findFrozenReusableAgent(
    request,
    candidates.filter((candidate) => isReusableCandidate(request, candidate)),
  );
}

/** Keep the frozen scheduler type available to callers that only import this module. */
export type { Admission } from "./scheduler.js";
