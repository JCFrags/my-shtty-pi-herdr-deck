import type { EntityKind } from "../shared/ids.js";
export type AgentState = "provisioning" | "starting" | "idle" | "working" | "blocked" | "stopping" | "stopped" | "failed" | "orphaned" | "replaced";
export type TaskState = "draft" | "queued" | "provisioning" | "assigned" | "running" | "blocked" | "collecting" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type RunState = "created" | "prompting" | "working" | "blocked" | "settled" | "result_pending" | "result_pending_missing" | "succeeded" | "failed" | "cancelled" | "timed_out" | "lost";
export interface Task { id: string; title: string; objective: string; state: TaskState; createdAt: string; parentAgentId?: string; currentRunId?: string; resultId?: string; }
export interface Run { id: string; taskId: string; state: RunState; agentId?: string; assignmentGeneration: number; settled: boolean; resultId?: string; }
export interface Agent { id: string; state: AgentState; generation: number; parentAgentId?: string; terminalId?: string; piSessionId?: string; currentRunId?: string; }
export interface Workflow { id: string; state: "created" | "running" | "blocked" | "succeeded" | "failed" | "cancelled"; taskIds: string[]; }
export interface OrchestrationState { schemaVersion: number; lastEventSeq: number; lastEventHash: string; tasks: Record<string, Task>; runs: Record<string, Run>; agents: Record<string, Agent>; workflows: Record<string, Workflow>; idempotency: Record<string, { principalId: string; method: string; response: unknown }>; }
export interface StoredEvent { schemaVersion: 1; seq: number; id: string; timestamp: string; type: string; actor: { principalId: string; kind: string }; entityRefs: Record<string, string>; payload: unknown; prevHash: string; hash: string; }
export type EventInput = { type: string; actor: { principalId: string; kind: string }; entityRefs?: Record<string, string>; payload: unknown };
export type Entity = Agent | Task | Run | Workflow;
export type { EntityKind };
