export type SchedulerPriority = "low" | "normal" | "high";
export type SchedulableState =
  | "queued"
  | "provisioning"
  | "running"
  | "blocked"
  | "collecting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface SchedulerDependency {
  readonly taskId: string;
  readonly requirement: "succeeded" | "terminal";
}

export interface SchedulerTask {
  readonly id: string;
  readonly parentAgentId: string;
  readonly profileId: string;
  readonly priority: SchedulerPriority;
  readonly queuedAt: number;
  readonly depth: number;
  readonly dependencies: readonly SchedulerDependency[];
  readonly state: SchedulableState;
  readonly endpointId?: string;
  readonly projectKey?: string;
  readonly worktreeKey?: string;
  readonly allowReuse?: boolean;
}

export interface SchedulerLimits {
  readonly maxActiveAgents: number;
  readonly maxActivePerParent: number;
  readonly maxQueuedTasks: number;
  readonly maxTasksPerDelegate: number;
  readonly maxDelegationDepth: number;
  readonly maxProvisioning: number;
}

export const DEFAULT_SCHEDULER_LIMITS: SchedulerLimits = Object.freeze({
  maxActiveAgents: 4,
  maxActivePerParent: 4,
  maxQueuedTasks: 32,
  maxTasksPerDelegate: 8,
  maxDelegationDepth: 2,
  maxProvisioning: 2,
});

export const HARD_SCHEDULER_LIMITS: SchedulerLimits = Object.freeze({
  maxActiveAgents: 32,
  maxActivePerParent: 16,
  maxQueuedTasks: 1_000,
  maxTasksPerDelegate: 32,
  maxDelegationDepth: 4,
  maxProvisioning: 8,
});

export interface ReuseCandidate {
  readonly agentId: string;
  readonly profileId: string;
  readonly projectKey?: string;
  readonly worktreeKey?: string;
  readonly trustKey: string;
  readonly toolPolicyHash: string;
  readonly modelPolicyHash: string;
  readonly cleanupPending: boolean;
  readonly idle: boolean;
}

export interface ReuseRequest {
  readonly profileId: string;
  readonly projectKey?: string;
  readonly worktreeKey?: string;
  readonly trustKey: string;
  readonly toolPolicyHash: string;
  readonly modelPolicyHash: string;
}
