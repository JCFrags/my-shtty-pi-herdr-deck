import type { GitEvidence } from "../git/porcelain.js";

export type ResultStatus = "succeeded" | "failed" | "cancelled";
export interface ResultBody {
  schemaVersion: 1;
  status: ResultStatus;
  summary: string;
  findings: Array<{
    severity: "info" | "low" | "medium" | "high" | "critical";
    title: string;
    description: string;
    evidence: string[];
    resolved: boolean;
  }>;
  changedFiles: Array<{
    path: string;
    change: "added" | "modified" | "deleted" | "renamed" | "unknown";
    previousPath?: string | null;
  }>;
  commandsRun: Array<{
    command: string;
    exitCode: number | null;
    outcome: "passed" | "failed" | "cancelled" | "unknown";
  }>;
  tests: Array<{
    name: string;
    command: string | null;
    status: "passed" | "failed" | "cancelled" | "unknown";
    passed: number | null;
    failed: number | null;
    skipped: number | null;
    evidence: string | null;
  }>;
  commits: Array<{ sha: string; subject: string }>;
  artifacts: Array<{
    kind: "text" | "json" | "patch" | "log" | "report" | "other";
    path: string;
    description: string;
    mediaType: string;
  }>;
  unresolved: Array<{ title: string; description: string; blocking: boolean }>;
  questions: Array<{ questionId: string; summary: string; answered: boolean }>;
  recommendedNextAction: string | null;
}
export interface ResultEnvelope extends ResultBody {
  id: string;
  taskId: string;
  runId: string;
  agentId: string;
  assignmentGeneration: number;
  publishedAt: string;
  payloadHash: string;
  validation: {
    schemaValid: true;
    correlationValid: true;
    piSettled: boolean;
    gitEvidenceStatus:
      "not_applicable" | "pending" | "consistent" | "warning" | "contradiction";
    testEvidenceStatus: "not_reported" | "reported" | "verified";
  };
}
export interface RunBinding {
  runId: string;
  taskId: string;
  agentId: string;
  assignmentGeneration: number;
  state:
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
  piSettled: boolean;
  terminalError?: boolean;
  resultRecoveryCount: 0 | 1;
  resultId?: string;
}
export interface QuestionBody {
  schemaVersion: 1;
  prompt: string;
  context: string | null;
  options: Array<{ id: string; label: string; description: string | null }>;
  allowFreeform: boolean;
  defaultOptionId: string | null;
  timeoutMs: number;
}
export interface QuestionRecord extends QuestionBody {
  id: string;
  taskId: string;
  runId: string;
  agentId: string;
  assignmentGeneration: number;
  state: "open" | "answered" | "cancelled" | "timed_out";
  askedAt: string;
  answeredAt?: string;
  answeredBy?: string;
  answer?: { optionId?: string; text?: string };
}
export interface EvidenceSummary {
  gitEvidenceStatus: ResultEnvelope["validation"]["gitEvidenceStatus"];
  testEvidenceStatus: ResultEnvelope["validation"]["testEvidenceStatus"];
  git?: GitEvidence;
}
export interface ResultEvent {
  type: string;
  payload: unknown;
  refs: Record<string, string>;
}
