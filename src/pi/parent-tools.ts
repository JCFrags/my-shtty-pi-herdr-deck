/** Structured parent-facing Pi tools. The broker remains the source of truth. */

export type ParentToolName =
  | "delegate"
  | "agent_spawn"
  | "agent_list"
  | "agent_get"
  | "agent_prompt"
  | "agent_steer"
  | "agent_wait"
  | "agent_result"
  | "agent_answer"
  | "agent_interrupt"
  | "agent_stop"
  | "agent_close"
  | "task_list"
  | "task_get"
  | "task_collect"
  | "task_cancel";

export interface ParentToolSchema {
  readonly type: "object";
  readonly properties: Record<string, { readonly type: string; readonly description?: string }>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface ParentToolDescriptor {
  readonly name: ParentToolName;
  readonly description: string;
  /** Pi tool APIs call this field `parameters`; inputSchema is retained for broker clients. */
  readonly parameters: ParentToolSchema;
  readonly inputSchema: ParentToolSchema;
}

export interface ParentPrincipal {
  readonly id: string;
  readonly kind: "human" | "adopted" | "managed" | "observer";
  readonly agentId?: string;
  readonly permissions: readonly string[];
}

export interface ParentToolBroker {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface ParentToolContext {
  readonly principal: ParentPrincipal;
  readonly broker: ParentToolBroker;
  /** Resolves canonical graph scope. It must query current broker state. */
  readonly canAccessAgent?: (agentId: string, principal: ParentPrincipal) => boolean | Promise<boolean>;
  readonly canAccessTask?: (taskId: string, principal: ParentPrincipal) => boolean | Promise<boolean>;
}

const field = (type: string, description: string) => ({ type, description });
const anyObject = (properties: Record<string, { readonly type: string; readonly description?: string }>): ParentToolSchema => ({
  type: "object",
  properties,
  additionalProperties: false,
});

const tool = (name: ParentToolName, description: string, inputSchema: ParentToolSchema): ParentToolDescriptor => ({ name, description, inputSchema, parameters: inputSchema });

const definitions: readonly ParentToolDescriptor[] = [
  tool("delegate", "Create and optionally wait for descendant work.", anyObject({ mode: field("string", "single, parallel, chain, or dag"), objective: field("string", "Bounded task objective"), profileId: field("string", "Profile identifier"), wait: field("boolean", "Wait for terminal or blocked state"), timeoutMs: field("integer", "Finite wait timeout") })),
  tool("agent_spawn", "Provision one authorized descendant agent.", anyObject({ task: field("object", "Task contract"), profileId: field("string", "Profile identifier"), wait: field("boolean", "Wait for terminal or blocked state") })),
  tool("agent_list", "List agents visible to this parent.", anyObject({ state: field("string", "Optional state filter"), parentAgentId: field("string", "Optional parent filter"), limit: field("integer", "Bounded item count"), cursor: field("string", "Opaque retrieval cursor") })),
  tool("agent_get", "Read one visible agent by stable ID.", anyObject({ agentId: field("string", "Stable agent ID") })),
  tool("agent_prompt", "Send a normal prompt to an authorized idle agent.", anyObject({ agentId: field("string", "Stable agent ID"), message: field("string", "Prompt text"), timeoutMs: field("integer", "Finite acceptance timeout") })),
  tool("agent_steer", "Send an authorized steer or follow-up to active work.", anyObject({ agentId: field("string", "Stable agent ID"), message: field("string", "Control text"), delivery: field("string", "steer or follow_up"), runId: field("string", "Optional exact run guard") })),
  tool("agent_wait", "Wait on an exact agent task run identity.", anyObject({ agentId: field("string", "Stable agent ID"), taskId: field("string", "Stable task ID"), runId: field("string", "Stable run ID"), timeoutMs: field("integer", "Finite timeout") })),
  tool("agent_result", "Read a bounded result for an authorized task.", anyObject({ taskId: field("string", "Stable task ID"), resultId: field("string", "Optional result ID"), limit: field("integer", "Bounded output limit") })),
  tool("agent_answer", "Answer one authorized descendant question.", anyObject({ questionId: field("string", "Stable question ID"), answer: field("object", "Structured answer") })),
  tool("agent_interrupt", "Request interruption of an authorized agent.", anyObject({ agentId: field("string", "Stable agent ID"), runId: field("string", "Optional exact run guard") })),
  tool("agent_stop", "Stop an authorized managed agent.", anyObject({ agentId: field("string", "Stable agent ID"), reason: field("string", "Required reason"), force: field("boolean", "Use forced stop after grace") })),
  tool("agent_close", "Close an authorized terminal agent after confirmation.", anyObject({ agentId: field("string", "Stable agent ID"), confirm: field("boolean", "Explicit confirmation") })),
  tool("task_list", "List visible tasks with bounded pagination.", anyObject({ state: field("string", "Optional state filter"), limit: field("integer", "Bounded item count"), cursor: field("string", "Opaque retrieval cursor") })),
  tool("task_get", "Read one visible task by stable ID.", anyObject({ taskId: field("string", "Stable task ID") })),
  tool("task_collect", "Collect bounded projections for visible tasks.", anyObject({ taskIds: field("array", "Stable task IDs"), limit: field("integer", "Bounded output limit") })),
  tool("task_cancel", "Cancel an authorized task and optional descendants.", anyObject({ taskId: field("string", "Stable task ID"), reason: field("string", "Required reason"), cascade: field("boolean", "Cancel descendants") })),
];

export const PARENT_TOOL_DESCRIPTORS: readonly ParentToolDescriptor[] = definitions;

const methods: Record<ParentToolName, string> = {
  delegate: "delegate.execute", agent_spawn: "agent.spawn", agent_list: "agent.list", agent_get: "agent.get",
  agent_prompt: "agent.prompt", agent_steer: "agent.steer", agent_wait: "agent.wait", agent_result: "result.get",
  agent_answer: "question.answer", agent_interrupt: "agent.interrupt", agent_stop: "agent.stop", agent_close: "agent.close",
  task_list: "task.list", task_get: "task.get", task_collect: "task.collect", task_cancel: "task.cancel",
};

const management = new Set<ParentToolName>(["delegate", "agent_spawn", "agent_prompt", "agent_steer", "agent_answer", "agent_interrupt", "agent_stop", "agent_close", "task_cancel"]);
const targetAgent = (params: Record<string, unknown>): string | undefined => typeof params.agentId === "string" ? params.agentId : undefined;
const targetTask = (params: Record<string, unknown>): string | undefined => typeof params.taskId === "string" ? params.taskId : undefined;

export async function dispatchParentTool(name: ParentToolName, params: Record<string, unknown>, context: ParentToolContext): Promise<unknown> {
  if (!definitions.some((item) => item.name === name)) throw new Error("UNKNOWN_PARENT_TOOL");
  if (context.principal.kind === "observer" || !context.principal.permissions.includes("read:state")) throw new Error("PERMISSION_DENIED");
  if (management.has(name) && !context.principal.permissions.includes("delegate") && !context.principal.permissions.includes("manage:all")) throw new Error("PERMISSION_DENIED");
  const agentId = targetAgent(params);
  if (agentId && !context.principal.permissions.includes("manage:all")) {
    const allowed = context.canAccessAgent ? await context.canAccessAgent(agentId, context.principal) : agentId === context.principal.agentId;
    if (!allowed) throw new Error("PERMISSION_DENIED");
  }
  const taskId = targetTask(params);
  if (taskId && !context.principal.permissions.includes("manage:all")) {
    if (!context.canAccessTask || !(await context.canAccessTask(taskId, context.principal))) throw new Error("PERMISSION_DENIED");
  }
  const forwarded = { ...params };
  if ((name === "delegate" || name === "agent_spawn") && context.principal.agentId) {
    if (typeof forwarded.parentAgentId === "string" && forwarded.parentAgentId !== context.principal.agentId) throw new Error("PERMISSION_DENIED");
    forwarded.parentAgentId = context.principal.agentId;
  }
  const encoded = JSON.stringify(forwarded);
  if (encoded === undefined || encoded.length > 262_144) throw new Error("LIMIT_EXCEEDED");
  return await context.broker.request(methods[name], forwarded);
}
