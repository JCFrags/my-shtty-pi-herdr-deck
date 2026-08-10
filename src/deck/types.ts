import type { Agent, Run, Task, Workflow } from "../state/types.js";

export interface DeckQuestion {
  id: string;
  taskId?: string;
  agentId?: string;
  prompt: string;
  options?: string[];
  answered?: boolean;
  timeoutAt?: string;
}

export interface DeckResult {
  id: string;
  taskId?: string;
  runId?: string;
  status: "accepted" | "failed" | "missing" | "pending";
  summary?: string;
  evidence?: string[];
  tests?: string[];
  artifacts?: string[];
  unresolved?: string[];
}

export interface DeckSnapshot {
  seq: number;
  agents: Agent[];
  tasks: Task[];
  runs?: Run[];
  workflows: Workflow[];
  questions?: DeckQuestion[];
  results?: DeckResult[];
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
  questions: Map<string, DeckQuestion>;
  results: Map<string, DeckResult>;
}

export type DeckNotificationKind =
  "blocked" | "failure" | "timeout" | "budget" | "result" | "recovery";
export interface DeckNotification {
  id: string;
  kind: DeckNotificationKind;
  text: string;
  seq: number;
}
