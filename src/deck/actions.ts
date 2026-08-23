import type { BrokerClient } from "./broker-client.js";
import type { Agent, Task } from "../state/types.js";
import type { DeckQuestion } from "./types.js";
import {
  buildBrokerQuestionAnswer,
  buildSignalsQuestionAnswer,
  type QuestionResponseSelection,
} from "./question-response.js";
import {
  normalizeBrokerQuestion,
  normalizeSignalsQuestion,
} from "./product-presentation.js";

export type DeckAction =
  | "focus"
  | "prompt"
  | "ask"
  | "steer"
  | "followUp"
  | "answer"
  | "interrupt"
  | "compact"
  | "setModel"
  | "setThinking"
  | "restart"
  | "stop"
  | "close"
  | "cancelTask"
  | "groupWait"
  | "groupStop"
  | "groupClose"
  | "openWorktree"
  | "copyId"
  | "refresh"
  | "todoStart"
  | "todoDone"
  | "todoClearWait"
  | "agentBoardOpen"
  | "agentBoardAnswer"
  | "filesOpen"
  | "filesAction"
  | "boardView"
  | "boardAction";
export interface ActionTarget {
  agent?: Agent;
  task?: Task;
  group?: { id: string; state: string };
  question?: DeckQuestion;
  questionId?: string;
  boardQuestion?: {
    questionId: string;
    revision: number;
    response: { kind: string; options: Array<{ id: string; label: string }> };
  };
  paneId?: string;
  terminalId?: string;
  sessionId?: string;
  generation?: number;
  runId?: string;
  /** Provider-owned Todo identifier. This is not an orchestrator task. */
  todoTaskId?: string;
  todoHasWait?: boolean;
  filesAction?: {
    action: string;
    path?: string;
    query?: string;
    expanded?: boolean;
    selected?: boolean;
    includedPaths?: string[];
  };
  boardSelections?: Record<string, string>;
  boardAction?: { action: string; fields?: Record<string, unknown> };
  copyId?: string;
}

export interface QuestionAnswer {
  optionId: string | null;
  text: string | null;
}

const BOARD_ACTION_FIELDS: Record<string, readonly string[]> = {
  "accept-recommendation": ["questionId", "expectedRevision"],
  "dismiss-question": ["questionId", "expectedRevision"],
  "retry-delivery": ["questionId", "answerId", "expectedRevision"],
  "archive-update": ["updateId", "expectedRevision"],
  "acknowledge-answer": [
    "answerId",
    "outcome",
    "summary",
    "resultingUpdateIds",
    "attachments",
  ],
};

export function buildBoardActionRequest(
  ownerAgentId: string,
  boardAction: { action: string; fields?: Record<string, unknown> },
): Record<string, unknown> {
  const allowed = BOARD_ACTION_FIELDS[boardAction.action];
  if (!allowed) throw new Error("Signals action is not available.");
  const fields = boardAction.fields ?? {};
  if (Object.keys(fields).some((key) => !allowed.includes(key)))
    throw new Error("Signals action fields are invalid.");
  if (
    allowed
      .filter(
        (key) =>
          key === "questionId" || key === "answerId" || key === "updateId",
      )
      .some((key) => typeof fields[key] !== "string" || !fields[key])
  )
    throw new Error("Signals action identity is missing.");
  if (
    "expectedRevision" in fields &&
    !Number.isSafeInteger(fields.expectedRevision)
  )
    throw new Error("Signals action revision is invalid.");
  return { ownerAgentId, ...fields, action: boardAction.action };
}

type Guard = (target: ActionTarget) => string | undefined;
const requireAgent = (target: ActionTarget): string | undefined =>
  target.agent ? undefined : "Select an agent first.";
const requirePane = (target: ActionTarget): string | undefined =>
  target.paneId ? undefined : "Pane identity is unavailable.";
const requireQuestion = (target: ActionTarget): string | undefined =>
  target.questionId || target.question ? undefined : "Select a question first.";

