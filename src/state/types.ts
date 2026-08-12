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
export interface ErrorSummary {
  code: "TIMEOUT" | "BUDGET_EXCEEDED";
  message: string;
}
export interface Task {
  id: string;
  title: string;
  objective: string;
  state: TaskState;
  createdAt: string;
  parentAgentId?: string;
  workflowId?: string;
  profileId?: string;
  isolationMode?:
    | "profile-default"
    | "shared-readonly"
    | "worktree"
    | "shared-explicit"
    | "reuse-worktree";
  constraints?: string[];
  dependencies?: string[];
  currentRunId?: string;
  assignedAgentId?: string;
  runIds?: string[];
  resultId?: string;
  timeoutAt?: string;
  terminalReason?: ErrorSummary;
  project?: Record<string, unknown>;
}
export interface Run {
  id: string;
  taskId: string;
  state: RunState;
  agentId?: string;
  agentGeneration?: number;
  assignmentId?: string;
  assignmentDeliveryState?: "pending" | "accepted" | "failed";
  assignmentConnectionGeneration?: number;
  assignmentGeneration: number;
  agentCycleId?: string;
  firstTurnIndex?: number;
  piSessionId?: string;
  terminalId?: string;
  settled: boolean;
  resultId?: string;
  timeoutAt?: string;
  terminalReason?: ErrorSummary;
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
  cwd?: string;
  worktreeId?: string;
  piSessionId?: string;
  connectionGeneration?: number;
  detectedKind?: string;
  coarseStatus?: "idle" | "working" | "blocked" | "done" | "unknown";
  currentRunId?: string;
  currentAssignmentGeneration?: number;
  lastAdapterSeq?: number;
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
  assignmentGeneration?: number;
  payload?: unknown;
  validation?: Record<string, unknown>;
  publishedAt?: string;
}
export interface QuestionRecord {
  id: string;
  taskId: string;
  runId: string;
  agentId: string;
  state: "open" | "answered" | "cancelled" | "timed_out";
  assignmentGeneration?: number;
  toolCallId?: string;
  payload?: unknown;
  askedAt?: string;
  answeredAt?: string;
  answeredBy?: string;
  answer?: { optionId: string | null; text: string | null };
}
export interface Workflow {
  id: string;
  state:
    "created" | "running" | "blocked" | "succeeded" | "failed" | "cancelled";
  taskIds: string[];
}
export interface AgentGroup {
  id: string;
  name: string;
  agentIds: string[];
  state: "open" | "stopped" | "closed";
  createdAt: string;
  createdBy: string;
  stoppedAt?: string;
  closedAt?: string;
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
  groups?: Record<string, AgentGroup>;
  herdrResources?: Record<
    string,
    {
      agentId: string;
      state: string;
      paneId?: string;
      tabId?: string;
      worktreeId?: string;
      worktreePath?: string;
      workspaceId?: string;
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
