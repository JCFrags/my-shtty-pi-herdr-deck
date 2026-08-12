import { OrchestratorError } from "../shared/errors.js";
import type { EventInput, OrchestrationState, StoredEvent } from "./types.js";
import type {
  TaskState,
  AgentState,
  RunState,
  Run,
  Workflow,
  ErrorSummary,
  Task,
} from "./types.js";
const timeoutReason = (value: unknown): value is ErrorSummary => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reason = value as Record<string, unknown>;
  return (
    Object.keys(reason).length === 2 &&
    ((reason.code === "TIMEOUT" &&
      reason.message === "The task wall deadline expired.") ||
      (reason.code === "BUDGET_EXCEEDED" &&
        reason.message === "The configured budget was exceeded."))
  );
};
export const emptyState = (): OrchestrationState => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  lastEventHash: "0".repeat(64),
  tasks: {},
  runs: {},
  agents: {},
  workflows: {},
  results: {},
  questions: {},
  groups: {},
  herdrResources: {},
  idempotency: {},
});
const taskTerminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const runSharedTerminal = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "lost",
]);
const DEFAULT_TASK_WALL_MS = 15 * 60_000;
function derivedDeadline(createdAt: unknown): string | undefined {
  if (typeof createdAt !== "string") return undefined;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return undefined;
  return new Date(created + DEFAULT_TASK_WALL_MS).toISOString();
}
const known = new Set([
  "task.created",
  "task.project_bound",
  "task.state_changed",
  "audit.action",
  "audit.authorization_denied",
  "herdr.provision.intent",
  "herdr.provision.outcome",
  "herdr.reconciled",
  "agent.registered",
  "agent.heartbeat",
  "agent.state_changed",
  "agent.moved",
  "agent.replaced",
  "task.created_m3",
  "run.created",
  "assignment.delivered",
  "assignment.accepted",
  "assignment.delivery_failed",
  "run.pi_started",
  "run.pi_settled",
  "run.state_changed",
  "task.cancel_requested",
  "result.published",
  "result.validated",
  "run.result_recovery_requested",
  "run.result_missing",
  "question.opened",
  "question.answered",
  "question.timed_out",
  "question.cancelled",
  "group.created",
  "group.stopped",
  "group.closed",
  "workflow.created",
  "workflow.state_changed",
  "scheduler.admitted",
  "scheduler.blocked",
  "task.collected",
]);
export function reduce(
  state: OrchestrationState,
  event: StoredEvent | EventInput,
): OrchestrationState {
  if (!known.has(event.type))
    throw new OrchestratorError(
      "STATE_CORRUPT",
      `Unknown event type ${event.type}.`,
    );
  const next: OrchestrationState = {
    ...state,
    lastEventSeq: "seq" in event ? event.seq : state.lastEventSeq,
    lastEventHash: "hash" in event ? event.hash : state.lastEventHash,
    results: state.results ?? {},
    questions: state.questions ?? {},
    groups: state.groups ?? {},
  };
  const p = event.payload as Record<string, unknown>;
  const taskId = event.entityRefs?.taskId;
  switch (event.type) {
    case "task.created": {
      const id = taskId ?? String(p.id);
      if (!id || next.tasks[id])
        throw new OrchestratorError(
          "INVALID_REQUEST",
          "Task already exists or has no ID.",
        );
      if (typeof p.title !== "string" || typeof p.objective !== "string")
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Task payload is invalid.",
        );
      next.tasks = { ...next.tasks };
      next.tasks[id] = {
        id,
        title: p.title,
        objective: p.objective,
        state: "queued",
        createdAt: String(p.createdAt),
        ...(typeof p.parentAgentId === "string"
          ? { parentAgentId: p.parentAgentId }
          : {}),
      };
      if (typeof p.idempotencyKey === "string") {
        next.idempotency = { ...next.idempotency };
        next.idempotency[p.idempotencyKey] = {
          principalId: event.actor.principalId,
          method: "task.create",
          ...(typeof p.paramsHash === "string"
            ? { paramsHash: p.paramsHash }
            : {}),
          response: p.response,
        };
      }
      break;
    }
    case "task.state_changed": {
      if (!taskId)
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Task reference is missing.",
        );
      const task = next.tasks[taskId];
      const to = p.to as TaskState;
      const allowed = new Set([
        "draft",
        "queued",
        "provisioning",
        "assigned",
        "running",
        "blocked",
        "collecting",
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
      ]);
      if (
        !task ||
        !allowed.has(String(to)) ||
        (taskTerminal.has(task.state) && task.state !== to)
      )
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Invalid task transition.",
        );
      if (
        p.reason !== undefined &&
        (to !== "timed_out" || !timeoutReason(p.reason))
      )
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Invalid terminal reason.",
        );
      next.tasks = { ...next.tasks };
      next.tasks[taskId] = {
        ...task,
        state: to,
        ...(to === "timed_out" && timeoutReason(p.reason)
          ? { terminalReason: p.reason as ErrorSummary }
          : {}),
      };
      break;
    }
    case "agent.registered": {
      const id = String(p.agentId);
      if (!id || next.agents[id])
        throw new OrchestratorError("INVALID_REQUEST", "Agent already exists.");
      next.agents = {
        ...next.agents,
        [id]: {
          id,
          state: "idle",
          generation: Number(p.generation ?? 1),
          managed: p.managed === true,
          ...(typeof p.parentAgentId === "string"
            ? { parentAgentId: p.parentAgentId }
            : {}),
          ...(typeof p.displayName === "string"
            ? { displayName: p.displayName }
            : {}),
          ...(typeof p.profileId === "string"
            ? { profileId: p.profileId }
            : {}),
          ...(typeof p.paneId === "string" ? { paneId: p.paneId } : {}),
          ...(typeof p.terminalId === "string"
            ? { terminalId: p.terminalId }
            : {}),
          ...(typeof p.workspaceId === "string"
            ? { workspaceId: p.workspaceId }
            : {}),
          ...(typeof p.tabId === "string" ? { tabId: p.tabId } : {}),
          ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
          ...(typeof p.worktreeId === "string"
            ? { worktreeId: p.worktreeId }
            : {}),
          ...(typeof p.piSessionId === "string"
            ? { piSessionId: p.piSessionId }
            : {}),
          connectionGeneration: Number(p.connectionGeneration ?? 1),
          currentAssignmentGeneration: 0,
        },
      };
      break;
    }
    case "agent.heartbeat":
    case "agent.moved":
    case "agent.state_changed":
    case "agent.replaced": {
      const id = String(event.entityRefs?.agentId ?? p.agentId),
        agent = next.agents[id];
      if (!agent)
        throw new OrchestratorError("STATE_CORRUPT", "Agent is missing.");
      next.agents = {
        ...next.agents,
        [id]: {
          ...agent,
          ...(typeof p.state === "string"
            ? { state: p.state as AgentState }
            : {}),
          ...(event.type === "agent.replaced" &&
          Number.isSafeInteger(p.generation) &&
          Number(p.generation) >= 1
            ? { generation: p.generation as number }
            : {}),
          ...(typeof p.paneId === "string" ? { paneId: p.paneId } : {}),
          ...(typeof p.terminalId === "string"
            ? { terminalId: p.terminalId }
            : {}),
          ...(typeof p.workspaceId === "string"
            ? { workspaceId: p.workspaceId }
            : {}),
          ...(typeof p.tabId === "string" ? { tabId: p.tabId } : {}),
          ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
          ...(typeof p.worktreeId === "string"
            ? { worktreeId: p.worktreeId }
            : {}),
          ...(typeof p.piSessionId === "string"
            ? { piSessionId: p.piSessionId }
            : {}),
          ...(typeof p.currentRunId === "string"
            ? { currentRunId: p.currentRunId }
            : {}),
          ...(Number.isSafeInteger(p.connectionGeneration)
            ? { connectionGeneration: p.connectionGeneration as number }
            : {}),
          ...(Number.isSafeInteger(p.currentAssignmentGeneration)
            ? {
                currentAssignmentGeneration:
                  p.currentAssignmentGeneration as number,
              }
            : {}),
          ...(Number.isSafeInteger(p.adapterSeq)
            ? { lastAdapterSeq: p.adapterSeq as number }
            : {}),
        },
      };
      break;
    }
    case "task.created_m3": {
      const id = String(p.taskId);
      if (!id || next.tasks[id])
        throw new OrchestratorError("INVALID_REQUEST", "Task already exists.");
      next.tasks = {
        ...next.tasks,
        [id]: {
          id,
          title: String(p.title),
          objective: String(p.objective),
          state: "queued",
          createdAt: String(p.createdAt),
          ...(typeof p.parentAgentId === "string"
            ? { parentAgentId: p.parentAgentId }
            : {}),
          ...(typeof p.workflowId === "string"
            ? { workflowId: p.workflowId }
            : {}),
          ...(typeof p.profileId === "string"
            ? { profileId: p.profileId }
            : {}),
          ...(typeof p.isolationMode === "string" &&
          [
            "profile-default",
            "shared-readonly",
            "worktree",
            "shared-explicit",
            "reuse-worktree",
          ].includes(p.isolationMode)
            ? {
                isolationMode: p.isolationMode as NonNullable<
                  Task["isolationMode"]
                >,
              }
            : {}),
          ...(Array.isArray(p.dependencies)
            ? {
                dependencies: p.dependencies.filter(
                  (v): v is string => typeof v === "string",
                ),
              }
            : {}),
          ...(() => {
            const timeoutAt =
              typeof p.timeoutAt === "string"
                ? p.timeoutAt
                : derivedDeadline(p.createdAt);
            return timeoutAt ? { timeoutAt } : {};
          })(),
          ...(p.project &&
          typeof p.project === "object" &&
          !Array.isArray(p.project)
            ? { project: p.project as Record<string, unknown> }
            : {}),
          runIds: [],
        },
      };
      break;
    }
    case "task.project_bound": {
      const id = String(p.taskId);
      const task = next.tasks[id];
      if (
        !task ||
        !p.project ||
        typeof p.project !== "object" ||
        Array.isArray(p.project)
      )
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Task project binding is invalid.",
        );
      next.tasks = {
        ...next.tasks,
        [id]: { ...task, project: p.project as Record<string, unknown> },
      };
      break;
    }
    case "run.created": {
      const id = String(p.runId),
        task = next.tasks[String(p.taskId)];
      if (!id || next.runs[id] || !task)
        throw new OrchestratorError("STATE_CORRUPT", "Run or task is invalid.");
      if (taskTerminal.has(task.state))
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Run cannot be created for a terminal task.",
        );
      const runTimeoutAt =
        typeof p.timeoutAt === "string" ? p.timeoutAt : task.timeoutAt;
      if (task.timeoutAt !== runTimeoutAt)
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Run deadline does not match its task deadline.",
        );
      const run: Run = {
        id,
        taskId: task.id,
        state: "created",
        ...(typeof p.agentId === "string" ? { agentId: p.agentId } : {}),
        ...(Number.isSafeInteger(p.agentGeneration)
          ? { agentGeneration: p.agentGeneration as number }
          : {}),
        ...(typeof p.assignmentId === "string"
          ? { assignmentId: p.assignmentId }
          : {}),
        assignmentGeneration: Number(p.assignmentGeneration ?? 1),
        ...(typeof p.piSessionId === "string"
          ? { piSessionId: p.piSessionId }
          : {}),
        ...(typeof p.terminalId === "string"
          ? { terminalId: p.terminalId }
          : {}),
        settled: false,
        ...(typeof runTimeoutAt === "string"
          ? { timeoutAt: runTimeoutAt }
          : {}),
      };
      next.runs = { ...next.runs, [id]: run };
      if (run.agentId && next.agents[run.agentId])
        next.agents = {
          ...next.agents,
          [run.agentId]: {
            ...next.agents[run.agentId]!,
            currentRunId: id,
            currentAssignmentGeneration: run.assignmentGeneration,
          },
        };
      next.tasks = {
        ...next.tasks,
        [task.id]: {
          ...task,
          currentRunId: id,
          ...(typeof p.agentId === "string"
            ? { assignedAgentId: p.agentId }
            : {}),
          runIds: [...(task.runIds ?? []), id],
          state: "assigned",
        },
      };
      break;
    }
    case "assignment.delivered":
    case "assignment.accepted":
    case "assignment.delivery_failed":
    case "run.pi_started":
    case "run.pi_settled":
    case "run.state_changed": {
      const id = String(event.entityRefs?.runId ?? p.runId),
        run = next.runs[id];
      if (!run) throw new OrchestratorError("STATE_CORRUPT", "Run is missing.");
      const state = p.state as RunState | undefined;
      if (
        [
          "assignment.delivered",
          "assignment.accepted",
          "assignment.delivery_failed",
          "run.pi_started",
          "run.pi_settled",
        ].includes(event.type) &&
        (run.settled ||
          run.state === "settled" ||
          runSharedTerminal.has(run.state))
      )
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Adapter progress cannot mutate a terminal run.",
        );
      if (
        event.type === "run.state_changed" &&
        runSharedTerminal.has(run.state) &&
        state !== run.state
      )
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "A terminal run cannot transition to another state.",
        );
      if (
        p.reason !== undefined &&
        (state !== "timed_out" || !timeoutReason(p.reason))
      )
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Invalid terminal reason.",
        );
      const settled = event.type === "run.pi_settled" ? true : run.settled;
      const reason =
        state === "timed_out" && timeoutReason(p.reason) ? p.reason : undefined;
      next.runs = {
        ...next.runs,
        [id]: {
          ...run,
          ...(state ? { state } : {}),
          settled,
          ...(reason ? { terminalReason: reason } : {}),
          ...(typeof p.piSessionId === "string"
            ? { piSessionId: p.piSessionId }
            : {}),
          ...(typeof p.agentId === "string" ? { agentId: p.agentId } : {}),
          ...(event.type === "run.pi_started" &&
          typeof p.agentCycleId === "string"
            ? { agentCycleId: p.agentCycleId }
            : {}),
          ...(event.type === "run.pi_started" &&
          Number.isSafeInteger(p.turnIndex)
            ? { firstTurnIndex: p.turnIndex as number }
            : {}),
          ...(event.type.startsWith("assignment.") &&
          typeof p.assignmentId === "string"
            ? { assignmentId: p.assignmentId }
            : {}),
          ...(event.type.startsWith("assignment.") &&
          Number.isSafeInteger(p.connectionGeneration)
            ? {
                assignmentConnectionGeneration:
                  p.connectionGeneration as number,
              }
            : {}),
          ...(event.type === "assignment.delivered"
            ? { assignmentDeliveryState: "pending" as const }
            : event.type === "assignment.accepted"
              ? { assignmentDeliveryState: "accepted" as const }
              : event.type === "assignment.delivery_failed"
                ? { assignmentDeliveryState: "failed" as const }
                : {}),
        },
      };
      if (
        run.agentId &&
        Number.isSafeInteger(p.adapterSeq) &&
        next.agents[run.agentId]
      )
        next.agents = {
          ...next.agents,
          [run.agentId]: {
            ...next.agents[run.agentId]!,
            lastAdapterSeq: p.adapterSeq as number,
          },
        };
      if (
        event.type === "run.state_changed" &&
        ["succeeded", "failed", "cancelled", "timed_out", "lost"].includes(
          String(state),
        ) &&
        next.tasks[run.taskId]
      )
        next.tasks = {
          ...next.tasks,
          [run.taskId]: {
            ...next.tasks[run.taskId]!,
            state: state as TaskState,
            ...(reason ? { terminalReason: reason } : {}),
          },
        };
      if (event.type === "run.pi_settled") {
        const result = Object.values(next.results!).find(
          (item) => item.runId === id,
        );
        if (result)
          next.results = {
            ...next.results,
            [result.id]: { ...result, piSettled: true },
          };
      }
      break;
    }
    case "task.cancel_requested": {
      const id = String(event.entityRefs?.taskId ?? p.taskId),
        task = next.tasks[id];
      if (!task || taskTerminal.has(task.state)) break;
      next.tasks = { ...next.tasks, [id]: { ...task, state: "cancelled" } };
      if (task.currentRunId && next.runs[task.currentRunId])
        next.runs = {
          ...next.runs,
          [task.currentRunId]: {
            ...next.runs[task.currentRunId]!,
            state: "cancelled",
            cancelled: true,
          },
        };
      break;
    }
    case "audit.action":
    case "audit.authorization_denied":
      break;
    case "result.published": {
      const id = String(p.resultId);
      if (!id || next.results![id])
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Result already exists or has no ID.",
        );
      if (
        !event.entityRefs?.taskId ||
        !event.entityRefs.runId ||
        !event.entityRefs.agentId ||
        typeof p.payloadHash !== "string"
      )
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Result correlation is invalid.",
        );
      next.results = {
        ...next.results,
        [id]: {
          id,
          taskId: event.entityRefs.taskId,
          runId: event.entityRefs.runId,
          agentId: event.entityRefs.agentId,
          status:
            p.status === "failed" || p.status === "cancelled"
              ? p.status
              : "succeeded",
          payloadHash: p.payloadHash,
          piSettled: p.piSettled === true,
          ...(Number.isSafeInteger(p.assignmentGeneration)
            ? { assignmentGeneration: p.assignmentGeneration as number }
            : {}),
          ...(Object.hasOwn(p, "payload") ? { payload: p.payload } : {}),
          ...(p.validation && typeof p.validation === "object"
            ? { validation: p.validation as Record<string, unknown> }
            : {}),
          ...(typeof p.publishedAt === "string"
            ? { publishedAt: p.publishedAt }
            : {}),
        },
      };
      break;
    }
    case "result.validated": {
      const id = event.entityRefs?.resultId;
      if (!id || !next.results![id])
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Result validation has no result.",
        );
      const result = next.results![id];
      next.results = {
        ...next.results,
        [id]: { ...result, piSettled: p.piSettled === true },
      };
      break;
    }
    case "run.result_recovery_requested":
    case "run.result_missing":
    case "scheduler.admitted":
    case "scheduler.blocked":
    case "task.collected":
      break;
    case "group.created": {
      const id = event.entityRefs?.groupId ?? String(p.groupId);
      if (
        !id ||
        next.groups![id] ||
        typeof p.name !== "string" ||
        !Array.isArray(p.agentIds) ||
        p.agentIds.length === 0 ||
        p.agentIds.some((agentId) => typeof agentId !== "string") ||
        typeof p.createdAt !== "string"
      )
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Group payload is invalid.",
        );
      next.groups = { ...next.groups };
      next.groups[id] = {
        id,
        name: p.name,
        agentIds: [...p.agentIds] as string[],
        state: "open",
        createdAt: p.createdAt,
        createdBy: event.actor.principalId,
      };
      break;
    }
    case "group.stopped":
    case "group.closed": {
      const id = event.entityRefs?.groupId ?? String(p.groupId);
      const group = next.groups![id];
      const closed = event.type === "group.closed";
      if (!group || group.state === "closed" || (closed && p.confirm !== true))
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Group transition is invalid.",
        );
      next.groups = { ...next.groups };
      next.groups[id] = {
        ...group,
        state: closed ? "closed" : "stopped",
        ...(closed ? { closedAt: String(p.at) } : { stoppedAt: String(p.at) }),
      };
      break;
    }
    case "workflow.created": {
      const id = String(p.workflowId);
      if (!id || next.workflows[id])
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Workflow already exists.",
        );
      next.workflows = {
        ...next.workflows,
        [id]: {
          id,
          state: "created",
          taskIds: Array.isArray(p.taskIds)
            ? p.taskIds.filter((x): x is string => typeof x === "string")
            : [],
        },
      };
      break;
    }
    case "workflow.state_changed": {
      const id = String(event.entityRefs?.workflowId ?? p.workflowId),
        workflow = next.workflows[id];
      if (!workflow)
        throw new OrchestratorError("STATE_CORRUPT", "Workflow is missing.");
      const state = String(p.state) as Workflow["state"];
      if (
        ![
          "created",
          "running",
          "blocked",
          "succeeded",
          "failed",
          "cancelled",
        ].includes(state)
      )
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Workflow state is invalid.",
        );
      next.workflows = { ...next.workflows, [id]: { ...workflow, state } };
      break;
    }
    case "question.opened": {
      const id = String(p.questionId);
      if (!id || next.questions![id])
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Question already exists or has no ID.",
        );
      if (
        !event.entityRefs?.taskId ||
        !event.entityRefs.runId ||
        !event.entityRefs.agentId
      )
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Question correlation is invalid.",
        );
      next.questions = {
        ...next.questions,
        [id]: {
          id,
          taskId: event.entityRefs.taskId,
          runId: event.entityRefs.runId,
          agentId: event.entityRefs.agentId,
          state: "open",
          ...(Number.isSafeInteger(p.assignmentGeneration)
            ? { assignmentGeneration: p.assignmentGeneration as number }
            : {}),
          ...(typeof p.toolCallId === "string"
            ? { toolCallId: p.toolCallId }
            : {}),
          ...(Object.hasOwn(p, "payload") ? { payload: p.payload } : {}),
          ...(typeof p.askedAt === "string" ? { askedAt: p.askedAt } : {}),
        },
      };
      break;
    }
    case "question.answered": {
      const id = event.entityRefs?.questionId;
      if (!id || !next.questions![id] || next.questions![id].state !== "open")
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Question answer is not valid.",
        );
      next.questions = {
        ...next.questions,
        [id]: {
          ...next.questions![id],
          state: "answered",
          ...(typeof p.answeredBy === "string"
            ? { answeredBy: p.answeredBy }
            : {}),
          ...(typeof p.answeredAt === "string"
            ? { answeredAt: p.answeredAt }
            : {}),
          ...(Object.hasOwn(p, "answer") &&
          p.answer &&
          typeof p.answer === "object"
            ? {
                answer: p.answer as {
                  optionId: string | null;
                  text: string | null;
                },
              }
            : {}),
        },
      };
      break;
    }
    case "question.timed_out":
    case "question.cancelled": {
      const id = event.entityRefs?.questionId;
      if (!id || !next.questions![id] || next.questions![id].state !== "open")
        throw new OrchestratorError(
          "STATE_CORRUPT",
          event.type === "question.cancelled"
            ? "Question cancellation is not valid."
            : "Question timeout is not valid.",
        );
      next.questions = {
        ...next.questions,
        [id]: {
          ...next.questions![id],
          state:
            event.type === "question.cancelled" ? "cancelled" : "timed_out",
        },
      };
      break;
    }
    case "herdr.provision.intent": {
      const agentId = String(p.agentId);
      if (!agentId)
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Herdr intent agent is invalid.",
        );
      next.herdrResources = {
        ...(next.herdrResources ?? {}),
        [agentId]: { agentId, state: "provisioning" },
      };
      break;
    }
    case "herdr.provision.outcome":
    case "herdr.reconciled": {
      const agentId = String(p.agentId),
        current = next.herdrResources?.[agentId];
      if (!current)
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Herdr resource has no intent.",
        );
      next.herdrResources = {
        ...(next.herdrResources ?? {}),
        [agentId]: {
          ...current,
          state: String(p.state),
          ...(typeof p.paneId === "string" ? { paneId: p.paneId } : {}),
          ...(typeof p.tabId === "string" ? { tabId: p.tabId } : {}),
          ...(typeof p.worktreeId === "string"
            ? { worktreeId: p.worktreeId }
            : {}),
          ...(typeof p.worktreePath === "string"
            ? { worktreePath: p.worktreePath }
            : {}),
          ...(typeof p.workspaceId === "string"
            ? { workspaceId: p.workspaceId }
            : {}),
          ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
          ...(typeof p.parentAgentId === "string"
            ? { parentAgentId: p.parentAgentId }
            : {}),
          ...(typeof p.ownerId === "string" ? { ownerId: p.ownerId } : {}),
          ...(typeof p.terminalId === "string"
            ? { terminalId: p.terminalId }
            : {}),
          ...(typeof p.sessionId === "string"
            ? { sessionId: p.sessionId }
            : {}),
          ...(Number.isSafeInteger(p.generation)
            ? { generation: p.generation as number }
            : {}),
          ...(typeof p.tokenDigest === "string"
            ? { tokenDigest: p.tokenDigest }
            : {}),
          ...(Number.isSafeInteger(p.promptFileDev)
            ? { promptFileDev: p.promptFileDev as number }
            : {}),
          ...(Number.isSafeInteger(p.promptFileIno)
            ? { promptFileIno: p.promptFileIno as number }
            : {}),
          ...(Number.isSafeInteger(p.tokenFileDev)
            ? { tokenFileDev: p.tokenFileDev as number }
            : {}),
          ...(Number.isSafeInteger(p.tokenFileIno)
            ? { tokenFileIno: p.tokenFileIno as number }
            : {}),
          ...(typeof p.registrationDeadline === "string"
            ? { registrationDeadline: p.registrationDeadline }
            : {}),
          ...(typeof p.cleanupOutcome === "string"
            ? { cleanupOutcome: p.cleanupOutcome }
            : {}),
          ...(typeof p.dirty === "boolean" ? { dirty: p.dirty } : {}),
          ...(typeof p.replaced === "boolean" ? { replaced: p.replaced } : {}),
          ...(typeof p.orphaned === "boolean" ? { orphaned: p.orphaned } : {}),
          ...(typeof p.unknown === "boolean" ? { unknown: p.unknown } : {}),
          ...(typeof p.parentGitRoot === "string"
            ? { parentGitRoot: p.parentGitRoot }
            : {}),
          ...(typeof p.parentGitHead === "string"
            ? { parentGitHead: p.parentGitHead }
            : {}),
          ...(typeof p.parentGitBranch === "string"
            ? { parentGitBranch: p.parentGitBranch }
            : {}),
          ...(Array.isArray(p.parentGitChangedFiles) &&
          p.parentGitChangedFiles.every((x) => typeof x === "string")
            ? { parentGitChangedFiles: p.parentGitChangedFiles as string[] }
            : {}),
          ...(typeof p.worktreeGitRoot === "string"
            ? { worktreeGitRoot: p.worktreeGitRoot }
            : {}),
          ...(typeof p.worktreeGitHead === "string"
            ? { worktreeGitHead: p.worktreeGitHead }
            : {}),
          ...(typeof p.worktreeGitBranch === "string"
            ? { worktreeGitBranch: p.worktreeGitBranch }
            : {}),
        },
      };
      break;
    }
    default:
      throw new OrchestratorError(
        "STATE_CORRUPT",
        `Unhandled event type ${event.type}.`,
      );
  }
  return next;
}
