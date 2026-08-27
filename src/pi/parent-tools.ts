export type ParentToolName =
  | "delegate_compact"
  | "delegate"
  | "agent_spawn"
  | "agent_model_options"
  | "agent_list"
  | "agent_get"
  | "agent_prompt"
  | "agent_steer"
  | "agent_ask"
  | "agent_wait"
  | "coordination_wait"
  | "coordination_signal"
  | "group_create"
  | "group_list"
  | "group_get"
  | "group_wait"
  | "group_stop"
  | "group_close"
  | "agent_result"
  | "agent_answer"
  | "agent_interrupt"
  | "agent_stop"
  | "agent_close"
  | "task_list"
  | "task_get"
  | "task_collect"
  | "task_cancel"
  | "task_metadata"
  | "task_transcript_close";
export interface ToolPrincipal {
  readonly id: string;
  readonly kind: "human" | "pi_parent" | "pi_child";
  readonly agentId?: string;
  readonly permissions: readonly string[];
}
export interface ParentToolRequest {
  readonly tool: ParentToolName;
  readonly input: Record<string, unknown>;
  readonly idempotencyKey?: string;
}
export interface ParentToolResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
    readonly details?: unknown;
    readonly remediation?: string;
  };
  readonly retrieval?: {
    readonly method: string;
    readonly id: string;
    readonly nextCursor: string | null;
  };
}
export interface ParentToolBroker {
  invoke(
    method: string,
    params: Record<string, unknown>,
    principal: ToolPrincipal,
    idempotencyKey?: string,
  ): Promise<unknown>;
}
export interface ParentToolLimits {
  readonly maxResponseBytes: number;
  readonly maxItems: number;
  readonly maxTextBytes: number;
}
export const DEFAULT_PARENT_TOOL_LIMITS: ParentToolLimits = Object.freeze({
  maxResponseBytes: 32_768,
  maxItems: 64,
  maxTextBytes: 8_192,
});
const SECRET_KEY =
  /(?:token|secret|password|cookie|credential|private.?key|socket.?path|api.?key)/iu;
function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "…";
  let end = Math.min(
    value.length,
    Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8")),
  );
  while (
    end > 0 &&
    Buffer.byteLength(value.slice(0, end), "utf8") >
      maxBytes - Buffer.byteLength(marker, "utf8")
  )
    end--;
  return `${value.slice(0, end)}${marker}`;
}
function safeProjection(value: unknown, limits: ParentToolLimits): unknown {
  if (typeof value === "string")
    return truncateUtf8(value, limits.maxTextBytes);
  if (Array.isArray(value))
    return value
      .slice(0, limits.maxItems)
      .map((item) => safeProjection(item, limits));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, limits.maxItems)
        .map(([key, item]) => [
          key,
          SECRET_KEY.test(key) ? "[redacted]" : safeProjection(item, limits),
        ]),
    );
  return value;
}
export function boundedSecretFree(
  value: unknown,
  limits: ParentToolLimits = DEFAULT_PARENT_TOOL_LIMITS,
): unknown {
  return safeProjection(value, limits);
}
import { parentToolMethod } from "./parent-tool-schema.js";

function methodForTool(tool: ParentToolName): string {
  return parentToolMethod(tool);
}

/** Map public tool fields to the broker contract without forwarding aliases. */
export function mapParentToolInput(
  tool: ParentToolName,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (
    tool !== "agent_interrupt" &&
    tool !== "agent_stop" &&
    tool !== "agent_close"
  )
    return { ...input };
  const { assignmentGeneration, agentId, runId, reason, ...operation } = input;
  return {
    agentId,
    ...(runId !== undefined ? { runId } : {}),
    ...(assignmentGeneration !== undefined ? { assignmentGeneration } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...operation,
  };
}
export class ParentToolService {
  readonly #broker: ParentToolBroker;
  readonly #limits: ParentToolLimits;
  constructor(
    broker: ParentToolBroker,
    limitsOrLegacy:
      Partial<ParentToolLimits> | ReadonlyMap<string, string | undefined> = {},
    legacyLimits: Partial<ParentToolLimits> = {},
  ) {
    this.#broker = broker;
    const limits =
      limitsOrLegacy instanceof Map ? legacyLimits : limitsOrLegacy;
    this.#limits = { ...DEFAULT_PARENT_TOOL_LIMITS, ...limits };
  }
  async execute(
    request: ParentToolRequest,
    principal: ToolPrincipal,
    signal?: AbortSignal,
  ): Promise<ParentToolResponse> {
    if (signal?.aborted)
      return {
        ok: false,
        error: { code: "CANCELLED", message: "The request was cancelled." },
      };
    if (
      (request.tool === "delegate" || request.tool === "delegate_compact") &&
      !principal.permissions.includes("delegate") &&
      !principal.permissions.includes("manage:all")
    )
      return {
        ok: false,
        error: {
          code: "PERMISSION_DENIED",
          message: "Delegation is not permitted for this profile.",
        },
      };
    try {
      const result = safeProjection(
        await this.#broker.invoke(
          methodForTool(request.tool),
          mapParentToolInput(request.tool, request.input),
          principal,
          request.idempotencyKey,
        ),
        this.#limits,
      );
      const encoded = JSON.stringify(result);
      if (Buffer.byteLength(encoded, "utf8") <= this.#limits.maxResponseBytes)
        return { ok: true, result };
      const candidate =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as Record<string, unknown>).retrieval
          : undefined;
      const retrieval =
        candidate && typeof candidate === "object" && !Array.isArray(candidate)
          ? (candidate as Record<string, unknown>)
          : undefined;
      const safeRetrieval =
        retrieval &&
        typeof retrieval.method === "string" &&
        typeof retrieval.id === "string" &&
        Buffer.byteLength(retrieval.method, "utf8") <= 256 &&
        Buffer.byteLength(retrieval.id, "utf8") <= 256
          ? {
              method: retrieval.method,
              id: retrieval.id,
              nextCursor:
                typeof retrieval.nextCursor === "string" ||
                retrieval.nextCursor === null
                  ? retrieval.nextCursor
                  : null,
            }
          : undefined;
      if (!safeRetrieval)
        return {
          ok: false,
          error: {
            code: "RESPONSE_TOO_LARGE",
            message: "The broker response exceeded the safe response limit.",
          },
        };
      const truncated = {
        truncated: true,
        preview: safeProjection(result, {
          ...this.#limits,
          maxResponseBytes: 0,
          maxItems: 8,
          maxTextBytes: 1024,
        }),
        retrieval: safeRetrieval,
      };
      return { ok: true, result: truncated, retrieval: safeRetrieval };
    } catch (error) {
      const failure = error as Error & {
        code?: unknown;
        retryable?: unknown;
        details?: unknown;
        remediation?: unknown;
      };
      const code =
        typeof failure.code === "string" &&
        /^[A-Z0-9_]{1,64}$/u.test(failure.code)
          ? failure.code
          : "REQUEST_FAILED";
      const message =
        typeof failure.message === "string" &&
        Buffer.byteLength(failure.message, "utf8") <= 4096
          ? failure.message
          : "The broker rejected the parent tool request.";
      return {
        ok: false,
        error: {
          code,
          message,
          ...(typeof failure.retryable === "boolean"
            ? { retryable: failure.retryable }
            : {}),
          ...(failure.details !== undefined
            ? { details: boundedSecretFree(failure.details) }
            : {}),
          ...(typeof failure.remediation === "string" &&
          Buffer.byteLength(failure.remediation, "utf8") <= 4096
            ? { remediation: failure.remediation }
            : {}),
        },
      };
    }
  }
}
