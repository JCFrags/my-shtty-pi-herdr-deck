import type {
  Agent,
  AgentLifecycleClass,
  CloseRecommendation,
  OrchestrationState,
  Task,
} from "../state/types.js";

const TERMINAL_TASK_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);
const ACTIVE_AGENT_STATES = new Set([
  "provisioning",
  "starting",
  "working",
  "stopping",
]);

export interface AgentLifecycleProjection {
  lifecycleClass: AgentLifecycleClass;
  keepForReuse: boolean;
  closeRecommendation: CloseRecommendation;
  closeReason: string;
}

export interface AgentProgress {
  phase:
    "queued" | "creating_resources" | "waiting_for_registration" | "starting";
  startedAt: string;
  elapsedMs: number;
  deadlineAt?: string;
  deadlineKind?: "task" | "registration";
  remainingMs?: number;
  overdueMs?: number;
}

export type AgentLifecycleView = Agent & {
  progress?: AgentProgress;
};

export type TaskProgressView = Task & {
  progress?: AgentProgress;
};

function taskForAgent(
  agent: Agent,
  state: OrchestrationState,
): Task | undefined {
  if (agent.currentRunId) {
    const run = state.runs[agent.currentRunId];
    if (run) return state.tasks[run.taskId];
  }
  const assigned = Object.values(state.tasks).filter(
    (task) => task.assignedAgentId === agent.id,
  );
  return (
    assigned.find((task) => !TERMINAL_TASK_STATES.has(task.state)) ??
    assigned.find(
      (task) => Boolean(task.resultId) && !task.resultCollectedAt,
    ) ??
    assigned.at(-1)
  );
}

export function projectTaskProgress(
  task: Task,
  state: OrchestrationState,
  now: number,
): AgentProgress | undefined {
  if (!["queued", "provisioning", "assigned"].includes(task.state))
    return undefined;
  const run = task.currentRunId ? state.runs[task.currentRunId] : undefined;
  const resource = task.assignedAgentId
    ? state.herdrResources?.[task.assignedAgentId]
    : undefined;
  const phase: AgentProgress["phase"] =
    task.state === "queued"
      ? "queued"
      : resource?.state === "pending"
        ? "waiting_for_registration"
        : task.state === "assigned"
          ? "starting"
          : "creating_resources";
  const startedAt = run?.startedAt ?? task.createdAt;
  const startedMs = Date.parse(startedAt);
  const registrationDeadline =
    phase === "waiting_for_registration" && resource?.registrationDeadline
      ? resource.registrationDeadline
      : undefined;
  const deadlineAt = registrationDeadline ?? task.timeoutAt ?? run?.timeoutAt;
  const deadlineMs = deadlineAt ? Date.parse(deadlineAt) : Number.NaN;
  return {
    phase,
    startedAt,
    elapsedMs: Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : 0,
    ...(deadlineAt && Number.isFinite(deadlineMs)
      ? {
          deadlineAt,
          deadlineKind: registrationDeadline ? "registration" : "task",
          ...(deadlineMs >= now
            ? { remainingMs: deadlineMs - now }
            : { remainingMs: 0, overdueMs: now - deadlineMs }),
        }
      : {}),
  };
}

export function taskWithProgress(
  task: Task,
  state: OrchestrationState,
  now: number,
): TaskProgressView {
  const progress = projectTaskProgress(task, state, now);
  return { ...task, ...(progress ? { progress } : {}) };
}

export function projectAgentLifecycle(
  agent: Agent,
  state: OrchestrationState,
): AgentLifecycleProjection {
  const lifecycleClass: AgentLifecycleClass =
    agent.lifecycleClass ?? (agent.parentAgentId ? "temporary" : "retained");
  const keepForReuse =
    agent.keepForReuse === true || lifecycleClass === "reusable";
  if (lifecycleClass === "pinned" || lifecycleClass === "retained")
    return {
      lifecycleClass,
      keepForReuse,
      closeRecommendation: "keep",
      closeReason: `${lifecycleClass} agents stay open.`,
    };
  if (keepForReuse)
    return {
      lifecycleClass,
      keepForReuse,
      closeRecommendation: "keep",
      closeReason: "The agent is marked for reuse.",
    };
  if (agent.state === "blocked")
    return {
      lifecycleClass,
      keepForReuse,
      closeRecommendation: "blocked",
      closeReason: "The agent is blocked and needs input.",
    };
  if (ACTIVE_AGENT_STATES.has(agent.state))
    return {
      lifecycleClass,
      keepForReuse,
      closeRecommendation: "blocked",
      closeReason: "The agent is active.",
    };
  const task = taskForAgent(agent, state);
  if (!task || !TERMINAL_TASK_STATES.has(task.state))
    return {
      lifecycleClass,
      keepForReuse,
      closeRecommendation: "blocked",
      closeReason: "The task is not terminal.",
    };
  if (!task.resultId)
    return {
      lifecycleClass,
      keepForReuse,
      closeRecommendation: "blocked",
      closeReason: "The task has no accepted result.",
    };
  if (!task.resultCollectedAt)
    return {
      lifecycleClass,
      keepForReuse,
      closeRecommendation: "blocked",
      closeReason: "The result has not been collected.",
    };
  return {
    lifecycleClass,
    keepForReuse,
    closeRecommendation: "close",
    closeReason: "The temporary task is complete and its result was collected.",
  };
}

export function agentWithLifecycle(
  agent: Agent,
  state: OrchestrationState,
  now = Date.now(),
): AgentLifecycleView {
  const task = taskForAgent(agent, state);
  const progress = task ? projectTaskProgress(task, state, now) : undefined;
  return {
    ...agent,
    ...projectAgentLifecycle(agent, state),
    ...(progress ? { progress } : {}),
  };
}
