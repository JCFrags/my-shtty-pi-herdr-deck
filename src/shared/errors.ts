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
  | "AGENT_DISCONNECTED"
  | "AGENT_NOT_IDLE"
  | "AGENT_NOT_WORKING"
  | "PI_CAPABILITY_MISSING";
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
