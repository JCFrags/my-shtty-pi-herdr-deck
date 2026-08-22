import type { PiEventBusLike } from "./provider-projection-collector.js";

export const AGENT_BOARD_ACTION_REQUEST_EVENT =
  "pi-agent-board:action-request-v1" as const;
export const AGENT_BOARD_ACTION_RESPONSE_EVENT =
  "pi-agent-board:action-response-v1" as const;
export const AGENT_BOARD_VIEW_REQUEST_EVENT =
  "pi-agent-board:view-request-v2" as const;
export const AGENT_BOARD_VIEW_RESPONSE_EVENT =
  "pi-agent-board:view-response-v2" as const;
export const TODO_ACTION_REQUEST_EVENT = "pi-todo:request-action-v1" as const;
export const TODO_ACTION_RESPONSE_EVENT = "pi-todo:action-response-v1" as const;
export const FILES_OPEN_REQUEST_EVENT = "pi-files-ui:request-open-v1" as const;
export const FILES_OPEN_RESPONSE_EVENT =
  "pi-files-ui:open-response-v1" as const;
export const FILES_PROVIDER_REQUEST_EVENT =
  "pi-files-ui:provider-request-v1" as const;
export const FILES_PROVIDER_RESPONSE_EVENT =
  "pi-files-ui:provider-response-v1" as const;
export const FILES_PROVIDER_SUMMARY_EVENT =
  "pi-files-ui:provider-summary-v1" as const;
export const FILES_PROVIDER_VIEW_EVENT =
  "pi-files-ui:provider-view-change-v1" as const;

export type TodoAction = "start" | "done" | "clear_wait";
export type FilesProviderAction =
  | "snapshot"
  | "list"
  | "navigate"
  | "expand"
  | "preview"
  | "filter"
  | "toggle-selection"
  | "clear-selection"
  | "toggle-hidden"
  | "insert-paths"
  | "prepare-contents"
  | "insert-contents";
export interface ProviderActionError {
  code: string;
  message: string;
  retryable: boolean;
}
export interface TodoActionResponse {
  version: 1;
  requestId: string;
  ok: boolean;
  action: TodoAction;
  taskId: string;
  message?: string;
  error?: string | ProviderActionError;
}
export interface FilesProviderRequest {
  version: 1;
  requestId: string;
  action: FilesProviderAction;
  path?: string;
  query?: string;
  expanded?: boolean;
  selected?: boolean;
  includedPaths?: string[];
}
export interface FilesProviderResponse {
  version: 1;
  requestId: string;
  ok: boolean;
  summary?: unknown;
  view?: unknown;
  budget?: unknown;
  error?: string | ProviderActionError;
}
export interface AgentBoardActionRequest {
  schemaVersion: 1 | 2;
  requestId: string;
  action: string;
  questionId?: string;
  expectedRevision?: number;
  answerId?: string;
  source?: "manual" | "recommendation";
  value?: unknown;
  outcome?: string;
  summary?: string;
  resultingUpdateIds?: string[];
  attachments?: unknown[];
  updateId?: string;
}
export interface AgentBoardActionResponse {
  schemaVersion: 1 | 2;
  requestId: string;
  ok: boolean;
  value?: { action: string; answerId?: string };
  error?: string | ProviderActionError;
}
export interface AgentBoardViewResponse {
  schemaVersion: 2;
  requestId: string;
  snapshot: unknown;
}

export class ProviderActionException extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(error: ProviderActionError) {
    super(error.message);
    this.name = "ProviderActionException";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}
