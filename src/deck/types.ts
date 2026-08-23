import type { Agent, Run, Task, Workflow } from "../state/types.js";
import type { ProviderProjection } from "../shared/provider-projections.js";

export interface DeckQuestionOption {
  id: string;
  label: string;
}

export interface DeckQuestion {
  id: string;
  taskId?: string;
  runId?: string;
  agentId?: string;
  prompt: string;
  options?: DeckQuestionOption[];
  allowFreeform?: boolean;
  answered?: boolean;
  state?: "open" | "answered" | "cancelled" | "timed_out";
  timeoutAt?: string;
}

export interface DeckResult {
  id: string;
  taskId?: string;
  runId?: string;
  status: "accepted" | "failed" | "missing" | "pending";
  summary?: string;
  evidence?: string[];
  findings?: string[];
  tests?: string[];
  artifacts?: string[];
  unresolved?: string[];
}

/** A deck-only compatibility view of the lightweight group broker surface. */
export interface DeckGroup {
  id: string;
  name?: string;
  title?: string;
  state: string;
  agentIds?: string[];
  taskIds?: string[];
  runIds?: string[];
  questionIds?: string[];
  resultIds?: string[];
  parentAgentId?: string;
  objective?: string;
  blockedReason?: string;
}

export interface DeckSnapshot {
  seq: number;
  agents: Agent[];
  tasks: Task[];
  runs?: Run[];
  workflows: Workflow[];
  groups?: DeckGroup[];
  questions?: DeckQuestion[];
  results?: DeckResult[];
  providerProjections?: ProviderProjection[];
}

export interface DeckEvent {
  seq: number;
  id: string;
  event: string;
  timestamp?: string;
  refs: Record<string, string>;
  data: unknown;
}

export interface DeckState {
  seq: number;
  agents: Map<string, Agent>;
  tasks: Map<string, Task>;
  runs: Map<string, Run>;
  workflows: Map<string, Workflow>;
  groups: Map<string, DeckGroup>;
  questions: Map<string, DeckQuestion>;
  results: Map<string, DeckResult>;
  providerProjections: Map<string, ProviderProjection>;
}

export type DeckNotificationKind =
  "blocked" | "failure" | "timeout" | "budget" | "result" | "recovery";
export interface DeckNotification {
  id: string;
  kind: DeckNotificationKind;
  text: string;
  seq: number;
}
