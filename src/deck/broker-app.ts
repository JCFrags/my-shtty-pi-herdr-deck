import type { Component, TuiMouseEvent } from "@pi-herdr-deck/tui";
import { BrokerClient, type BrokerStatus } from "./broker-client.js";
import { DeckActions } from "./actions.js";
import {
  renderAgentInspector,
  renderAgents,
  renderNotifications,
  renderResultDetail,
  renderTaskDetail,
  renderTasks,
} from "./views.js";
import type { Agent, Task } from "../state/types.js";

export interface BrokerDeckAppOptions {
  client: BrokerClient;
  requestRender(): void;
  getHeight(): number;
  onClose?(): void;
}

export class BrokerDeckApp implements Component {
  readonly #client: BrokerClient;
  readonly #actions: DeckActions;
  readonly #requestRender: () => void;
  readonly #getHeight: () => number;
  readonly #onClose: () => void;
  readonly #unsubscribers: Array<() => void> = [];
  #status: BrokerStatus;
  #tab: "agents" | "tasks" | "results" = "agents";
  #selectedAgent: string | undefined;
  #selectedTask: string | undefined;
  #selectedResult: string | undefined;
  #message = "";

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
    const lines = [
      "Pi Herdr Deck",
      `Broker: ${this.#status}`,
      `Tabs: [${this.#tab === "agents" ? "AGENTS" : "agents"}] [${this.#tab === "tasks" ? "TASKS" : "tasks"}] [${this.#tab === "results" ? "RESULTS" : "results"}]  (1/2/3)`,
      "Actions: ↑/↓ select  f focus  s stop  r refresh  q close",
      "",
    ];
    if (this.#tab === "agents") {
      lines.push(...renderAgents(state, safeWidth, this.#selectedAgent));
      lines.push("");
      lines.push(
        ...renderAgentInspector(this.selectedAgent(), state, safeWidth),
      );
    } else if (this.#tab === "tasks") {
      lines.push(...renderTasks(state, safeWidth));
      lines.push("");
      lines.push(...renderTaskDetail(this.selectedTask(), state, safeWidth));
    } else {
      const result = this.#selectedResult
        ? state.results.get(this.#selectedResult)
        : [...state.results.values()][0];
      lines.push(...renderResultDetail(result, safeWidth));
    }
    lines.push("");
    lines.push(
      `Portfolio: ${state.agents.size} agents, ${state.tasks.size} tasks, ${state.results.size} results, ${state.questions.size} questions, ${state.workflows.size} workflows`,
    );
    lines.push(...renderTasks(state, safeWidth));
    for (const workflow of state.workflows.values())
      lines.push(`Workflow ${workflow.id}: ${workflow.taskIds.length} tasks`);
    for (const question of state.questions.values())
      lines.push(
        `Question ${question.id}: ${question.answered ? "answered" : question.prompt}`,
      );
    for (const result of state.results.values())
      lines.push(
        `Result ${result.id}: ${result.status} ${result.summary ?? ""}`,
      );
    lines.push("");
    lines.push(
      ...renderNotifications(this.#client.store.notifications, safeWidth),
    );
    if (this.#message) lines.push(`Notice: ${this.#message}`);
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
    if (data === "q" || data === "\u0003" || data === "\u001b") {
      this.#onClose();
      return;
    }
    if (data === "1") this.#tab = "agents";
    else if (data === "2") this.#tab = "tasks";
    else if (data === "3") this.#tab = "results";
    else if (data === "r") void this.run("refresh");
    else if (data === "f") void this.run("focus");
    else if (data === "s") void this.run("stop");
    else if (data === "\u001b[A" || data === "k") this.move(-1);
    else if (data === "\u001b[B" || data === "j") this.move(1);
    else if (data === "\r" || data === "\n") void this.run("focus");
    this.#requestRender();
  }

  handleMouse(_event: TuiMouseEvent): boolean {
    return false;
  }

  invalidate(): void {
    this.#requestRender();
  }

  private selectedAgent(): Agent | undefined {
    const agents = [...this.#client.store.state.agents.values()];
    return this.#selectedAgent
      ? this.#client.store.state.agents.get(this.#selectedAgent)
      : agents[0];
  }

  private selectedTask(): Task | undefined {
    const tasks = [...this.#client.store.state.tasks.values()];
    return this.#selectedTask
      ? this.#client.store.state.tasks.get(this.#selectedTask)
      : tasks[0];
  }

  private move(delta: number): void {
    const state = this.#client.store.state;
    if (this.#tab === "agents") {
      const items = [...state.agents.values()];
      const index = Math.max(
        0,
        items.findIndex((item) => item.id === this.#selectedAgent),
      );
      this.#selectedAgent =
        items[(index + delta + items.length) % items.length]?.id;
    } else if (this.#tab === "tasks") {
      const items = [...state.tasks.values()];
      const index = Math.max(
        0,
        items.findIndex((item) => item.id === this.#selectedTask),
      );
      this.#selectedTask =
        items[(index + delta + items.length) % items.length]?.id;
    } else {
      const items = [...state.results.values()];
      const index = Math.max(
        0,
        items.findIndex((item) => item.id === this.#selectedResult),
      );
      this.#selectedResult =
        items[(index + delta + items.length) % items.length]?.id;
    }
  }

  private async run(action: "refresh" | "focus" | "stop"): Promise<void> {
    try {
      const agent = this.selectedAgent();
      const target = agent
        ? {
            agent,
            ...(agent.paneId ? { paneId: agent.paneId } : {}),
            ...(agent.terminalId ? { terminalId: agent.terminalId } : {}),
            generation: agent.generation,
          }
        : {};
      await this.#actions.run(action, target);
      this.#message = "";
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }
}