const guards: Record<DeckAction, Guard> = {
  focus: requirePane,
  prompt: requireAgent,
  ask: requireAgent,
  steer: (target) =>
    target.agent?.state === "working"
      ? undefined
      : "Steer requires a working agent.",
  followUp: (target) =>
    target.agent?.state === "working"
      ? undefined
      : "Follow-up requires a working agent.",
  answer: requireQuestion,
  interrupt: requireAgent,
  compact: (target) =>
    target.agent?.state === "idle"
      ? undefined
      : "Compact requires an idle agent.",
  setModel: requireAgent,
  setThinking: requireAgent,
  restart: requireAgent,
  stop: requireAgent,
  close: requireAgent,
  cancelTask: (target) => (target.task ? undefined : "Select a task first."),
  groupWait: (target) => (target.group ? undefined : "Select a group first."),
  groupStop: (target) => (target.group ? undefined : "Select a group first."),
  groupClose: (target) => (target.group ? undefined : "Select a group first."),
  openWorktree: (target) =>
    target.agent?.workspaceId ? undefined : "Agent worktree is unavailable.",
  copyId: (target) =>
    target.agent || target.task || target.copyId
      ? undefined
      : "Select an agent or task first.",
  refresh: () => undefined,
  todoStart: (target) =>
    target.todoTaskId ? undefined : "Select a provider Todo item first.",
  todoDone: (target) =>
    target.todoTaskId ? undefined : "Select a provider Todo item first.",
  todoClearWait: (target) =>
    target.todoTaskId ? undefined : "Select a provider Todo item first.",
  agentBoardOpen: () => undefined,
  agentBoardAnswer: requireQuestion,
  filesOpen: (target) =>
    target.agent ? undefined : "Provider owner is unavailable.",
  filesAction: (target) =>
    target.agent && target.filesAction
      ? undefined
      : "Select a provider Files action.",
  boardView: (target) =>
    target.agent ? undefined : "Provider owner is unavailable.",
  boardAction: (target) =>
    target.agent && target.boardAction ? undefined : "Select a Signals action.",
};

export class DeckActions {
  constructor(private readonly client: BrokerClient) {}

  authorize(action: DeckAction, target: ActionTarget): string | undefined {
    return guards[action](target);
  }

  async run(
    action: DeckAction,
    target: ActionTarget,
    value?: string | QuestionResponseSelection | QuestionAnswer,
  ): Promise<unknown> {
    const denied = this.authorize(action, target);
    if (denied) throw new Error(denied);
    const identity = this.agentIdentity(target);
    switch (action) {
      case "focus":
        return this.client.request("herdr.focus", this.paneGuard(target));
      case "interrupt":
        return this.client.request("agent.interrupt", {
          ...this.controlIdentity(target),
          ...(typeof value === "string" && value ? { reason: value } : {}),
        });
      case "stop":
        return this.client.request("agent.stop", {
          ...this.controlIdentity(target),
          reason:
            typeof value === "string" && value
              ? value
              : "Stopped from Agent Board.",
          force: false,
        });
      case "close":
        return this.client.request("agent.close", {
          ...this.controlIdentity(target),
          reason:
            typeof value === "string" && value
              ? value
              : "Closed from Agent Board.",
          confirm: true,
        });
      case "answer": {
        const answer =
          typeof value === "object" && value !== null && "optionId" in value
            ? (value as QuestionAnswer)
            : buildBrokerQuestionAnswer(
                normalizeBrokerQuestion(target.question!),
                questionSelection(value),
              );
        return this.client.answer(
          target.questionId ?? target.question!.id,
          answer,
        );
      }
      case "filesOpen":
        return this.client.request("provider.files_open", {
          ownerAgentId: target.agent?.id ?? target.question?.agentId ?? "",
        });
      case "filesAction":
        return this.client.request("provider.files_action", {
          ownerAgentId: target.agent!.id,
          ...target.filesAction,
        });
      case "boardView":
        return this.client.request("provider.agent_board_view", {
          ownerAgentId: target.agent!.id,
          ...(target.boardSelections
            ? { selections: target.boardSelections }
            : {}),
        });
      case "boardAction":
        return this.client.request(
          "provider.agent_board_action",
          buildBoardActionRequest(target.agent!.id, target.boardAction!),
        );
      case "todoStart":
      case "todoDone":
      case "todoClearWait":
        return this.client.request("provider.todo_action", {
          ownerAgentId: target.agent?.id ?? "",
          action:
            action === "todoStart"
              ? "start"
              : action === "todoDone"
                ? "done"
                : "clear_wait",
          taskId: target.todoTaskId!,
        });
      case "agentBoardOpen":
        return this.client.request("provider.agent_board_action", {
          action: "open-ui",
          ownerAgentId: target.agent?.id ?? "",
        });
      case "agentBoardAnswer":
        return this.client.request("provider.agent_board_action", {
          ownerAgentId: target.agent?.id ?? "",
          action: "answer-question",
          questionId: target.boardQuestion?.questionId ?? target.question!.id,
          expectedRevision: target.boardQuestion?.revision ?? 0,
          source: "manual",
          value: this.signalsAnswer(target, questionSelection(value)),
        });
      case "cancelTask":
        return this.client.request("task.cancel", {
          taskId: target.task!.id,
          reason:
            typeof value === "string" && value
              ? value
              : "Cancelled from Agent Board.",
          cascade: false,
        });
      case "groupWait":
        return this.client.request("group.wait", {
          groupId: target.group!.id,
          until: ["succeeded", "failed", "cancelled", "timed_out", "blocked"],
          mode: "any",
          timeoutMs: 10_000,
        });
      case "groupStop":
        return this.client.request("group.stop", {
          groupId: target.group!.id,
          reason:
            typeof value === "string" && value
              ? value
              : "Stopped from Agent Board.",
          force: false,
        });
      case "groupClose":
        return this.client.request("group.close", {
          groupId: target.group!.id,
          reason:
            typeof value === "string" && value
              ? value
              : "Closed from Agent Board.",
          confirm: true,
        });
      case "prompt":
        return this.client.request("agent.prompt", {
          ...identity,
          message: typeof value === "string" ? value : "",
          timeoutMs: 10_000,
        });
      case "ask":
        return this.client.request("agent.ask", {
          agentId: target.agent!.id,
          message: typeof value === "string" ? value : "",
          timeoutMs: 120_000,
        });
      case "steer":
      case "followUp":
        return this.client.request(
          action === "steer" ? "agent.steer" : "agent.follow_up",
          {
            ...identity,
            message: typeof value === "string" ? value : "",
            timeoutMs: 10_000,
          },
        );
      case "compact":
        return this.client.request("agent.compact", identity);
      case "setModel": {
        const selected = typeof value === "string" ? value : "";
        const slash = selected.indexOf("/");
        if (slash <= 0 || slash === selected.length - 1)
          throw new Error("Model must use provider/model-id format.");
        return this.client.request("agent.set_model", {
          ...identity,
          provider: selected.slice(0, slash),
          modelId: selected.slice(slash + 1),
        });
      }
      case "setThinking":
        return this.client.request("agent.set_thinking", {
          ...identity,
          level: typeof value === "string" ? value : "",
        });
      case "restart":
        return this.client.request("agent.restart", identity);
      case "openWorktree":
        return this.client.request("worktree.open", {
          agentId: target.agent!.id,
        });
      case "copyId":
        return target.agent?.id ?? target.task?.id ?? target.copyId ?? "";
      case "refresh":
        return this.client.refresh();
      default:
        throw new Error(
          `Action ${action} is not available through the broker contract.`,
        );
    }
  }

