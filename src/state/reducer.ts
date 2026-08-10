import { OrchestratorError } from "../shared/errors.js";
import type { EventInput, OrchestrationState, StoredEvent } from "./types.js";
import type { TaskState } from "./types.js";
export const emptyState = (): OrchestrationState => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  lastEventHash: "0".repeat(64),
  tasks: {},
  runs: {},
  agents: {},
  workflows: {},
  idempotency: {},
});
const taskTerminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const runTerminal = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "lost",
]);
const known = new Set([
  "task.created",
  "task.state_changed",
  "run.created",
  "run.pi_settled",
  "result.published",
  "idempotency.record",
  "audit.action",
  "audit.authorization_denied",
  "system.status_changed",
  "recovery.reconciled",
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
  };
  const p = event.payload as Record<string, unknown>;
  const taskId = event.entityRefs?.taskId;
  const runId = event.entityRefs?.runId;
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
      if (
        !task ||
        typeof to !== "string" ||
        (taskTerminal.has(task.state) && task.state !== to)
      )
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Invalid task transition.",
        );
      next.tasks = { ...next.tasks };
      next.tasks[taskId] = { ...task, state: to };
      break;
    }
    case "run.created": {
      const id = runId ?? String(p.id);
      if (
        !id ||
        next.runs[id] ||
        typeof p.taskId !== "string" ||
        !next.tasks[p.taskId]
      )
        throw new OrchestratorError("STATE_CORRUPT", "Invalid run creation.");
      next.runs = { ...next.runs };
      next.tasks = { ...next.tasks };
      next.runs[id] = {
        id,
        taskId: p.taskId,
        state: "created",
        assignmentGeneration: Number(p.assignmentGeneration ?? 1),
        settled: false,
        ...(typeof p.agentId === "string" ? { agentId: p.agentId } : {}),
      };
      const task = next.tasks[p.taskId];
      if (!task)
        throw new OrchestratorError("STATE_CORRUPT", "Run task is missing.");
      next.tasks[p.taskId] = { ...task, currentRunId: id };
      break;
    }
    case "run.pi_settled": {
      if (!runId)
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Run reference is missing.",
        );
      const run = next.runs[runId];
      if (!run || runTerminal.has(run.state) || run.state === "cancelled")
        throw new OrchestratorError("STATE_CORRUPT", "Invalid run settlement.");
      next.runs = { ...next.runs };
      next.runs[runId] = {
        ...run,
        settled: true,
        state: run.resultId ? "succeeded" : "result_pending_missing",
      };
      break;
    }
    case "result.published": {
      if (
        !runId ||
        typeof p.resultId !== "string" ||
        typeof p.taskId !== "string"
      )
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Invalid result correlation.",
        );
      const run = next.runs[runId];
      if (
        !run ||
        run.taskId !== p.taskId ||
        runTerminal.has(run.state) ||
        (run.resultId && run.resultId !== p.resultId)
      )
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Result correlation or lifecycle is invalid.",
        );
      next.runs = { ...next.runs };
      next.tasks = { ...next.tasks };
      next.runs[runId] = {
        ...run,
        resultId: p.resultId,
        state: run.settled ? "succeeded" : "result_pending",
      };
      const task = next.tasks[run.taskId];
      if (!task)
        throw new OrchestratorError("STATE_CORRUPT", "Result task is missing.");
      next.tasks[run.taskId] = {
        ...task,
        resultId: p.resultId,
        state: run.settled ? "succeeded" : "collecting",
      };
      break;
    }
    case "idempotency.record": {
      if (typeof p.key !== "string" || typeof p.principalId !== "string")
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Invalid idempotency record.",
        );
      next.idempotency = { ...next.idempotency };
      next.idempotency[p.key] = {
        principalId: p.principalId,
        method: String(p.method),
        ...(typeof p.paramsHash === "string"
          ? { paramsHash: p.paramsHash }
          : {}),
        response: p.response,
      };
      break;
    }
    default:
      break;
  }
  return next;
}
