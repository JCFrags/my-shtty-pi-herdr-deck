import type { BrokerClient } from "./broker-client.js";
import type { Agent, Task } from "../state/types.js";

export type DeckAction =
  | "focus"
  | "prompt"
  | "steer"
  | "followUp"
  | "answer"
  | "interrupt"
  | "compact"
  | "restart"
  | "stop"
  | "close"
  | "cancelTask"
  | "openWorktree"
  | "copyId"
  | "refresh";
export interface ActionTarget {
  agent?: Agent;
  task?: Task;
  questionId?: string;
  paneId?: string;
  terminalId?: string;
  sessionId?: string;
  generation?: number;
}

type Guard = (target: ActionTarget) => string | undefined;
const requireAgent = (target: ActionTarget): string | undefined =>
  target.agent ? undefined : "Select an agent first.";
const requirePane = (target: ActionTarget): string | undefined =>
  target.paneId ? undefined : "Pane identity is unavailable.";
const requireAgentAndPane = (target: ActionTarget): string | undefined =>
  requireAgent(target) ?? requirePane(target) ?? undefined;

const guards: Record<DeckAction, Guard> = {
  focus: requirePane,
  prompt: requireAgent,
  steer: (t) =>
    t.agent?.state === "working"
      ? undefined
      : "Steer requires a working agent.",
  followUp: (t) =>
    t.agent?.state === "working"
      ? undefined
      : "Follow-up requires a working agent.",
  answer: (t) => (t.questionId ? undefined : "Select a question first."),
  interrupt: requirePane,
  compact: requireAgentAndPane,
  restart: requireAgentAndPane,
  stop: requirePane,
  close: requirePane,
  cancelTask: (t) => (t.task ? undefined : "Select a task first."),
  openWorktree: requireAgent,
  copyId: (t) =>
    t.agent || t.task ? undefined : "Select an agent or task first.",
  refresh: () => undefined,
};

export class DeckActions {
  constructor(private readonly client: BrokerClient) {}

  authorize(action: DeckAction, target: ActionTarget): string | undefined {
    return guards[action](target);
  }

  async run(
    action: DeckAction,
    target: ActionTarget,
    value?: string,
  ): Promise<unknown> {
    const denied = this.authorize(action, target);
    if (denied) throw new Error(denied);
    switch (action) {
      case "focus":
        return this.client.request("herdr.focus", this.guard(target));
      case "interrupt":
        return this.client.request("herdr.interrupt", this.guard(target));
      case "stop":
        return this.client.request("herdr.stop", this.guard(target));
      case "close":
        return this.client.request("herdr.close", this.guard(target));
      case "answer":
        return this.client.answer(target.questionId!, value ?? "");
      case "cancelTask":
        return this.client.request("task.cancel", { taskId: target.task!.id });
      case "prompt":
      case "steer":
      case "followUp":
        return this.client.request("agent.message", {
          agentId: target.agent?.id,
          delivery: action === "prompt" ? "normal" : action,
          message: value ?? "",
        });
      case "compact":
        return this.client.request("agent.compact", {
          agentId: target.agent?.id,
        });
      case "restart":
        return this.client.request("agent.restart", {
          agentId: target.agent?.id,
        });
      case "openWorktree":
        return this.client.request("worktree.open", {
          agentId: target.agent?.id,
        });
      case "copyId":
        return target.agent?.id ?? target.task?.id ?? "";
      case "refresh":
        return this.client.refresh();
      default:
        throw new Error(
          `Action ${action} is not available through the broker contract.`,
        );
    }
  }

  private guard(target: ActionTarget): Record<string, unknown> {
    return {
      paneId: target.paneId,
      ...(target.terminalId ? { terminalId: target.terminalId } : {}),
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      ...(target.generation === undefined
        ? {}
        : { generation: target.generation }),
    };
  }
}
