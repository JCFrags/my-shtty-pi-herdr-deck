import {
  DEFAULT_SCHEDULER_LIMITS,
  HARD_SCHEDULER_LIMITS,
  type ReuseCandidate,
  type ReuseRequest,
  type SchedulerLimits,
  type SchedulerTask,
} from "./types.js";

export type AdmissionReason =
  | "admitted"
  | "global_limit"
  | "parent_limit"
  | "provisioning_limit"
  | "dependency_blocked"
  | "depth_exceeded"
  | "queue_full"
  | "not_queued";
export interface Admission {
  readonly taskId: string;
  readonly admitted: boolean;
  readonly reason: AdmissionReason;
}
export interface SchedulerSnapshot {
  readonly queued: readonly SchedulerTask[];
  readonly active: readonly SchedulerTask[];
  readonly provisioning: number;
}

function clampLimits(input: Partial<SchedulerLimits>): SchedulerLimits {
  const result = { ...DEFAULT_SCHEDULER_LIMITS };
  for (const key of Object.keys(input))
    if (!Object.hasOwn(result, key))
      throw new RangeError(`Unknown scheduler limit: ${key}.`);
  for (const key of Object.keys(result) as (keyof SchedulerLimits)[]) {
    const value = input[key];
    if (value !== undefined) {
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > HARD_SCHEDULER_LIMITS[key]
      )
        throw new RangeError(`Invalid scheduler limit: ${key}.`);
      result[key] = value;
    }
  }
  return result;
}
function priorityValue(priority: SchedulerTask["priority"]): number {
  return priority === "high" ? 0 : priority === "normal" ? 1 : 2;
}

export class DeterministicScheduler {
  readonly limits: SchedulerLimits;
  #tasks = new Map<string, SchedulerTask>();
  #provisioning = 0;
  constructor(limits: Partial<SchedulerLimits> = {}) {
    this.limits = clampLimits(limits);
  }
  enqueue(task: SchedulerTask): void {
    if (task.state !== "queued")
      throw new Error("Only queued tasks can enter the scheduler.");
    if (task.depth > this.limits.maxDelegationDepth)
      throw new Error("DELEGATION_DEPTH_EXCEEDED");
    const queued = [...this.#tasks.values()].filter(
      (item) => item.state === "queued",
    ).length;
    if (queued >= this.limits.maxQueuedTasks) throw new Error("QUEUE_FULL");
    if (this.#tasks.has(task.id)) throw new Error("TASK_ALREADY_QUEUED");
    this.#tasks.set(task.id, task);
  }
  replace(task: SchedulerTask): void {
    if (!this.#tasks.has(task.id)) throw new Error("TASK_NOT_FOUND");
    this.#tasks.set(task.id, task);
  }
  cancel(taskId: string): void {
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error("TASK_NOT_FOUND");
    this.#tasks.set(taskId, { ...task, state: "cancelled" });
  }
  admitReady(
    tasks: ReadonlyMap<string, SchedulerTask> = this.#tasks,
  ): Admission[] {
    const active = [...tasks.values()].filter((task) =>
      ["provisioning", "running", "blocked"].includes(task.state),
    );
    const activeByParent = new Map<string, number>();
    for (const task of active)
      activeByParent.set(
        task.parentAgentId,
        (activeByParent.get(task.parentAgentId) ?? 0) + 1,
      );
    let slots = Math.max(0, this.limits.maxActiveAgents - active.length);
    const available = [...tasks.values()]
      .filter((task) => task.state === "queued")
      .sort(
        (a, b) =>
          priorityValue(a.priority) - priorityValue(b.priority) ||
          a.queuedAt - b.queuedAt ||
          a.id.localeCompare(b.id),
      );
    const result: Admission[] = [];
    for (const task of available) {
      const dependencies = task.dependencies.map((dependency) => ({
        dependency,
        task: tasks.get(dependency.taskId),
      }));
      if (
        dependencies.some(
          ({ dependency, task: dependencyTask }) =>
            !dependencyTask ||
            (dependency.requirement === "succeeded"
              ? dependencyTask.state !== "succeeded"
              : !["succeeded", "failed", "cancelled", "timed_out"].includes(
                  dependencyTask.state,
                )),
        )
      ) {
        result.push({
          taskId: task.id,
          admitted: false,
          reason: "dependency_blocked",
        });
        continue;
      }
      if (task.depth > this.limits.maxDelegationDepth) {
        result.push({
          taskId: task.id,
          admitted: false,
          reason: "depth_exceeded",
        });
        continue;
      }
      if (!slots) {
        result.push({
          taskId: task.id,
          admitted: false,
          reason: "global_limit",
        });
        continue;
      }
      if (
        (activeByParent.get(task.parentAgentId) ?? 0) >=
        this.limits.maxActivePerParent
      ) {
        result.push({
          taskId: task.id,
          admitted: false,
          reason: "parent_limit",
        });
        continue;
      }
      result.push({ taskId: task.id, admitted: true, reason: "admitted" });
      slots--;
      activeByParent.set(
        task.parentAgentId,
        (activeByParent.get(task.parentAgentId) ?? 0) + 1,
      );
    }
    return result;
  }
  setProvisioning(delta: 1 | -1): void {
    this.#provisioning = Math.max(0, this.#provisioning + delta);
  }
  canProvision(): boolean {
    return this.#provisioning < this.limits.maxProvisioning;
  }
  snapshot(): SchedulerSnapshot {
    const values = [...this.#tasks.values()];
    return {
      queued: values.filter((task) => task.state === "queued"),
      active: values.filter((task) =>
        ["provisioning", "running", "blocked"].includes(task.state),
      ),
      provisioning: this.#provisioning,
    };
  }
}

export function findReusableAgent(
  request: ReuseRequest,
  candidates: readonly ReuseCandidate[],
): string | undefined {
  return candidates
    .filter(
      (candidate) =>
        candidate.idle &&
        !candidate.cleanupPending &&
        candidate.profileId === request.profileId &&
        candidate.projectKey === request.projectKey &&
        candidate.worktreeKey === request.worktreeKey &&
        candidate.trustKey === request.trustKey &&
        candidate.toolPolicyHash === request.toolPolicyHash &&
        candidate.modelPolicyHash === request.modelPolicyHash,
    )
    .sort((a, b) => a.agentId.localeCompare(b.agentId))[0]?.agentId;
}