const id = (): string =>
  `deck-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export class ProviderEventAdapters {
  constructor(private readonly events: PiEventBusLike) {}
  filesOpen() {
    return this.request(FILES_OPEN_REQUEST_EVENT, FILES_OPEN_RESPONSE_EVENT, {
      version: 1,
      requestId: id(),
    });
  }
  files(
    action: FilesProviderAction,
    fields: Omit<FilesProviderRequest, "version" | "requestId" | "action"> = {},
  ) {
    return this.request<FilesProviderResponse>(
      FILES_PROVIDER_REQUEST_EVENT,
      FILES_PROVIDER_RESPONSE_EVENT,
      { version: 1, requestId: id(), action, ...fields },
    );
  }
  boardView(selections?: Record<string, string>) {
    return this.request<AgentBoardViewResponse>(
      AGENT_BOARD_VIEW_REQUEST_EVENT,
      AGENT_BOARD_VIEW_RESPONSE_EVENT,
      {
        schemaVersion: 2,
        requestId: id(),
        ...(selections ? { selections } : {}),
      },
    );
  }
  todo(action: TodoAction, taskId: string) {
    return this.request<TodoActionResponse>(
      TODO_ACTION_REQUEST_EVENT,
      TODO_ACTION_RESPONSE_EVENT,
      { version: 1, requestId: id(), action, taskId },
    );
  }
  agentBoardOpen(schemaVersion: 2 | 1 = 2) {
    return this.request<AgentBoardActionResponse>(
      AGENT_BOARD_ACTION_REQUEST_EVENT,
      AGENT_BOARD_ACTION_RESPONSE_EVENT,
      { schemaVersion, requestId: id(), action: "open-ui" },
    );
  }
  agentBoardAction(action: string, fields: Record<string, unknown> = {}) {
    return this.request<AgentBoardActionResponse>(
      AGENT_BOARD_ACTION_REQUEST_EVENT,
      AGENT_BOARD_ACTION_RESPONSE_EVENT,
      { schemaVersion: 2, requestId: id(), action, ...fields },
    );
  }
  agentBoardAnswer(request: Record<string, unknown>) {
    return this.agentBoardAction("answer-question", request);
  }
  private request<T>(
    requestEvent: string,
    responseEvent: string,
    payload: unknown,
  ): Promise<T> {
    const requestId = (payload as { requestId: string }).requestId;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      let deferredFailure: NodeJS.Timeout | undefined;
      let lastFailure: ProviderActionException | undefined;
      const remove = (): void => {
        clearTimeout(timer);
        if (deferredFailure) clearTimeout(deferredFailure);
        this.events.off?.(responseEvent, listener);
      };
      const listener = (value: unknown): void => {
        if (
          !value ||
          typeof value !== "object" ||
          (value as { requestId?: unknown }).requestId !== requestId
        )
          return;
        const outer = value as Record<string, unknown>;
        const nested = ["response", "result", "data", "payload"]
          .map((key) => outer[key])
          .find(
            (item) => item && typeof item === "object" && !Array.isArray(item),
          ) as Record<string, unknown> | undefined;
        const result = (nested ? { ...outer, ...nested } : outer) as T & {
          ok?: boolean;
          error?: unknown;
        };
        if (result.ok === false) {
          const raw = result.error;
          const error =
            raw && typeof raw === "object"
              ? (raw as Partial<ProviderActionError>)
              : {
                  message:
                    typeof raw === "string" ? raw : "Provider action failed.",
                };
          lastFailure = new ProviderActionException({
            code:
              typeof error.code === "string"
                ? error.code
                : "PROVIDER_ACTION_FAILED",
            message:
              typeof error.message === "string"
                ? error.message
                : "Provider action failed.",
            retryable:
              typeof error.retryable === "boolean" ? error.retryable : false,
          });
          // Pi reloads can briefly leave an old and a new listener on the same
          // event bus. Give the active provider a short chance to answer before
          // a stale listener failure wins the correlated request.
          const staleReloadListener =
            lastFailure.message === "No active Files provider";
          if (!deferredFailure)
            deferredFailure = setTimeout(
              () => {
                remove();
                reject(lastFailure!);
              },
              staleReloadListener ? 1_500 : 75,
            );
          return;
        }
        remove();
        resolve(result);
      };
      timer = setTimeout(() => {
        remove();
        reject(
          lastFailure ??
            new ProviderActionException({
              code: "PROVIDER_ACTION_TIMEOUT",
              message: "Provider action timed out.",
              retryable: true,
            }),
        );
      }, 10_000);
      this.events.on(responseEvent, listener);
      this.events.emit(requestEvent, payload);
    });
  }
}
