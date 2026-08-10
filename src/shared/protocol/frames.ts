export const PROTOCOL_MAJOR = 1 as const;
export type PrincipalKind = "human" | "pi_parent" | "pi_child" | "observer" | "system";
export interface HelloRequest { v: 1; type: "hello"; id: string; client: { kind: string; name: string; version: string; capabilities: string[] }; sessionKey: string; auth: { kind: "client_secret" | "agent_token"; secret?: string; token?: string; agentId?: string; generation?: number; piSessionId?: string }; }
export interface RequestFrame { v: 1; type: "request"; id: string; method: string; params: Record<string, unknown>; idempotencyKey?: string; }
export interface ResponseFrame { v: 1; type: "response"; id: string; method: string; ok: boolean; result?: unknown; error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }; }
export interface EventFrame { v: 1; type: "event"; seq: number; id: string; event: string; timestamp: string; refs: Record<string, string>; data: unknown; }
export type Frame = HelloRequest | RequestFrame | ResponseFrame | EventFrame;
