import type { Component, TuiMouseEvent } from "@pi-herdr-deck/tui";
import { BrokerClient, type BrokerStatus } from "./broker-client.js";
import { DeckActions, type DeckAction } from "./actions.js";
import {
  getAgentModelChoices,
  getAgentThinkingChoices,
  renderAgentInspector,
  renderAgents,
  renderGroupDetail,
  renderGroups,
  renderNotifications,
  renderQuestionDetail,
  renderQuestions,
  renderResultDetail,
  renderTaskDetail,
  renderTasks,
} from "./views.js";
import type { Agent, Task } from "../state/types.js";
import type { DeckGroup, DeckQuestion, DeckResult } from "./types.js";

export interface BrokerDeckAppOptions {
  client: BrokerClient;
  requestRender(): void;
  getHeight(): number;
  onClose?(): void;
}

type DeckTab = "agents" | "groups" | "tasks" | "results" | "questions";
type InputMode = "prompt" | "ask" | "answer";

export class BrokerDeckApp implements Component {
  readonly #client: BrokerClient;
  readonly #actions: DeckActions;
  readonly #requestRender: () => void;
  readonly #getHeight: () => number;
  readonly #onClose: () => void;
  readonly #unsubscribers: Array<() => void> = [];
  #status: BrokerStatus;
  #tab: DeckTab = "agents";
  #selectedAgent: string | undefined;
  #selectedGroup: string | undefined;
  #selectedTask: string | undefined;
  #selectedResult: string | undefined;
  #selectedQuestion: string | undefined;
  #message = "";
  #inputMode: InputMode | undefined;
  #input = "";
  #closeConfirmation: string | undefined;

