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
  herdrResources: {},
  idempotency: {},
});
const taskTerminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const known = new Set([
  "task.created",
  "task.state_changed",
  "audit.action",
  "audit.authorization_denied",
  "herdr.provision.intent",
  "herdr.provision.outcome",
  "herdr.reconciled",
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
