import type { EntityKind } from "../shared/ids.js";
export type AgentState =
  | "provisioning"
  | "starting"
  | "idle"
  | "working"
  | "blocked"
  | "stopping"
  | "stopped"
  | "failed"
  | "orphaned"
  | "replaced";
export type TaskState =
  | "draft"
  | "queued"
  | "provisioning"
  | "assigned"
  | "running"
  | "blocked"
  | "collecting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";
export type RunState =
  | "created"
  | "prompting"
  | "working"
  | "blocked"
  | "settled"
  | "result_pending"
  | "result_pending_missing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "lost";
export interface Task {
  id: string;
  title: string;
  objective: string;
  state: TaskState;
  createdAt: string;
  parentAgentId?: string;
  workflowId?: string;
  profileId?: string;
  constraints?: string[];
  dependencies?: string[];
  currentRunId?: string;
  runIds?: string[];
  resultId?: string;
  timeoutAt?: string;
}
export interface Run {
  id: string;
  taskId: string;
  state: RunState;
  agentId?: string;
  agentGeneration?: number;
  assignmentId?: string;
  assignmentGeneration: number;
  piSessionId?: string;
  terminalId?: string;
  settled: boolean;
  resultId?: string;
  timeoutAt?: string;
  cancelled?: boolean;
}
export interface Agent {
  id: string;
  state: AgentState;
  generation: number;
  managed?: boolean;
  parentAgentId?: string;
  depth?: number;
  displayName?: string;
  herdrName?: string;
  profileId?: string;
  terminalId?: string;
  paneId?: string;
  workspaceId?: string;
  tabId?: string;
  piSessionId?: string;
  connectionGeneration?: number;
  detectedKind?: string;
  coarseStatus?: "idle" | "working" | "blocked" | "done" | "unknown";
  currentRunId?: string;
  currentAssignmentGeneration?: number;
  tokenDigest?: string;
}
export interface ResultRecord {
  id: string;
  taskId: string;
  runId: string;
  agentId: string;
  status: "succeeded" | "failed" | "cancelled";
  payloadHash: string;
  piSettled: boolean;
}
export interface QuestionRecord {
  id: string;
  taskId: string;
  runId: string;
  agentId: string;
  state: "open" | "answered" | "cancelled" | "timed_out";
  answeredBy?: string;
}
export interface Workflow {
  id: string;
  state:
    "created" | "running" | "blocked" | "succeeded" | "failed" | "cancelled";
  taskIds: string[];
}
export interface OrchestrationState {
  schemaVersion: number;
  lastEventSeq: number;
  lastEventHash: string;
  tasks: Record<string, Task>;
  runs: Record<string, Run>;
  agents: Record<string, Agent>;
  workflows: Record<string, Workflow>;
  results?: Record<string, ResultRecord>;
  questions?: Record<string, QuestionRecord>;
  herdrResources?: Record<
    string,
    {
      agentId: string;
      state: string;
      paneId?: string;
      tabId?: string;
      worktreeId?: string;
      worktreePath?: string;
      reason?: string;
      parentAgentId?: string;
      ownerId?: string;
      terminalId?: string;
      sessionId?: string;
      generation?: number;
      tokenDigest?: string;
      promptFileDev?: number;
      promptFileIno?: number;
      tokenFileDev?: number;
      tokenFileIno?: number;
      registrationDeadline?: string;
      cleanupOutcome?: string;
      dirty?: boolean;
      replaced?: boolean;
      orphaned?: boolean;
      unknown?: boolean;
      parentGitRoot?: string;
      parentGitHead?: string;
      parentGitBranch?: string;
      parentGitChangedFiles?: string[];
      worktreeGitRoot?: string;
      worktreeGitHead?: string;
      worktreeGitBranch?: string;
    }
  >;
  idempotency: Record<
    string,
    {
      principalId: string;
      method: string;
      paramsHash?: string;
      response: unknown;
    }
  >;
}
export interface StoredEvent {
  schemaVersion: 1;
  seq: number;
  id: string;
  timestamp: string;
  type: string;
  actor: { principalId: string; kind: string };
  entityRefs: Record<string, string>;
  payload: unknown;
  prevHash: string;
  hash: string;
}
export type EventInput = {
  type: string;
  actor: { principalId: string; kind: string };
  entityRefs?: Record<string, string>;
  payload: unknown;
};
export type Entity = Agent | Task | Run | Workflow;
export type { EntityKind };
