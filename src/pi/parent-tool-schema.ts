import type { ParentToolName, ParentToolRequest } from "./parent-tools.js";

export const PARENT_TOOL_NAMES = [
  "delegate",
  "agent_spawn",
  "agent_list",
  "agent_get",
  "agent_prompt",
  "agent_steer",
  "agent_ask",
  "agent_wait",
  "coordination_wait",
  "coordination_signal",
  "group_create",
  "group_list",
  "group_get",
  "group_wait",
  "group_stop",
  "group_close",
  "agent_result",
  "agent_answer",
  "agent_interrupt",
  "agent_stop",
  "agent_close",
  "task_list",
  "task_get",
  "task_collect",
  "task_cancel",
] as const satisfies readonly ParentToolName[];

export interface ParentToolMetadata {
  readonly method: string;
  /** Exact input fields used to identify the authorized resource. */
  readonly targetParameters: readonly string[];
  readonly requiresTarget: boolean;
  readonly requiresDelegation: boolean;
  readonly mutating: boolean;
}

const METADATA: Record<ParentToolName, ParentToolMetadata> = {
  delegate: {
    method: "delegate.execute",
    targetParameters: [],
    requiresTarget: false,
    requiresDelegation: true,
    mutating: true,
  },
  agent_spawn: {
    method: "agent.spawn",
    targetParameters: [],
    requiresTarget: false,
    requiresDelegation: false,
    mutating: true,
  },
  agent_list: {
    method: "agent.list",
    targetParameters: [],
    requiresTarget: false,
    requiresDelegation: false,
    mutating: false,
  },
  agent_get: {
    method: "agent.get",
    targetParameters: ["agentId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: false,
  },
  agent_prompt: {
    method: "agent.prompt",
    targetParameters: ["agentId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: true,
  },
  agent_steer: {
    method: "agent.steer",
    targetParameters: ["agentId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: true,
  },
  agent_ask: {
    method: "agent.ask",
    targetParameters: ["agentId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: true,
  },
  agent_wait: {
    method: "agent.wait",
    targetParameters: ["agentId", "taskId", "runId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: false,
  },
  coordination_wait: {
    method: "coordination.wait",
    targetParameters: ["targetId"],
    requiresTarget: false,
    requiresDelegation: false,
    mutating: false,
  },
  coordination_signal: {
    method: "coordination.signal",
    targetParameters: ["targetId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: true,
  },
  group_create: {
    method: "group.create",
    targetParameters: ["agentIds"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: true,
  },
  group_list: {
    method: "group.list",
    targetParameters: [],
    requiresTarget: false,
    requiresDelegation: false,
    mutating: false,
  },
  group_get: {
    method: "group.get",
    targetParameters: ["groupId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: false,
  },
  group_wait: {
    method: "group.wait",
    targetParameters: ["groupId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: false,
  },
  group_stop: {
    method: "group.stop",
    targetParameters: ["groupId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: true,
  },
  group_close: {
    method: "group.close",
    targetParameters: ["groupId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: true,
  },
  agent_result: {
    method: "result.get",
    targetParameters: ["taskId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: false,
  },
  agent_answer: {
    method: "question.answer",
    targetParameters: ["questionId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: true,
  },
  agent_interrupt: {
    method: "agent.interrupt",
    targetParameters: ["agentId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: true,
  },
  agent_stop: {
    method: "agent.stop",
    targetParameters: ["agentId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: true,
  },
  agent_close: {
    method: "agent.close",
    targetParameters: ["agentId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: true,
  },
  task_list: {
    method: "task.list",
    targetParameters: [],
    requiresTarget: false,
    requiresDelegation: false,
    mutating: false,
  },
  task_get: {
    method: "task.get",
    targetParameters: ["taskId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: false,
  },
  task_collect: {
    method: "task.collect",
    targetParameters: ["taskIds"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: false,
  },
  task_cancel: {
    method: "task.cancel",
    targetParameters: ["taskId"],
    requiresTarget: true,
    requiresDelegation: false,
    mutating: true,
  },
};

export const PARENT_TOOL_METADATA: Readonly<
  Record<ParentToolName, ParentToolMetadata>
> = Object.freeze(METADATA);

export function parentToolMetadata(tool: ParentToolName): ParentToolMetadata {
  return PARENT_TOOL_METADATA[tool];
}

export function parentToolMethod(tool: ParentToolName): string {
  return parentToolMetadata(tool).method;
}

export interface ParentToolValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ParentToolValidation =
  | {
      readonly valid: true;
      readonly request: ParentToolRequest;
      readonly issues: readonly [];
    }
  | {
      readonly valid: false;
      readonly issues: readonly ParentToolValidationIssue[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateParentToolRequest(
  value: unknown,
): ParentToolValidation {
  const issues: ParentToolValidationIssue[] = [];
  if (!isRecord(value))
    return {
      valid: false,
      issues: [{ path: "$", message: "Request must be an object." }],
    };

  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== "tool" && key !== "input" && key !== "idempotencyKey")
      issues.push({ path: `$.${key}`, message: "Unknown property." });
  }
  if (!PARENT_TOOL_NAMES.includes(value.tool as ParentToolName))
    issues.push({ path: "$.tool", message: "Tool name is not supported." });
  if (!isRecord(value.input))
    issues.push({ path: "$.input", message: "Input must be an object." });
  else if (Object.keys(value.input).length > 32)
    issues.push({
      path: "$.input",
      message: "Input has more than 32 properties.",
    });
  if (
    value.idempotencyKey !== undefined &&
    (typeof value.idempotencyKey !== "string" ||
      value.idempotencyKey.length < 1 ||
      value.idempotencyKey.length > 256)
  ) {
    issues.push({
      path: "$.idempotencyKey",
      message: "Idempotency key must contain 1 to 256 characters.",
    });
  }
  if (issues.length > 0) return { valid: false, issues };
  return {
    valid: true,
    request: value as unknown as ParentToolRequest,
    issues: [],
  };
}

export function isParentToolRequest(
  value: unknown,
): value is ParentToolRequest {
  return validateParentToolRequest(value).valid;
}