  private agentIdentity(target: ActionTarget): Record<string, unknown> {
    if (!target.agent) return {};
    return {
      agentId: target.agent.id,
      ...(target.runId ? { runId: target.runId } : {}),
      ...(target.generation === undefined
        ? {}
        : { generation: target.generation }),
    };
  }

  private controlIdentity(target: ActionTarget): Record<string, unknown> {
    const runId = target.runId ?? target.agent?.currentRunId;
    const assignmentGeneration = target.agent?.currentAssignmentGeneration;
    return {
      agentId: target.agent!.id,
      ...(runId && assignmentGeneration !== undefined
        ? { runId, assignmentGeneration }
        : {}),
    };
  }

  private paneGuard(target: ActionTarget): Record<string, unknown> {
    return {
      paneId: target.paneId,
      ...(target.terminalId ? { terminalId: target.terminalId } : {}),
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      ...(target.generation === undefined
        ? {}
        : { generation: target.generation }),
    };
  }

  private signalsAnswer(
    target: ActionTarget,
    selection: QuestionResponseSelection,
  ): unknown {
    const board = target.boardQuestion;
    if (!board) throw new Error("Select a Signals question first.");
    const question = normalizeSignalsQuestion({
      questionId: board.questionId,
      revision: board.revision,
      question: "",
      response: board.response as never,
      recommendedOptionIds: [],
    });
    return buildSignalsQuestionAnswer(question, selection);
  }
}

function questionSelection(
  value: string | QuestionResponseSelection | QuestionAnswer | undefined,
): QuestionResponseSelection {
  if (typeof value === "string") return { selectedOptionIds: [], text: value };
  if (
    value &&
    "selectedOptionIds" in value &&
    Array.isArray(value.selectedOptionIds) &&
    typeof value.text === "string"
  )
    return value;
  if (
    value &&
    "optionId" in value &&
    (value.optionId === null || typeof value.optionId === "string") &&
    (value.text === null || typeof value.text === "string")
  )
    return {
      selectedOptionIds: value.optionId ? [value.optionId] : [],
      text: value.text ?? "",
    };
  throw new Error("A structured question response is required.");
}
