export type ParentToolName = "delegate" | "agent_spawn" | "agent_list" | "agent_get" | "agent_prompt" | "agent_steer" | "agent_wait" | "agent_result" | "agent_answer" | "agent_interrupt" | "agent_stop" | "agent_close" | "task_list" | "task_get" | "task_collect" | "task_cancel";
export interface ToolPrincipal { readonly id: string; readonly kind: "human" | "pi_parent" | "pi_child"; readonly agentId?: string; readonly permissions: readonly string[]; }
export interface ParentToolRequest { readonly tool: ParentToolName; readonly input: Record<string, unknown>; readonly idempotencyKey?: string; }
export interface ParentToolResponse { readonly ok: boolean; readonly result?: unknown; readonly error?: { readonly code: string; readonly message: string }; readonly retrieval?: { readonly method: string; readonly id: string; readonly nextCursor: string | null }; }
export interface ParentToolBroker {
  invoke(method: string, params: Record<string, unknown>, principal: ToolPrincipal, idempotencyKey?: string): Promise<unknown>;
}
export interface ParentToolLimits { readonly maxResponseBytes: number; readonly maxItems: number; readonly maxTextBytes: number; }
export const DEFAULT_PARENT_TOOL_LIMITS: ParentToolLimits = Object.freeze({ maxResponseBytes: 32_768, maxItems: 64, maxTextBytes: 8_192 });
function descendant(principal: ToolPrincipal, target: unknown, parents: ReadonlyMap<string, string | undefined>): boolean {
  if (principal.permissions.includes("manage:all")) return true;
  if (typeof principal.agentId !== "string" || typeof target !== "string") return false;
  let current: string | undefined = target;
  for (let depth = 0; depth <= 4 && current; depth++) { if (current === principal.agentId) return true; current = parents.get(current); }
  return false;
}
function safeProjection(value: unknown, limits: ParentToolLimits): unknown {
  if (typeof value === "string") return value.length <= limits.maxTextBytes ? value : `${value.slice(0, limits.maxTextBytes)}…`;
  if (Array.isArray(value)) return value.slice(0, limits.maxItems).map((item) => safeProjection(item, limits));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, limits.maxItems).map(([key, item]) => [key, safeProjection(item, limits)]));
  return value;
}
function methodForTool(tool: ParentToolName): string { return tool.replaceAll("_", "."); }
export class ParentToolService {
  readonly #broker: ParentToolBroker; readonly #parents: ReadonlyMap<string, string | undefined>; readonly #limits: ParentToolLimits;
  constructor(broker: ParentToolBroker, parents: ReadonlyMap<string, string | undefined> = new Map(), limits: Partial<ParentToolLimits> = {}) { this.#broker = broker; this.#parents = parents; this.#limits = { ...DEFAULT_PARENT_TOOL_LIMITS, ...limits }; }
  async execute(request: ParentToolRequest, principal: ToolPrincipal, signal?: AbortSignal): Promise<ParentToolResponse> {
    if (signal?.aborted) return { ok: false, error: { code: "CANCELLED", message: "The request was cancelled." } };
    const target = request.input.agentId ?? request.input.taskId ?? request.input.questionId;
    if (!["agent_list", "task_list", "delegate"].includes(request.tool) && !descendant(principal, target, this.#parents)) return { ok: false, error: { code: "PERMISSION_DENIED", message: "The target is outside the parent descendant scope." } };
    if (request.tool === "delegate" && !principal.permissions.includes("delegate") && !principal.permissions.includes("manage:all")) return { ok: false, error: { code: "PERMISSION_DENIED", message: "Delegation is not permitted for this profile." } };
    try {
      const result = safeProjection(await this.#broker.invoke(methodForTool(request.tool), request.input, principal, request.idempotencyKey), this.#limits);
      const encoded = JSON.stringify(result);
      if (encoded.length <= this.#limits.maxResponseBytes) return { ok: true, result };
      const id = typeof result === "object" && result !== null && "workflowId" in result ? String((result as { workflowId: unknown }).workflowId) : "result";
      return { ok: true, result: { truncated: true, retrieval: { method: `${methodForTool(request.tool)}.get`, id }, preview: safeProjection(result, { ...this.#limits, maxResponseBytes: 0, maxItems: 8, maxTextBytes: 1024 }) }, retrieval: { method: `${methodForTool(request.tool)}.get`, id, nextCursor: null } };
    } catch { return { ok: false, error: { code: "REQUEST_FAILED", message: "The broker rejected the parent tool request." } }; }
  }
}
