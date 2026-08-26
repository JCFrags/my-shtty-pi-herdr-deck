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
export interface QuestionBody {
  schemaVersion: 1;
  prompt: string;
  context: string | null;
  options: Array<{ id: string; label: string; description: string | null }>;
  allowFreeform: boolean;
  defaultOptionId: string | null;
  timeoutMs: number;
}