  constructor(options: BrokerDeckAppOptions) {
    this.#client = options.client;
    this.#actions = new DeckActions(options.client);
    this.#requestRender = options.requestRender;
    this.#getHeight = options.getHeight;
    this.#onClose = options.onClose ?? (() => undefined);
    this.#status = options.client.status;
    this.#unsubscribers.push(
      options.client.onStatus((status) => {
        this.#status = status;
        this.#requestRender();
      }),
      options.client.store.onChange(() => this.#requestRender()),
    );
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const state = this.#client.store.state;
    const tabs: DeckTab[] = [
      "agents",
      "groups",
      "tasks",
      "results",
      "questions",
    ];
    const lines = [
      "Pi Herdr Deck",
      `Broker: ${this.#status}  Sequence: ${state.seq}`,
      `Tabs: ${tabs.map((tab, index) => `[${this.#tab === tab ? tab.toUpperCase() : tab} ${index + 1}]`).join(" ")}`,
      "Keys: ↑/↓ select · r refresh · q close deck",
      "",
    ];
    if (this.#tab === "agents") {
      const agent = this.selectedAgent();
      lines.push(...renderAgents(state, safeWidth, agent?.id), "");
      lines.push(...renderAgentInspector(agent, state, safeWidth));
    } else if (this.#tab === "groups") {
      const group = this.selectedGroup();
      lines.push(...renderGroups(state, safeWidth, group?.id), "");
      lines.push(...renderGroupDetail(group, safeWidth));
    } else if (this.#tab === "tasks") {
      const task = this.selectedTask();
      lines.push(...renderTasks(state, safeWidth, undefined, task?.id), "");
      lines.push(...renderTaskDetail(task, state, safeWidth));
    } else if (this.#tab === "results") {
      const result = this.selectedResult();
      lines.push(...renderResultDetail(result, safeWidth));
    } else {
      const question = this.selectedQuestion();
      lines.push(
        ...renderQuestions(
          [...state.questions.values()],
          safeWidth,
          question?.id,
        ),
        "",
      );
      lines.push(...renderQuestionDetail(question, safeWidth));
    }
    lines.push("");
    lines.push(
      `Portfolio: ${state.agents.size} agents, ${state.groups.size} groups, ${state.tasks.size} tasks, ${state.results.size} results, ${state.questions.size} questions`,
    );
    if (this.#inputMode) {
      lines.push(`${this.#inputMode.toUpperCase()}: ${this.#input}█`);
      lines.push("Enter submits. Escape cancels. Backspace edits.");
    }
    if (this.#message) lines.push(`Notice: ${this.#message}`);
    lines.push(
      ...renderNotifications(this.#client.store.notifications, safeWidth),
    );
    const height = Math.max(1, this.#getHeight());
    while (lines.length < height) lines.push("");
    return lines
      .slice(0, height)
      .map((line) =>
        line.length <= safeWidth
          ? line
          : `${line.slice(0, Math.max(0, safeWidth - 1))}…`,
      );
  }

  handleInput(data: string): void {
    if (this.#inputMode) {
      this.handleEditorInput(data);
      this.#requestRender();
      return;
    }
    if (data === "q" || data === "\u0003" || data === "\u001b") {
      this.#onClose();
      return;
    }
    if (data >= "1" && data <= "5") {
      this.#tab = (
        ["agents", "groups", "tasks", "results", "questions"] as DeckTab[]
      )[Number(data) - 1]!;
      this.#closeConfirmation = undefined;
    } else if (data === "r") void this.run("refresh");
    else if (data === "f" && this.#tab === "agents") void this.run("focus");
    else if (data === "p" && this.#tab === "agents") this.beginInput("prompt");
    else if (data === "a" && this.#tab === "agents") this.beginInput("ask");
    else if (data === "a" && this.#tab === "questions")
      this.beginInput("answer");
    else if (data === "i" && this.#tab === "agents") void this.run("interrupt");
    else if (data === "s" && this.#tab === "agents") void this.run("stop");
    else if (data === "x" && this.#tab === "agents") this.confirmClose();
    else if (data === "m" && this.#tab === "agents") this.cycleModel();
    else if (data === "t" && this.#tab === "agents") this.cycleThinking();
    else if (data === "\u001b[A" || data === "k") this.move(-1);
    else if (data === "\u001b[B" || data === "j") this.move(1);
    this.#requestRender();
  }

  handleMouse(_event: TuiMouseEvent): boolean {
    return false;
  }

  invalidate(): void {
    this.#requestRender();
  }

  private selectedAgent(): Agent | undefined {
    return this.selected(
      [...this.#client.store.state.agents.values()],
      this.#selectedAgent,
    );
  }
  private selectedGroup(): DeckGroup | undefined {
    return this.selected(
      [...this.#client.store.state.groups.values()],
      this.#selectedGroup,
    );
  }
  private selectedTask(): Task | undefined {
    return this.selected(
      [...this.#client.store.state.tasks.values()],
      this.#selectedTask,
    );
  }
  private selectedResult(): DeckResult | undefined {
    return this.selected(
      [...this.#client.store.state.results.values()],
      this.#selectedResult,
    );
  }
  private selectedQuestion(): DeckQuestion | undefined {
    return this.selected(
      [...this.#client.store.state.questions.values()],
      this.#selectedQuestion,
    );
  }
  private selected<T extends { id: string }>(
    items: T[],
    id: string | undefined,
  ): T | undefined {
    const sorted = items.sort((a, b) => a.id.localeCompare(b.id));
    return (
      (id ? sorted.find((item) => item.id === id) : undefined) ?? sorted[0]
    );
  }

  private move(delta: number): void {
    const state = this.#client.store.state;
    if (this.#tab === "agents")
      this.#selectedAgent = this.nextId(
        [...state.agents.values()],
        this.selectedAgent()?.id,
        delta,
      );
    else if (this.#tab === "groups")
      this.#selectedGroup = this.nextId(
        [...state.groups.values()],
        this.selectedGroup()?.id,
        delta,
      );
    else if (this.#tab === "tasks")
      this.#selectedTask = this.nextId(
        [...state.tasks.values()],
        this.selectedTask()?.id,
        delta,
      );
    else if (this.#tab === "results")
      this.#selectedResult = this.nextId(
        [...state.results.values()],
        this.selectedResult()?.id,
        delta,
      );
    else
      this.#selectedQuestion = this.nextId(
        [...state.questions.values()],
        this.selectedQuestion()?.id,
        delta,
      );
    this.#closeConfirmation = undefined;
  }

  private nextId<T extends { id: string }>(
    items: T[],
    current: string | undefined,
    delta: number,
  ): string | undefined {
    const sorted = items.sort((a, b) => a.id.localeCompare(b.id));
    if (sorted.length === 0) return undefined;
    const found = sorted.findIndex((item) => item.id === current);
    const index = found < 0 ? 0 : found;
    return sorted[(index + delta + sorted.length) % sorted.length]?.id;
  }

  private target() {
    const agent = this.selectedAgent();
    const task = this.selectedTask();
    const question = this.selectedQuestion();
    return {
      ...(agent
        ? {
            agent,
            ...(agent.paneId ? { paneId: agent.paneId } : {}),
            ...(agent.terminalId ? { terminalId: agent.terminalId } : {}),
            generation: agent.generation,
            ...(agent.currentRunId ? { runId: agent.currentRunId } : {}),
          }
        : {}),
      ...(task ? { task } : {}),
      ...(question ? { question, questionId: question.id } : {}),
    };
  }

  private async run(action: DeckAction, value?: string): Promise<void> {
    try {
      await this.#actions.run(action, this.target(), value);
      this.#message = `${action} accepted.`;
      this.#closeConfirmation = undefined;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private beginInput(mode: InputMode): void {
    const target = this.target();
    const action = mode === "answer" ? "answer" : mode;
    const denied = this.#actions.authorize(action, target);
    if (denied) {
      this.#message = denied;
      return;
    }
    if (mode === "answer" && target.question?.answered) {
      this.#message = "The selected question is terminal.";
      return;
    }
    this.#inputMode = mode;
    this.#input = "";
    this.#message = "";
  }

  private handleEditorInput(data: string): void {
    if (data === "\u001b") {
      this.#inputMode = undefined;
      this.#input = "";
      this.#message = "Input cancelled.";
    } else if (data === "\u007f" || data === "\b")
      this.#input = this.#input.slice(0, -1);
    else if (data === "\r" || data === "\n") {
      const mode = this.#inputMode;
      if (!mode) return;
      const value = this.#input.trim();
      if (!value) {
        this.#message = "Text is required.";
        return;
      }
      this.#inputMode = undefined;
      this.#input = "";
      void this.run(mode === "answer" ? "answer" : mode, value);
    } else if (
      data.length > 0 &&
      !data.includes("\u001b") &&
      [...data].every((character) => character.codePointAt(0)! >= 0x20)
    )
      this.#input = `${this.#input}${data}`.slice(0, 16_384);
  }

  private confirmClose(): void {
    const agent = this.selectedAgent();
    if (!agent) {
      this.#message = "Select an agent first.";
      return;
    }
    if (this.#closeConfirmation === agent.id) void this.run("close");
    else {
      this.#closeConfirmation = agent.id;
      this.#message = `Press x again to close ${agent.displayName ?? agent.id}.`;
    }
  }

  private cycleModel(): void {
    const agent = this.selectedAgent();
    const choices = getAgentModelChoices(agent);
    if (choices.length === 0) {
      this.#message =
        "The broker did not advertise model choices for this agent.";
      return;
    }
    const current =
      (
        agent as unknown as {
          actualModel?: { provider?: string; id?: string };
          model?: { provider?: string; id?: string };
        }
      ).actualModel ??
      (agent as unknown as { model?: { provider?: string; id?: string } })
        .model;
    const index = choices.findIndex(
      (choice) =>
        choice.provider === current?.provider && choice.id === current?.id,
    );
    const next = choices[(index + 1) % choices.length]!;
    void this.run("setModel", `${next.provider}/${next.id}`);
  }

  private cycleThinking(): void {
    const agent = this.selectedAgent();
    const choices = getAgentThinkingChoices(agent);
    if (choices.length === 0) {
      this.#message =
        "The broker did not advertise thinking choices for this agent.";
      return;
    }
    const current =
      (agent as unknown as { actualThinking?: string; thinkingLevel?: string })
        .actualThinking ??
      (agent as unknown as { thinkingLevel?: string }).thinkingLevel;
    const index = choices.indexOf(current ?? "");
    void this.run("setThinking", choices[(index + 1) % choices.length]!);
  }
}
