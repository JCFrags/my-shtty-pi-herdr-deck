export type ErrorCode =
  | "AUTH_FAILED"
  | "PERMISSION_DENIED"
  | "LIMIT_EXCEEDED"
  | "STATE_CORRUPT"
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "BROKER_READ_ONLY"
  | "IDEMPOTENCY_CONFLICT"
  | "EVENT_CURSOR_EXPIRED"
  | "CURSOR_INVALID"
  | "TIMEOUT"
  | "AGENT_REPLACED"
  | "AGENT_NOT_FOUND"
  | "GROUP_NOT_FOUND"
  | "TARGET_NOT_FOUND"
  | "PEER_ANSWER_UNAVAILABLE"
  | "AGENT_DISCONNECTED"
  | "AGENT_NOT_IDLE"
  | "AGENT_NOT_WORKING"
  | "PI_CAPABILITY_MISSING"
  | "RESULT_INVALID"
  | "RESULT_ALREADY_PUBLISHED"
  | "RESULT_MISSING"
  | "QUESTION_NOT_FOUND"
  | "QUESTION_ALREADY_ANSWERED"
  | "QUESTION_TIMED_OUT"
  | "RUN_MISMATCH"
  | "TASK_NOT_FOUND"
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_INVALID"
  | "PI_COMMAND_REJECTED"
  | "HERDR_UNAVAILABLE"
  | "HERDR_IDENTITY_MISMATCH"
  | "TASK_TERMINAL";
export class OrchestratorError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}
export function safeError(error: unknown): { code: string; message: string } {
  return error instanceof OrchestratorError
    ? { code: error.code, message: error.message }
    : { code: "INTERNAL_ERROR", message: "The operation failed." };
}
