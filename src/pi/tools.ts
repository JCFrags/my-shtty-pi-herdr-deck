import { boundedSecretFree, DEFAULT_PARENT_TOOL_LIMITS, ParentToolService, type ParentToolName, type ParentToolRequest, type ToolPrincipal } from "./parent-tools.js";
import { isParentToolRequest, PARENT_TOOL_NAMES } from "./parent-tool-schema.js";
import type { PiAdapter, } from "./adapter.js";
import type { PiBrokerClient } from "./broker-client.js";
import type { PiApiLike, PiContextLike } from "./types.js";

const MAX_BODY_BYTES = 262_144;
const MAX_TEXT_BYTES = 16_384;
const resultSchema = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "status", "summary", "findings", "changedFiles", "commandsRun", "tests", "commits", "artifacts", "unresolved", "questions", "recommendedNextAction"],
  properties: {
    schemaVersion: { type: "integer", const: 1 }, status: { type: "string", enum: ["succeeded", "failed", "cancelled"] },
    summary: { type: "string", maxLength: MAX_TEXT_BYTES }, findings: { type: "array", maxItems: 256 }, changedFiles: { type: "array", maxItems: 4096 }, commandsRun: { type: "array", maxItems: 256 }, tests: { type: "array", maxItems: 256 }, commits: { type: "array", maxItems: 256 }, artifacts: { type: "array", maxItems: 128 }, unresolved: { type: "array", maxItems: 256 }, questions: { type: "array", maxItems: 256 }, recommendedNextAction: { type: ["string", "null"], maxLength: MAX_TEXT_BYTES },
  },
};
const questionSchema = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "prompt", "context", "options", "allowFreeform", "defaultOptionId", "timeoutMs"],
  properties: {
    schemaVersion: { type: "integer", const: 1 }, prompt: { type: "string", minLength: 1, maxLength: MAX_TEXT_BYTES }, context: { type: ["string", "null"], maxLength: MAX_TEXT_BYTES },
    options: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: false, required: ["id", "label", "description"], properties: { id: { type: "string", maxLength: 256 }, label: { type: "string", maxLength: 4096 }, description: { type: ["string", "null"], maxLength: 4096 } } } },
    allowFreeform: { type: "boolean" }, defaultOptionId: { type: ["string", "null"] }, timeoutMs: { type: "integer", minimum: 1, maximum: 900_000 },
  },
};
const parentInputSchema = { type: "object", additionalProperties: true, maxProperties: 32 };

interface ToolDefinition { name: string; label: string; description: string; parameters: unknown; execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, context: PiContextLike) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean }>; }
function register(api: PiApiLike, definition: ToolDefinition): void { api.registerTool?.(definition); }
function textResult(value: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } { const safe = boundedSecretFree(value); const encoded = JSON.stringify(safe); return { content: [{ type: "text", text: encoded.length <= DEFAULT_PARENT_TOOL_LIMITS.maxResponseBytes ? encoded : encoded.slice(0, DEFAULT_PARENT_TOOL_LIMITS.maxResponseBytes) + "…" }], details: safe }; }
function assertBoundedBody(value: Record<string, unknown>): void { const encoded = JSON.stringify(value); if (encoded.length > MAX_BODY_BYTES) throw new Error("LIMIT_EXCEEDED"); }
function stripModelIdentity(input: Record<string, unknown>, agentId: string): Record<string, unknown> {
  const copy = { ...input }; delete copy.principal; delete copy.parentAgentId;
  return { ...copy, parentAgentId: agentId };
}

export function registerManagedChildTools(api: PiApiLike, adapter: PiAdapter, client: PiBrokerClient): void {
  register(api, { name: "orchestrator_result", label: "Publish orchestrator result", description: "Publish the single structured terminal result for the current managed task. Correlation identity is supplied by the adapter.", parameters: resultSchema, async execute(_id, params, signal) {
    if (signal.aborted) throw new Error("CANCELLED");
    const assignment = adapter.assignmentForTools(); if (!assignment) throw new Error("RUN_MISMATCH");
    assertBoundedBody(params);
    await client.request("agent.get", { agentId: assignment.agentId });
    const result = await client.request("result.publish", { agentId: assignment.agentId, taskId: assignment.taskId, runId: assignment.runId, assignmentGeneration: assignment.assignmentGeneration, result: params });
    return textResult(result);
  } });
  register(api, { name: "orchestrator_ask", label: "Ask orchestrator question", description: "Ask one blocking structured question for the current managed task. Correlation identity is supplied by the adapter.", parameters: questionSchema, async execute(_id, params, signal) {
    if (signal.aborted) throw new Error("CANCELLED");
    const assignment = adapter.assignmentForTools(); if (!assignment) throw new Error("RUN_MISMATCH");
    assertBoundedBody(params);
    await client.request("agent.get", { agentId: assignment.agentId });
    const result = await client.request("question.open", { agentId: assignment.agentId, taskId: assignment.taskId, runId: assignment.runId, assignmentGeneration: assignment.assignmentGeneration, question: params });
    return textResult(result);
  } });
}

export function registerParentTools(api: PiApiLike, adapter: PiAdapter, client: PiBrokerClient): void {
  const principalFromClient = (): ToolPrincipal => { const p = client.principal; return { id: p?.id ?? `pi:${adapter.safeState().agentId}`, kind: "pi_parent", agentId: adapter.safeState().agentId, permissions: p?.permissions ?? ["read:state", "delegate"] }; };
  const broker = { invoke: async (method: string, params: Record<string, unknown>, principal: ToolPrincipal, idempotencyKey?: string) => client.request(method, { ...params, principalId: principal.id, parentAgentId: principal.agentId, ...(idempotencyKey ? { idempotencyKey } : {}) }) };
  const service = new ParentToolService(broker);
  const permissions = new Set(principalFromClient().permissions);
  for (const tool of PARENT_TOOL_NAMES) {
    if (tool === "delegate" && !permissions.has("delegate") && !permissions.has("manage:all")) continue;
    register(api, { name: tool, label: `Orchestrator ${tool}`, description: `Use broker method for ${tool}. The broker checks current state and parent scope on every call.`, parameters: { type: "object", additionalProperties: false, properties: { input: parentInputSchema, idempotencyKey: { type: "string", minLength: 1, maxLength: 256 } }, required: ["input"] }, async execute(_id, params, signal) {
      const raw = params.input; if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_REQUEST");
      const principal = principalFromClient(); const state = adapter.safeState(); await client.request("agent.get", { agentId: state.agentId });
      const request: ParentToolRequest = { tool: tool as ParentToolName, input: stripModelIdentity(raw as Record<string, unknown>, state.agentId), ...(typeof params.idempotencyKey === "string" ? { idempotencyKey: params.idempotencyKey } : {}) };
      if (!isParentToolRequest(request)) throw new Error("INVALID_REQUEST");
      const response = await service.execute(request, principal, signal); if (!response.ok) throw new Error(response.error?.code ?? "REQUEST_FAILED"); return textResult(response.result);
    } });
  }
}

export function registerOrchestratorTools(api: PiApiLike, adapter: PiAdapter, client: PiBrokerClient, managed: boolean): void { if (managed) registerManagedChildTools(api, adapter, client); else registerParentTools(api, adapter, client); }
