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
const known = new Set([
  "task.created",
  "task.state_changed",
  "audit.action",
  "audit.authorization_denied",
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
        (to !== "queued" && to !== "cancelled") ||
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
    case "audit.action":
    case "audit.authorization_denied":
      break;
    default:
      throw new OrchestratorError(
        "STATE_CORRUPT",
        `Unhandled event type ${event.type}.`,
      );
  }
  return next;
}
