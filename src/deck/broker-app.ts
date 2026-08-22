import type { Component, TuiMouseEvent } from "@pi-herdr-deck/tui";
import { BrokerClient, type BrokerStatus } from "./broker-client.js";
import { DeckActions, type DeckAction } from "./actions.js";
import {
  currentBlockingQuestions,
  currentProviderProjection,
  agentPortfolioCounts,
  getAgentModelChoices,
  getAgentThinkingChoices,
  renderAgentInspector,
  renderAgents,
  renderGroupDetail,
  renderGroups,
  renderHome,
  renderNotifications,
  renderResultDetail,
  renderTaskDetail,
  renderTasks,
  renderTodoSummary,
  renderTodoDetail,
} from "./views.js";
import {
  type HitBox,
  PressReleaseTracker,
  renderButton,
} from "./components/controls.js";
import type { Agent, Task } from "../state/types.js";
import type { DeckState } from "./types.js";
import { styleLines } from "./theme.js";
import type { PiCapabilitySnapshot } from "../pi/model-capabilities.js";
import type { ModelPolicyConfig } from "../broker/model-policy.js";
import type { DeckGroup, DeckQuestion, DeckResult } from "./types.js";
import type { AgentBoardPendingQuestion } from "../shared/provider-projections.js";

export interface BrokerDeckAppOptions {
  client: BrokerClient;
  requestRender(): void;
  getHeight(): number;
  targetPaneId?: string;
  onClose?(): void;
}

type DeckTab = "home" | "work" | "files" | "agents" | "inbox" | "more";
type WorkView = "todo" | "tasks" | "results" | "groups" | "history";
type InputMode =
  | "prompt"
  | "ask"
  | "steer"
  | "followUp"
  | "answer"
  | "board-answer"
  | "create"
  | "default"
  | "files-filter"
  | "model-filter";

function stableRenderSignature(state: DeckState): string {
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (value instanceof Map)
      return [...value.entries()].map(([key, item]) => [key, clean(item)]);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(
            ([key]) =>
              !/^(seq|adapterSeq|heartbeatAt|lastHeartbeatAt|updatedAt|timestamp)$/i.test(
                key,
              ),
          )
          .map(([key, item]) => [key, clean(item)]),
      );
    return value;
  };
  return JSON.stringify(
    clean({
      agents: state.agents,
      tasks: state.tasks,
      runs: state.runs,
      workflows: state.workflows,
      groups: state.groups,
      questions: state.questions,
      results: state.results,
      providerProjections: state.providerProjections,
    }),
  );
}

const NAV_TABS: readonly DeckTab[] = [
  "home",
  "work",
  "files",
  "agents",
  "inbox",
  "more",
];

export class BrokerDeckApp implements Component {
  readonly #client: BrokerClient;
  readonly #actions: DeckActions;
  readonly #requestRender: () => void;
  readonly #getHeight: () => number;
  readonly #targetPaneId: string | undefined;
  readonly #onClose: () => void;
  readonly #unsubscribers: Array<() => void> = [];
  readonly #tracker = new PressReleaseTracker();
  #status: BrokerStatus;
  #tab: DeckTab = "home";
  #workView: WorkView = "todo";
  #hitBoxes: HitBox[] = [];
  #selectedAgent: string | undefined;
  #selectedGroup: string | undefined;
  #selectedTask: string | undefined;
  #selectedProviderTodo: string | undefined;
  #selectedResult: string | undefined;
  #selectedQuestion: string | undefined;
  #agentFilter: import("./views.js").AgentViewFilter = "active";
  #agentPage = 0;
  #modelFilter = "";
  #boardSelections = new Map<string, Set<string>>();
  #providerPending = new Set<string>();
  #message = "";
  #inputMode: InputMode | undefined;
  #input = "";
  #closeConfirmation: string | undefined;
  #capabilities: PiCapabilitySnapshot | undefined;
  #modelPolicy: ModelPolicyConfig | undefined;
  #autoCloseCompletedTemporary = false;
  #settingsScroll = 0;
  #filesFilter = "";
  #filesHidden = false;
  #filesPath = "";
  #filesScroll = 0;
  #filesPreviewPath: string | undefined;
  #boardTab: "inbox" | "updates" | "decisions" | "history" = "inbox";
  #boardSelection: string | undefined;
  #boardRevision = 0;
  #renderSignature = "";

  constructor(options: BrokerDeckAppOptions) {
    this.#client = options.client;
    this.#actions = new DeckActions(options.client);
    this.#requestRender = options.requestRender;
    this.#getHeight = options.getHeight;
    this.#targetPaneId = options.targetPaneId;
    this.#onClose = options.onClose ?? (() => undefined);
    this.#status = options.client.status;
    this.#renderSignature = stableRenderSignature(options.client.store.state);
    this.#unsubscribers.push(
      options.client.onStatus((status) => {
        this.#status = status;
        this.#requestRender();
      }),
      options.client.store.onChange((state) => {
        const projection = currentProviderProjection(state, this.#targetPaneId);
        if (
          this.#message &&
          ((projection?.files?.available &&
            /Files provider|No active Files provider/i.test(this.#message)) ||
            (projection?.agentBoard.view &&
              /managed adapter|adapter is not connected|Provider owner/i.test(
                this.#message,
              )))
        )
          this.#message = "";
        const signature = stableRenderSignature(state);
        if (signature === this.#renderSignature) return;
        this.#renderSignature = signature;
        this.#requestRender();
      }),
    );
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const state = this.#client.store.state;
    this.#hitBoxes = [];
    const lines = [
      `PI HERD  ${this.#status === "connected" ? "● ONLINE" : "○ OFFLINE"}`,
    ];
    const tabNames: Record<DeckTab, string> = {
      home: "Home",
      work: "Work",
      files: "Files",
      agents: "Agents",
      inbox: "Board",
      more: "Settings",
    };
    this.addControlRow(
      lines,
      NAV_TABS.map((tab, index) => ({
        id: `tab:${tab}`,
        label: `${this.#tab === tab ? tabNames[tab].toUpperCase() : tabNames[tab]} ${index + 1}`,
        activate: () => this.selectTab(tab),
      })),
      safeWidth,
    );
    lines.push(
      "────────────────────────────────────────────────────────────────────────────────",
      "↑↓ move  •  click to select  •  r refresh  •  q close",
      ...(this.#message ? [`◆ ${this.#message}`] : []),
      "",
    );

    if (this.#tab === "home")
      lines.push(...renderHome(state, safeWidth, this.#targetPaneId));
    else if (this.#tab === "files") {
      this.renderFilesProvider(lines, safeWidth, state);
    } else if (this.#tab === "work") {
      this.addControlRow(
        lines,
        (["todo", "tasks", "results", "groups", "history"] as WorkView[]).map(
          (view) => ({
            id: `work:${view}`,
            label:
              this.#workView === view ? view.toUpperCase() : this.title(view),
            activate: () => {
              this.#workView = view;
              this.#closeConfirmation = undefined;
            },
          }),
        ),
        safeWidth,
      );
      const todoItems =
        currentProviderProjection(state, this.#targetPaneId)?.todo.items ?? [];
      const selectedTodo = this.selectedProviderTodo(todoItems);
      if (this.#workView === "todo") {
        const todoStart = lines.length;
        lines.push(
          "",
          ...renderTodoSummary(
            state,
            safeWidth,
            this.#targetPaneId,
            selectedTodo?.id,
          ),
          "",
        );
        this.addEntityHitBoxes(
          lines,
          todoStart,
          todoItems,
          (item) => item.text,
          (id) => {
            this.#selectedProviderTodo = id;
          },
        );
        lines.push(
          ...renderTodoDetail(
            state,
            safeWidth,
            this.#targetPaneId,
            selectedTodo?.id,
          ),
          "",
        );
        this.addControlRow(
          lines,
          [
            {
              id: "todo:start",
              label: "Start",
              disabled:
                !selectedTodo ||
                !this.todoAvailable() ||
                this.#providerPending.has("todo-start"),
              activate: () => void this.runProvider("todoStart", "todo-start"),
            },
            {
              id: "todo:done",
              label: "Mark done",
              disabled:
                !selectedTodo ||
                !this.todoAvailable() ||
                this.#providerPending.has("todo-done"),
              activate: () => void this.runProvider("todoDone", "todo-done"),
            },
            {
              id: "todo:clear-wait",
              label: "Clear external wait",
              disabled:
                !selectedTodo?.waitReason ||
                !this.todoAvailable() ||
                this.#providerPending.has("todo-clear-wait"),
              activate: () =>
                void this.runProvider("todoClearWait", "todo-clear-wait"),
            },
          ],
          safeWidth,
        );
      } else if (this.#workView === "tasks") {
        const scoped = this.scopedWorkState(state);
        const task = this.selectedTask(scoped);
        lines.push("ORCHESTRATOR TASKS · Broker-owned · Adopted scope");
        const start = lines.length;
        lines.push(...renderTasks(scoped, safeWidth, undefined, task?.id), "");
        this.addEntityHitBoxes(
          lines,
          start,
          [...scoped.tasks.values()],
          (item) => item.id,
          (id) => {
            this.#selectedTask = id;
          },
        );
        lines.push(...renderTaskDetail(task, state, safeWidth));
        this.addControlRow(
          lines,
          [
            {
              id: "task:cancel",
              label: "Cancel task",
              disabled: !task,
              activate: () => this.confirmTaskCancel(),
            },
          ],
          safeWidth,
        );
      } else if (this.#workView === "results") {
        const scoped = this.scopedWorkState(state);
        const results = [...scoped.results.values()].sort((a, b) =>
          a.id.localeCompare(b.id),
        );
        lines.push("ORCHESTRATOR RESULTS · Broker-owned", "RESULTS");
        for (const result of results) {
          const y = lines.length;
          lines.push(
            `${this.selectedResult()?.id === result.id ? ">" : " "} ${result.id} · ${result.status} · ${result.summary ?? "No summary"}`,
          );
          this.addHitBox(`result:${result.id}`, y, safeWidth, () => {
            this.#selectedResult = result.id;
          });
        }
        if (results.length === 0) lines.push("No results are visible.");
        lines.push("", ...renderResultDetail(this.selectedResult(), safeWidth));
      } else if (this.#workView === "groups") {
        const scoped = this.scopedWorkState(state);
        const group = this.selectedGroup(scoped);
        lines.push("ORCHESTRATOR GROUPS · Broker-owned · Adopted scope");
        const start = lines.length;
        lines.push(...renderGroups(scoped, safeWidth, group?.id), "");
        this.addEntityHitBoxes(
          lines,
          start,
          [...scoped.groups.values()],
          (item) => item.id,
          (id) => {
            this.#selectedGroup = id;
          },
        );
        lines.push(...renderGroupDetail(group, safeWidth));
        this.addControlRow(
          lines,
          [
            {
              id: "group:wait",
              label: "Wait",
              disabled: !group,
              activate: () => void this.run("groupWait"),
            },
            {
              id: "group:stop",
              label: "Stop",
              disabled: !group,
              activate: () => this.confirmGroup("groupStop"),
            },
            {
              id: "group:close",
              label: "Close",
              disabled: !group,
              activate: () => this.confirmGroup("groupClose"),
            },
          ],
          safeWidth,
        );
      } else {
        const scoped = this.scopedWorkState(state);
        lines.push(
          "HISTORY · TERMINAL TASKS AND RESULTS · Retained broker history",
        );
        lines.push(...renderTasks(scoped, safeWidth), "");
        for (const result of [...scoped.results.values()])
          lines.push(
            `${result.id} · ${result.status} · ${result.summary ?? "No summary"}`,
          );
      }
    } else if (this.#tab === "agents") {
      const agent = this.selectedAgent();
      this.addControlRow(
        lines,
        (["active", "idle", "history"] as const).map((filter) => ({
          id: `agents:filter:${filter}`,
          label: this.#agentFilter === filter ? `[${filter}]` : filter,
          activate: () => {
            this.#agentFilter = filter;
            this.#agentPage = 0;
            this.#selectedAgent = undefined;
          },
        })),
        safeWidth,
      );
      const scopedAgentsState = this.scopedWorkState(state);
      const visibleAgents = this.visibleAgents(scopedAgentsState);
      const start = lines.length;
      lines.push(
        ...renderAgents(
          scopedAgentsState,
          safeWidth,
          agent?.id,
          this.#agentFilter,
          this.#agentPage,
        ),
        "",
      );
      this.addEntityHitBoxes(
        lines,
        start,
        visibleAgents,
        (item) => item.displayName ?? item.herdrName ?? item.id,
        (id) => {
          this.#selectedAgent = id;
        },
      );
      lines.push(...renderAgentInspector(agent, state, safeWidth), "");
      lines.push(
        `Agent controls: ${agent ? `selected ${agent.state}; working-only actions require working state; focus requires a pane; model changes apply only to running agent.` : "select an agent from the current filter."}`,
      );
      this.addControlRow(
        lines,
        [
          {
            id: "agent:focus",
            label: "Focus",
            disabled:
              this.#actions.authorize(
                "focus",
                this.target() as import("./actions.js").ActionTarget,
              ) !== undefined,
            activate: () => void this.run("focus"),
          },
          {
            id: "agent:prompt",
            label: "Prompt",
            disabled:
              this.#actions.authorize(
                "prompt",
                this.target() as import("./actions.js").ActionTarget,
              ) !== undefined,
            activate: () => this.beginInput("prompt"),
          },
          {
            id: "agent:ask",
            label: "Ask",
            disabled:
              this.#actions.authorize(
                "ask",
                this.target() as import("./actions.js").ActionTarget,
              ) !== undefined,
            activate: () => this.beginInput("ask"),
          },
          {
            id: "agent:interrupt",
            label: "Interrupt",
            disabled:
              this.#actions.authorize(
                "interrupt",
                this.target() as import("./actions.js").ActionTarget,
              ) !== undefined || this.selectedAgent()?.state !== "working",
            activate: () => void this.run("interrupt"),
          },
          {
            id: "agent:stop",
            label: "Stop",
            disabled:
              this.#actions.authorize(
                "stop",
                this.target() as import("./actions.js").ActionTarget,
              ) !== undefined,
            activate: () => void this.run("stop"),
          },
          {
            id: "agent:close",
            label: "Close",
            disabled:
              this.#actions.authorize(
                "close",
                this.target() as import("./actions.js").ActionTarget,
              ) !== undefined,
            activate: () => this.confirmClose(),
          },
        ],
        safeWidth,
      );
      this.addControlRow(
        lines,
        [
          {
            id: "agent:steer",
            label: "Steer",
            disabled:
              this.#actions.authorize(
                "steer",
                this.target() as import("./actions.js").ActionTarget,
              ) !== undefined,
            activate: () => this.beginInput("steer"),
          },
          {
            id: "agent:follow-up",
            label: "Follow-up",
            disabled:
              this.#actions.authorize(
                "followUp",
                this.target() as import("./actions.js").ActionTarget,
              ) !== undefined,
            activate: () => this.beginInput("followUp"),
          },
          {
            id: "agent:compact",
            label: "Compact",
            disabled:
              this.#actions.authorize(
                "compact",
                this.target() as import("./actions.js").ActionTarget,
              ) !== undefined || this.selectedAgent()?.state !== "idle",
            activate: () => void this.run("compact"),
          },
          {
            id: "agent:restart",
            label: "Restart",
            disabled:
              this.#actions.authorize(
                "restart",
                this.target() as import("./actions.js").ActionTarget,
              ) !== undefined ||
              ["closed", "stopped"].includes(this.selectedAgent()?.state ?? ""),
            activate: () => void this.run("restart"),
          },
          {
            id: "agent:worktree",
            label: "Open worktree",
            disabled:
              this.#actions.authorize(
                "openWorktree",
                this.target() as import("./actions.js").ActionTarget,
              ) !== undefined,
            activate: () => void this.run("openWorktree"),
          },
          {
            id: "agent:copy-id",
            label: "Copy ID",
            disabled:
              this.#actions.authorize(
                "copyId",
                this.target() as import("./actions.js").ActionTarget,
              ) !== undefined,
            activate: () => void this.copySelectedId(),
          },
          {
            id: "agent:model",
            label: "Running model",
            disabled: getAgentModelChoices(this.selectedAgent()).length === 0,
            activate: () => this.cycleModel(),
          },
          {
            id: "agent:thinking",
            label: "Running thinking",
            disabled:
              getAgentThinkingChoices(this.selectedAgent()).length === 0,
            activate: () => this.cycleThinking(),
          },
          {
            id: "agent:create",
            label: "Create agent (default)",
            disabled: !this.selectedAgent()?.cwd,
            activate: () => this.beginInput("create"),
          },
        ],
        safeWidth,
      );
    } else if (this.#tab === "inbox") {
      this.renderBoardProvider(lines, safeWidth, state);
    } else {
      lines.push("MORE", "Settings and lower-frequency controls", "");
      this.addControlRow(
        lines,
        [
          {
            id: "more:refresh",
            label: "Refresh",
            activate: () => void this.run("refresh"),
          },
          {
            id: "more:default",
            label: "Set model default",
            activate: () => this.beginInput("default"),
          },
          {
            id: "more:auto-close",
            label: "Toggle auto-close",
            activate: () => void this.toggleAutoClose(),
          },
        ],
        safeWidth,
      );
      lines.push("", ...this.renderSettings(safeWidth));
    }

    if (this.#tab === "home") {
      const portfolio = agentPortfolioCounts(state.agents.values());
      lines.push(
        "",
        `ALL HISTORY  ${portfolio.active} live · ${portfolio.idleRetained} retained · ${portfolio.archivedCompleted} archived`,
      );
    }
    if (this.#inputMode) {
      lines.push(`${this.#inputMode.toUpperCase()}: ${this.#input}█`);
      if (this.#inputMode === "create") {
        lines.push(
          "Format: title|objective|profile|provider|model|thinking|lifecycle.",
        );
        lines.push("Lifecycle is temporary, reusable, retained, or pinned.");
      } else if (this.#inputMode === "default")
        lines.push(
          "Format: global||provider|model|thinking, role|profile|provider|model|thinking, or project|cwd|provider|model|thinking.",
        );
      lines.push("Enter submits. Escape cancels. Backspace edits.");
    }
    if (this.#tab === "home" && this.#client.store.notifications.length > 0)
      lines.push(
        "",
        ...renderNotifications(
          this.#client.store.notifications.slice(0, 4),
          safeWidth,
        ),
      );
    const height = Math.max(1, this.#getHeight());
    while (lines.length < height) lines.push("");
    const laidOut = lines
      .slice(0, height)
      .map((line) =>
        line.length <= safeWidth
          ? line
          : `${line.slice(0, Math.max(0, safeWidth - 1))}…`,
      );
    return styleLines(laidOut);
  }

  handleInput(data: string): void {
    if (this.#inputMode) {
      // Navigation remains global while editing. Selecting a tab cancels the
      // tab-local editor instead of typing the tab number into it.
      if (data >= "1" && data <= "6") {
        this.selectTab(NAV_TABS[Number(data) - 1]!);
        this.#requestRender();
        return;
      }
      this.handleEditorInput(data);
      this.#requestRender();
      return;
    }
    if (data === "q" || data === "\u0003" || data === "\u001b") {
      this.#onClose();
      return;
    }
    if (data >= "1" && data <= "6") this.selectTab(NAV_TABS[Number(data) - 1]!);
    else if (data === "r")
      void (this.#tab === "more" ? this.loadSettings() : this.run("refresh"));
    else if (data === "n" && this.#tab === "agents") this.beginInput("create");
    else if (data === "/" && this.#tab === "files")
      this.beginInput("files-filter");
    else if (data === "h" && this.#tab === "files") {
      this.#filesHidden = !this.#filesHidden;
      void this.runFiles("toggle-hidden");
    } else if (data === "c" && this.#tab === "files")
      void this.runFiles("clear-selection");
    else if ((data === "\r" || data === "\n") && this.#tab === "files")
      this.activateSelectedFile();
    else if (data === "p" && this.#tab === "files")
      void this.runFiles("preview", this.#filesPath);
    else if (data === "i" && this.#tab === "files")
      void this.runFiles("insert-paths");
    else if (data === "b" && this.#tab === "files")
      void this.runFiles("insert-contents");
    else if (data === "/" && this.#tab === "more")
      this.beginInput("model-filter");
    else if (data === "d" && this.#tab === "more") this.beginInput("default");
    else if (data === "o" && this.#tab === "more") void this.toggleAutoClose();
    else if (data === "f" && this.#tab === "agents") void this.run("focus");
    else if (data === "p" && this.#tab === "agents") this.beginInput("prompt");
    else if (data === "a" && this.#tab === "agents") this.beginInput("ask");
    else if (data === "a" && this.#tab === "inbox")
      this.beginInput(this.selectedBoardQuestion() ? "board-answer" : "answer");
    else if (data === "y" && this.#tab === "inbox")
      void this.runBoard("accept-recommendation");
    else if (data === "d" && this.#tab === "inbox")
      void this.runBoard("dismiss-question");
    else if (data === "r" && this.#tab === "inbox")
      void this.runBoard("retry-delivery");
    else if (data === "i" && this.#tab === "agents") void this.run("interrupt");
    else if (data === "s" && this.#tab === "agents") void this.run("stop");
    else if (data === "x" && this.#tab === "agents") this.confirmClose();
    else if (data === "m" && this.#tab === "agents") this.cycleModel();
    else if (data === "t" && this.#tab === "agents") this.cycleThinking();
    else if (data === "\u001b[A" || data === "k") this.move(-1);
    else if (data === "\u001b[B" || data === "j") this.move(1);
    this.#requestRender();
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (event.type === "wheel") {
      this.move(event.direction === "down" ? 1 : -1);
      this.#requestRender();
      return true;
    }
    const handled = this.#tracker.handle(event, this.#hitBoxes);
    if (handled) this.#requestRender();
    return handled;
  }

  invalidate(): void {
    this.#requestRender();
  }

  private title(value: string): string {
    return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
  }

  private selectTab(tab: DeckTab): void {
    // Input belongs to the tab that opened it. Never carry it into another tab.
    this.#inputMode = undefined;
    this.#input = "";
    this.#tab = tab;
    if (tab === "work") {
      this.#workView = "todo";
      this.#selectedTask = undefined;
      this.#selectedResult = undefined;
      this.#selectedGroup = undefined;
    }
    this.#closeConfirmation = undefined;
    this.#tracker.reset();
    if (tab === "more") {
      this.#settingsScroll = 0;
      void this.loadSettings();
    }
    this.#requestRender();
  }

  private addHitBox(
    id: string,
    y: number,
    width: number,
    activate: () => void,
    disabled = false,
    x = 0,
  ): void {
    this.#hitBoxes.push({ id, x, y, width, height: 1, disabled, activate });
  }

  private addControlRow(
    lines: string[],
    controls: Array<{
      id: string;
      label: string;
      disabled?: boolean;
      activate(): void;
    }>,
    width: number,
  ): void {
    let line = "";
    let y = lines.length;
    for (const control of controls) {
      const rendered = renderButton(control.label, {
        disabled: control.disabled === true,
      });
      if (line.length > 0 && line.length + 1 + rendered.length > width) {
        lines.push(line);
        line = "";
        y = lines.length;
      }
      if (line.length > 0) line += " ";
      const x = line.length;
      line += rendered;
      this.addHitBox(
        control.id,
        y,
        Math.min(rendered.length, width),
        control.activate,
        control.disabled === true,
        x,
      );
    }
    lines.push(line.slice(0, width));
  }

  private addEntityHitBoxes<T extends { id: string }>(
    lines: readonly string[],
    start: number,
    items: readonly T[],
    needle: (item: T) => string,
    select: (id: string) => void,
  ): void {
    for (const item of items) {
      const y = lines.findIndex(
        (line, index) => index >= start && line.includes(needle(item)),
      );
      if (y >= start)
        this.addHitBox(`row:${item.id}`, y, Math.max(1, lines[y]!.length), () =>
          select(item.id),
        );
    }
  }

  private adoptedRootAgent(): Agent | undefined {
    const owner = currentProviderProjection(
      this.#client.store.state,
      this.#targetPaneId,
    )?.ownerAgentId;
    return owner ? this.#client.store.state.agents.get(owner) : undefined;
  }

  private providerRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
  private visibleFileRows(state: DeckState): Record<string, unknown>[] {
    const files = currentProviderProjection(state, this.#targetPaneId)?.files;
    const view = this.providerRecord(files?.view);
    const rows = Array.isArray(view.rows)
      ? view.rows.map((item) => this.providerRecord(item))
      : [];
    const filter = this.#filesFilter.toLowerCase();
    return rows.filter(
      (row) =>
        !filter ||
        String(row.name ?? row.path)
          .toLowerCase()
          .includes(filter),
    );
  }
  private activateSelectedFile(): void {
    if (!this.#filesPath) return;
    const row = this.visibleFileRows(this.#client.store.state).find(
      (item) => String(item.path ?? "") === this.#filesPath,
    );
    if (!row) return;
    const folder = row.kind === "directory" || row.kind === "root";
    if (folder) void this.runFiles("expand", this.#filesPath);
    else
      void this.runFiles("toggle-selection", this.#filesPath).then(() =>
        this.runFiles("preview", this.#filesPath),
      );
  }
  private renderFilesProvider(
    lines: string[],
    width: number,
    state: DeckState,
  ): void {
    const projection = currentProviderProjection(state, this.#targetPaneId);
    const files = projection?.files;
    const view = this.providerRecord(files?.view);
    const summary = this.providerRecord(files?.summary);
    const rows = Array.isArray(view.rows)
      ? view.rows.map((item) => this.providerRecord(item))
      : [];
    const cwd = String(summary.cwd ?? view.cwd ?? "");
    const currentPath = String(
      (view.currentPath ?? summary.currentPath ?? this.#filesPath) || ".",
    );
    lines.push(
      "FILES",
      `${files?.available ? "● READY" : "○ CONNECTING"}  ${cwd || "Waiting for the Pi Files provider…"}`,
    );
    this.addControlRow(
      lines,
      [
        {
          id: "files:refresh",
          label: "↻ Refresh",
          disabled: !files?.available,
          activate: () => void this.runFiles("snapshot"),
        },
        {
          id: "files:preview",
          label: "Preview",
          disabled: !files?.available || !this.#filesPath,
          activate: () => void this.runFiles("preview", this.#filesPath),
        },
        {
          id: "files:clear",
          label: "Clear selection",
          disabled:
            !files?.available || Number(summary.selectedCount ?? 0) === 0,
          activate: () => void this.runFiles("clear-selection"),
        },
        {
          id: "files:paths",
          label: "Insert paths",
          disabled:
            !files?.available || Number(summary.selectedCount ?? 0) === 0,
          activate: () => void this.runFiles("insert-paths"),
        },
        {
          id: "files:contents",
          label: "Insert contents",
          disabled:
            !files?.available || Number(summary.selectedCount ?? 0) === 0,
          activate: () => void this.runFiles("insert-contents"),
        },
      ],
      width,
    );
    lines.push(
      `⌂ /${currentPath === "." ? "" : currentPath}   ${String(summary.selectedCount ?? 0)} selected   ${this.#filesFilter ? `filter: ${this.#filesFilter}` : "no filter"}`,
      "TREE",
    );
    const visible = rows.filter(
      (row) =>
        !this.#filesFilter ||
        String(row.name ?? row.path)
          .toLowerCase()
          .includes(this.#filesFilter.toLowerCase()),
    );
    const rowBudget = Math.max(3, this.#getHeight() - lines.length - 12);
    const selectedIndex = visible.findIndex(
      (row) => String(row.path ?? "") === this.#filesPath,
    );
    if (selectedIndex >= 0) {
      if (selectedIndex < this.#filesScroll) this.#filesScroll = selectedIndex;
      if (selectedIndex >= this.#filesScroll + rowBudget)
        this.#filesScroll = selectedIndex - rowBudget + 1;
    }
    this.#filesScroll = Math.max(
      0,
      Math.min(this.#filesScroll, Math.max(0, visible.length - rowBudget)),
    );
    for (const row of visible.slice(
      this.#filesScroll,
      this.#filesScroll + rowBudget,
    )) {
      const path = String(row.path ?? "");
      const selected = row.selected === true;
      const marker = selected ? "●" : row.partiallySelected ? "◐" : "○";
      const folder = row.kind === "directory" || row.kind === "root";
      const caret = folder ? (row.expanded ? "▾" : "▸") : "·";
      const cursor = path === this.#filesPath ? ">" : " ";
      const y = lines.length;
      lines.push(
        `${cursor} ${marker} ${"  ".repeat(Math.max(0, Number(row.depth ?? 0)))}${caret} ${String(row.name ?? path)}${row.error ? `  ! ${String(row.error)}` : ""}`,
      );
      this.addHitBox(`files:row:${path}`, y, width, () => {
        this.#filesPath = path;
        if (folder) void this.runFiles("expand", path);
        else
          void this.runFiles("toggle-selection", path).then(() =>
            this.runFiles("preview", path),
          );
      });
    }
    if (visible.length > rowBudget)
      lines.push(
        `  ↕ ${this.#filesScroll + 1}-${Math.min(visible.length, this.#filesScroll + rowBudget)} of ${visible.length} · scroll or ↑↓ to move`,
      );
    const preview = this.providerRecord(view.preview);
    if (Object.keys(preview).length) {
      lines.push(
        "",
        `PREVIEW  ${String(this.#filesPreviewPath ?? this.#filesPath)}`,
      );
      for (const line of Array.isArray(preview.lines)
        ? preview.lines.slice(0, 8)
        : [])
        lines.push(`│ ${String(line)}`);
      if (preview.error) lines.push(`! ${String(preview.error)}`);
    }
    if (files?.error && !(files.available && rows.length > 0))
      lines.push("", `! ${files.error}`);
    lines.push(
      "",
      `/ filter${this.#filesFilter ? `: ${this.#filesFilter}` : ""}  •  h hidden ${this.#filesHidden ? "on" : "off"}  •  Enter open/select  •  p preview`,
    );
    const selectedCount = Number(summary.selectedCount ?? 0);
    this.addControlRow(
      lines,
      [
        {
          id: "files:insert-paths",
          label: `Insert paths (${selectedCount})`,
          disabled: selectedCount === 0,
          activate: () => void this.runFiles("insert-paths"),
        },
        {
          id: "files:insert-contents",
          label: `Insert contents (${selectedCount})`,
          disabled: selectedCount === 0,
          activate: () => void this.runFiles("insert-contents"),
        },
        {
          id: "files:clear",
          label: "Clear selection",
          disabled: selectedCount === 0,
          activate: () => void this.runFiles("clear-selection"),
        },
        {
          id: "files:open",
          label: "Open standalone view",
          disabled: !this.adoptedRootAgent(),
          activate: () => void this.runProvider("filesOpen", "files-open"),
        },
      ],
      width,
    );
  }
  private renderBoardProvider(
    lines: string[],
    width: number,
    state: DeckState,
  ): void {
    const boardProjection = currentProviderProjection(
      state,
      this.#targetPaneId,
    )?.agentBoard;
    const board = this.providerRecord(boardProjection?.view);
    const model = this.providerRecord(board.view ?? board);
    const tabs = this.providerRecord(model.tabs);
    const counts = this.providerRecord(model.tabCounts);
    lines.push(
      "AGENT BOARD",
      boardProjection?.available
        ? `● READY  ${Number(counts.inbox ?? boardProjection.openCount ?? 0)} questions need attention`
        : "○ CONNECTING  Waiting for the active Pi Agent Board provider",
    );
    this.addControlRow(
      lines,
      (["inbox", "updates", "decisions", "history"] as const).map(
        (tabName) => ({
          id: `board:tab:${tabName}`,
          label: `${this.#boardTab === tabName ? "● " : ""}${this.title(tabName)} ${Number(counts[tabName] ?? 0)}`,
          activate: () => {
            this.#boardTab = tabName;
            this.#boardSelection = undefined;
            this.#boardRevision = 0;
          },
        }),
      ),
      width,
    );

    const tab = this.providerRecord(tabs[this.#boardTab]);
    const rows = this.boardRows(tab, boardProjection?.items ?? []);
    if (!this.#boardSelection && rows.length > 0) {
      this.#boardSelection = String(rows[0]?.id ?? rows[0]?.entityId ?? "");
      this.#boardRevision = Number(rows[0]?.revision ?? 0);
    }
    const empty = this.providerRecord(tab.empty);
    if (rows.length === 0) {
      lines.push(
        boardProjection?.available
          ? `✓ ${String(empty.title ?? "This section is clear.")}`
          : "Waiting for provider data…",
      );
      if (typeof empty.detail === "string") lines.push(empty.detail);
    }
    for (const row of rows) {
      const id = String(row.id ?? row.entityId ?? "");
      const selected = id === this.#boardSelection;
      const y = lines.length;
      lines.push(
        `${selected ? ">" : " "} [${String(row.statusLabel ?? row.state ?? "OPEN")}] ${String(row.displayId ?? id)}  ${String(row.title ?? row.question ?? "").slice(0, Math.max(20, width - 28))}`,
      );
      this.addHitBox(`board:row:${id}`, y, width, () => {
        this.#boardSelection = id;
        this.#boardRevision = Number(row.revision ?? 0);
      });
    }

    const selectedRow = rows.find(
      (row) => String(row.id ?? row.entityId ?? "") === this.#boardSelection,
    );
    const details = this.providerRecord(tab.detailsById);
    const detail = this.providerRecord(
      details[this.#boardSelection ?? ""] ?? tab.detail,
    );
    if (Object.keys(detail).length > 0)
      lines.push("", ...this.renderBoardDetail(detail, width));

    const question =
      this.#boardTab === "inbox" ? this.selectedBoardQuestion() : undefined;
    if (question && question.response.options.length > 0) {
      lines.push("", "RESPONSE");
      for (const option of question.response.options) {
        const selected =
          this.#boardSelections.get(question.questionId)?.has(option.id) ===
          true;
        const y = lines.length;
        lines.push(
          `${selected ? "[x]" : "[ ]"} ${option.label}${option.description ? ` — ${option.description}` : ""}`,
        );
        this.addHitBox(
          `board:option:${option.id}`,
          y,
          width,
          () => this.toggleBoardOption(question.questionId, option.id),
          this.#providerPending.has("board-answer"),
        );
      }
    }

    const userAnswerable = selectedRow?.userAnswerable === true;
    const dismissible = selectedRow?.dismissible === true;
    const retryable = selectedRow?.retryableDelivery === true;
    const updateKind = String(selectedRow?.kind ?? "");
    if (selectedRow)
      this.addControlRow(
        lines,
        [
          {
            id: "board:answer",
            label: "Answer",
            disabled:
              !userAnswerable ||
              !question ||
              this.#providerPending.has("board-answer"),
            activate: () =>
              question?.response.kind === "text" ||
              question?.response.kind.includes("_or_text")
                ? this.beginInput("board-answer")
                : this.submitBoardAnswer(),
          },
          {
            id: "board:accept",
            label: "Use recommendation",
            disabled:
              !userAnswerable ||
              !question ||
              (question.recommendedOptionIds.length === 0 &&
                !question.recommendedText),
            activate: () => void this.runBoard("accept-recommendation"),
          },
          {
            id: "board:dismiss",
            label: "Dismiss",
            disabled: !dismissible,
            activate: () => void this.runBoard("dismiss-question"),
          },
          {
            id: "board:retry",
            label: "Retry delivery",
            disabled: !retryable,
            activate: () => void this.runBoard("retry-delivery"),
          },
          {
            id: "board:archive",
            label: "Archive",
            disabled:
              this.#boardTab !== "updates" ||
              !["completed", "failed"].includes(updateKind),
            activate: () => void this.runBoard("archive-update"),
          },
        ],
        width,
      );
  }
  private boardRows(
    tab: Record<string, unknown>,
    fallbackItems: readonly unknown[],
  ): Record<string, unknown>[] {
    if (Array.isArray(tab.rows))
      return tab.rows.map((item) => this.providerRecord(item));
    return fallbackItems.map((item) => {
      const row = this.providerRecord(item);
      return { ...row, statusLabel: row.statusLabel ?? row.state ?? "OPEN" };
    });
  }

  private renderBoardDetail(
    detail: Record<string, unknown>,
    width: number,
  ): string[] {
    const projection = this.providerRecord(detail.projection ?? detail);
    const item = this.providerRecord(
      projection.item ?? detail.item ?? detail.decision ?? projection,
    );
    const lines: string[] = ["DETAIL"];
    const add = (label: string, value: unknown): void => {
      if (typeof value === "string" && value.length > 0)
        lines.push(
          `${label}  ${value.slice(0, Math.max(20, width - label.length - 2))}`,
        );
    };
    add("ID", item.displayId ?? item.id ?? detail.displayId ?? detail.id);
    add(
      "Status",
      detail.statusLabel ?? item.status ?? item.kind ?? detail.terminalKind,
    );
    add(
      "Title",
      item.title ?? item.question ?? detail.title ?? detail.question,
    );
    add("Why", item.reason ?? projection.reason ?? detail.reason);
    add("Detail", item.detail ?? detail.detail);
    add(
      "Recommendation",
      item.recommendation ?? projection.recommendation ?? detail.recommendation,
    );
    add("Stage", item.stage ?? detail.stage);
    const progress = this.providerRecord(item.progress ?? detail.progress);
    if (Number.isFinite(progress.current) && Number.isFinite(progress.total))
      lines.push(
        `Progress  ${progress.current}/${progress.total}${typeof progress.unit === "string" ? ` ${progress.unit}` : ""}`,
      );
    const attachments = Array.isArray(item.attachments)
      ? item.attachments
      : Array.isArray(detail.attachments)
        ? detail.attachments
        : [];
    for (const raw of attachments.slice(0, 5)) {
      const attachment = this.providerRecord(raw);
      add(
        "Attachment",
        `${String(attachment.label ?? attachment.kind ?? "item")} — ${String(attachment.path ?? attachment.url ?? attachment.reference ?? attachment.text ?? "")}`,
      );
    }
    add(
      "Terminal",
      detail.terminalAt
        ? `${String(detail.terminalKind ?? "terminal")} at ${detail.terminalAt}`
        : undefined,
    );
    return lines;
  }

  private async runFiles(action: string, value?: string): Promise<void> {
    const agent = this.adoptedRootAgent();
    if (!agent) {
      this.#message = "Files provider owner is unavailable.";
      return;
    }
    try {
      await this.#actions.run("filesAction", {
        agent,
        filesAction: {
          action,
          ...(value
            ? action === "filter"
              ? { query: value }
              : { path: value }
            : {}),
        },
      } as never);
      this.#filesPreviewPath =
        action === "preview" ? value : this.#filesPreviewPath;
      this.#message = `Files ${action} succeeded.`;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }
  private async runBoard(action: string): Promise<void> {
    const agent = this.adoptedRootAgent();
    if (!agent || !this.#boardSelection) return;
    const id = this.#boardSelection;
    const projection = currentProviderProjection(
      this.#client.store.state,
      this.#targetPaneId,
    )?.agentBoard;
    const view = this.providerRecord(projection?.view);
    const model = this.providerRecord(view.view ?? view);
    const tabs = this.providerRecord(model.tabs);
    const tab = this.providerRecord(tabs[this.#boardTab]);
    const details = this.providerRecord(tab.detailsById);
    const detail = this.providerRecord(details[id] ?? tab.detail);
    const detailProjection = this.providerRecord(detail.projection ?? detail);
    const item = this.providerRecord(
      detailProjection.item ?? detailProjection.decision ?? detailProjection,
    );
    const answer = this.providerRecord(
      detailProjection.answer ??
        this.providerRecord(detailProjection.decision).answer,
    );
    const questionId = String(item.id ?? item.questionId ?? id);
    const answerId = String(
      answer.id ?? answer.answerId ?? detailProjection.answerId ?? id,
    );
    const fields =
      action === "archive-update"
        ? { updateId: id, expectedRevision: this.#boardRevision }
        : action === "acknowledge-answer"
          ? {
              answerId,
              outcome: "applied",
              summary: "Acknowledged from Pi Herd Deck.",
            }
          : action === "retry-delivery"
            ? { questionId, answerId, expectedRevision: this.#boardRevision }
            : { questionId, expectedRevision: this.#boardRevision };
    try {
      await this.#actions.run("boardAction", {
        agent,
        boardAction: { action, fields },
      } as never);
      this.#message = `Agent Board ${action} succeeded.`;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private scopedWorkState(state: DeckState): DeckState {
    const root = this.adoptedRootAgent();
    if (!root)
      return {
        ...state,
        agents: new Map(),
        tasks: new Map(),
        results: new Map(),
        groups: new Map(),
      };
    const agents = new Set<string>([root.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const agent of state.agents.values())
        if (
          agent.parentAgentId &&
          agents.has(agent.parentAgentId) &&
          !agents.has(agent.id)
        ) {
          agents.add(agent.id);
          changed = true;
        }
    }
    const scopedAgents = new Map(
      [...state.agents].filter(([id]) => agents.has(id)),
    );
    const tasks = new Map(
      [...state.tasks].filter(
        ([, task]) =>
          task.assignedAgentId && agents.has(task.assignedAgentId) && true,
      ),
    );
    const results = new Map(
      [...state.results].filter(([, result]) =>
        result.taskId ? tasks.has(result.taskId) : false,
      ),
    );
    const groups = new Map(
      [...state.groups].filter(([, group]) =>
        group.taskIds?.some((id: string) => tasks.has(id)),
      ),
    );
    return { ...state, agents: scopedAgents, tasks, results, groups };
  }

  private visibleAgents(state: DeckState): Agent[] {
    const active = new Set([
      "provisioning",
      "starting",
      "working",
      "blocked",
      "stopping",
    ]);
    const idle = new Set(["idle"]);
    return [...state.agents.values()]
      .filter((agent) =>
        this.#agentFilter === "active"
          ? active.has(agent.state)
          : this.#agentFilter === "idle"
            ? idle.has(agent.state)
            : !active.has(agent.state) && !idle.has(agent.state),
      )
      .sort((a, b) => b.id.localeCompare(a.id))
      .slice(this.#agentPage * 12, this.#agentPage * 12 + 12);
  }

  private selectedAgent(): Agent | undefined {
    return this.selected(
      this.visibleAgents(this.scopedWorkState(this.#client.store.state)),
      this.#selectedAgent,
    );
  }
  private selectedGroup(
    state: DeckState = this.#client.store.state,
  ): DeckGroup | undefined {
    return this.selected([...state.groups.values()], this.#selectedGroup);
  }
  private selectedTask(
    state: DeckState = this.#client.store.state,
  ): Task | undefined {
    return this.selected([...state.tasks.values()], this.#selectedTask);
  }
  private selectedProviderTodo(
    items = currentProviderProjection(
      this.#client.store.state,
      this.#targetPaneId,
    )?.todo.items ?? [],
  ) {
    return this.selected(items, this.#selectedProviderTodo);
  }
  private selectedResult(
    state: DeckState = this.#client.store.state,
  ): DeckResult | undefined {
    return this.selected([...state.results.values()], this.#selectedResult);
  }
  private selectedQuestion(): DeckQuestion | undefined {
    return this.selected(
      currentBlockingQuestions(this.#client.store.state, this.#targetPaneId),
      this.#selectedQuestion,
    );
  }

  private selectedBoardQuestion(): AgentBoardPendingQuestion | undefined {
    const projection = currentProviderProjection(
      this.#client.store.state,
      this.#targetPaneId,
    )?.agentBoard;
    const questions = projection?.pendingQuestions ?? [];
    const view = this.providerRecord(projection?.view);
    const model = this.providerRecord(view.view ?? view);
    const tabs = this.providerRecord(model.tabs);
    const inbox = this.providerRecord(tabs.inbox);
    const details = this.providerRecord(inbox.detailsById);
    const detail = this.providerRecord(
      details[this.#boardSelection ?? ""] ?? inbox.detail,
    );
    const detailProjection = this.providerRecord(detail.projection);
    const item = this.providerRecord(
      detailProjection.item ?? detailProjection.question ?? detailProjection,
    );
    const response = this.providerRecord(
      detailProjection.response ?? item.response,
    );
    const questionId = String(item.id ?? item.questionId ?? "");
    const question = String(
      item.question ??
        item.prompt ??
        item.title ??
        detailProjection.question ??
        "",
    );
    const revision = Number(item.revision ?? detailProjection.revision ?? 0);
    const kind = response.kind;
    if (
      !questionId ||
      !question ||
      !Number.isSafeInteger(revision) ||
      ![
        "single",
        "multiple",
        "text",
        "single_or_text",
        "multiple_or_text",
      ].includes(String(kind))
    ) {
      return (
        (this.#boardSelection
          ? questions.find((entry) => entry.questionId === this.#boardSelection)
          : undefined) ?? questions[0]
      );
    }
    const options = Array.isArray(response.options)
      ? response.options.flatMap((value) => {
          const option = this.providerRecord(value);
          const id = typeof option.id === "string" ? option.id : "";
          const label = typeof option.label === "string" ? option.label : "";
          return id && label
            ? [
                {
                  id,
                  label,
                  ...(typeof option.description === "string"
                    ? { description: option.description }
                    : {}),
                },
              ]
            : [];
        })
      : [];
    const recommendedOptionIds =
      item.recommendedOptionIds ?? detailProjection.recommendedOptionIds;
    const recommendedText =
      item.recommendedText ?? detailProjection.recommendedText;
    return {
      questionId,
      revision,
      question,
      response: {
        kind: kind as AgentBoardPendingQuestion["response"]["kind"],
        options,
      },
      recommendedOptionIds: Array.isArray(recommendedOptionIds)
        ? recommendedOptionIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      ...(typeof recommendedText === "string" ? { recommendedText } : {}),
    };
  }

  private todoAvailable(): boolean {
    return (
      currentProviderProjection(this.#client.store.state, this.#targetPaneId)
        ?.todo.available === true
    );
  }

  private toggleBoardOption(questionId: string, optionId: string): void {
    const question = this.selectedBoardQuestion();
    if (!question || this.#providerPending.has("board-answer")) return;
    const set = this.#boardSelections.get(questionId) ?? new Set<string>();
    if (
      question.response.kind === "single" ||
      question.response.kind === "single_or_text"
    )
      set.clear();
    if (set.has(optionId)) set.delete(optionId);
    else set.add(optionId);
    this.#boardSelections.set(questionId, set);
    this.#requestRender();
  }

  private submitBoardAnswer(): void {
    const question = this.selectedBoardQuestion();
    if (!question) return;
    const selected = [
      ...(this.#boardSelections.get(question.questionId) ?? []),
    ];
    if (selected.length === 0) {
      this.#message = "Choose an Agent Board option or enter text.";
      this.#requestRender();
      return;
    }
    const kind = question.response.kind;
    const value =
      kind === "multiple" || kind === "multiple_or_text"
        ? { kind: "multiple", optionIds: selected }
        : { kind: "single", optionId: selected[0] };
    this.runProvider("agentBoardAnswer", "board-answer", value);
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
    if (this.#tab === "agents") {
      const items = this.visibleAgents(this.scopedWorkState(state));
      this.#selectedAgent = this.nextId(items, this.selectedAgent()?.id, delta);
      if (
        delta > 0 &&
        items.length &&
        this.#selectedAgent === items[items.length - 1]?.id
      )
        this.#agentPage++;
      if (delta < 0 && items.length && this.#selectedAgent === items[0]?.id)
        this.#agentPage = Math.max(0, this.#agentPage - 1);
    } else if (this.#tab === "work" && this.#workView === "groups")
      this.#selectedGroup = this.nextId(
        [...state.groups.values()],
        this.selectedGroup()?.id,
        delta,
      );
    else if (this.#tab === "work" && this.#workView === "todo") {
      const items =
        currentProviderProjection(state, this.#targetPaneId)?.todo.items ?? [];
      this.#selectedProviderTodo = this.nextId(
        items,
        this.selectedProviderTodo(items)?.id,
        delta,
      );
    } else if (this.#tab === "work" && this.#workView === "tasks")
      this.#selectedTask = this.nextId(
        [...this.scopedWorkState(state).tasks.values()],
        this.selectedTask(this.scopedWorkState(state))?.id,
        delta,
      );
    else if (this.#tab === "work" && this.#workView === "results")
      this.#selectedResult = this.nextId(
        [...state.results.values()],
        this.selectedResult()?.id,
        delta,
      );
    else if (this.#tab === "files") {
      const items = this.visibleFileRows(state);
      if (items.length > 0) {
        const index = items.findIndex(
          (row) => String(row.path ?? "") === this.#filesPath,
        );
        const next =
          index < 0
            ? 0
            : Math.max(0, Math.min(items.length - 1, index + delta));
        this.#filesPath = String(items[next]?.path ?? "");
      }
    } else if (this.#tab === "inbox") {
      const projection = currentProviderProjection(
        state,
        this.#targetPaneId,
      )?.agentBoard;
      const board = this.providerRecord(projection?.view);
      const model = this.providerRecord(board.view ?? board);
      const tabs = this.providerRecord(model.tabs);
      const tab = this.providerRecord(tabs[this.#boardTab]);
      const rows = this.boardRows(tab, projection?.items ?? []);
      if (rows.length > 0) {
        const index = rows.findIndex(
          (row) =>
            String(row.id ?? row.entityId ?? "") === this.#boardSelection,
        );
        const next =
          rows[index < 0 ? 0 : (index + delta + rows.length) % rows.length];
        this.#boardSelection = String(next?.id ?? next?.entityId ?? "");
        this.#boardRevision = Number(next?.revision ?? 0);
      }
    } else if (this.#tab === "more")
      this.#settingsScroll = Math.max(
        0,
        Math.min(
          Math.max(0, (this.#capabilities?.models.length ?? 0) - 1),
          this.#settingsScroll + delta,
        ),
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
    const agent =
      this.#tab === "work" || this.#tab === "files"
        ? this.adoptedRootAgent()
        : (this.selectedAgent() ?? this.adoptedRootAgent());
    const task = this.selectedTask();
    const question = this.selectedQuestion();
    const group = this.selectedGroup();
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
      ...(group ? { group } : {}),
      ...(this.selectedProviderTodo()
        ? {
            todoTaskId: this.selectedProviderTodo()!.id,
            todoHasWait: Boolean(this.selectedProviderTodo()!.waitReason),
          }
        : {}),
      ...(question ? { question, questionId: question.id } : {}),
      ...(this.selectedBoardQuestion()
        ? {
            boardQuestion: this.selectedBoardQuestion(),
            questionId: this.selectedBoardQuestion()!.questionId,
          }
        : {}),
    };
  }

  private runProvider(action: DeckAction, key: string, value?: unknown): void {
    if (this.#providerPending.has(key)) return;
    this.#providerPending.add(key);
    this.#message = `${action} pending…`;
    this.#requestRender();
    void this.#actions
      .run(
        action,
        this.target() as import("./actions.js").ActionTarget,
        value as never,
      )
      .then(
        () => {
          this.#message = `${action} succeeded.`;
        },
        (error) => {
          this.#message =
            error instanceof Error ? error.message : String(error);
        },
      )
      .finally(() => {
        this.#providerPending.delete(key);
        this.#requestRender();
      });
  }
  private async run(action: DeckAction, value?: string): Promise<void> {
    try {
      const result = await this.#actions.run(
        action,
        this.target() as import("./actions.js").ActionTarget,
        value,
      );
      this.#message =
        action === "copyId"
          ? `Copied ID: ${String(result)}`
          : `${action} accepted.`;
      this.#closeConfirmation = undefined;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private beginInput(mode: InputMode): void {
    const target = this.target() as import("./actions.js").ActionTarget;
    if (mode === "board-answer" && !this.selectedBoardQuestion()) {
      this.#message = "Select an Agent Board question first.";
      return;
    }
    if (mode === "create" && !target.agent) {
      this.#message = "Select a parent agent first.";
      return;
    }
    const action: DeckAction =
      mode === "answer" ? "answer" : (mode as DeckAction);
    const denied =
      mode === "create" || mode === "default"
        ? undefined
        : this.#actions.authorize(action, target);
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
      if (mode === "create") void this.createAgent(value);
      else if (mode === "files-filter") {
        this.#filesFilter = value;
        this.#filesScroll = 0;
        void this.runFiles("filter", value);
      } else if (mode === "model-filter") {
        this.#modelFilter = value;
        this.#settingsScroll = 0;
        this.#inputMode = undefined;
        this.#input = "";
      } else if (mode === "default") void this.setDefault(value);
      else if (mode === "board-answer") {
        const question = this.selectedBoardQuestion();
        if (question)
          this.runProvider("agentBoardAnswer", "board-answer", {
            kind: "text",
            text: value,
          });
      } else void this.run(mode === "answer" ? "answer" : mode, value);
    } else if (
      data.length > 0 &&
      !data.includes("\u001b") &&
      [...data].every((character) => character.codePointAt(0)! >= 0x20)
    )
      this.#input = `${this.#input}${data}`.slice(0, 16_384);
  }

  private renderSettings(_width: number): string[] {
    const defaults = this.#modelPolicy?.defaults;
    const lines = [
      "DEFAULTS FOR NEW AGENTS",
      `Global  ${defaults?.global ? `${defaults.global.provider}/${defaults.global.modelId}  ·  ${defaults.global.thinkingLevel}` : "Not set"}`,
      ...Object.entries(defaults?.roles ?? {}).map(
        ([key, model]) =>
          `Role ${key}  ${model.provider}/${model.modelId}  ·  ${model.thinkingLevel}`,
      ),
      ...Object.entries(defaults?.projects ?? {}).map(
        ([key, model]) =>
          `Project ${key}  ${model.provider}/${model.modelId}  ·  ${model.thinkingLevel}`,
      ),
      "",
      "LIFECYCLE",
      `Automatic close after collected temporary work  ${this.#autoCloseCompletedTemporary ? "● ON" : "○ OFF"}`,
      "Completed work is collected before safe automatic closure.",
      "",
      "MODEL CATALOG",
      `${this.#modelFilter ? `Search: ${this.#modelFilter}` : "Press / to search by provider or model"}`,
    ];
    if (!this.#capabilities) {
      lines.push("Loading installed Pi capabilities…");
      return lines;
    }
    const filtered = this.#capabilities.models.filter(
      (model) =>
        !this.#modelFilter ||
        `${model.provider}/${model.modelId}`
          .toLowerCase()
          .includes(this.#modelFilter.toLowerCase()),
    );
    const providerCounts = new Map<string, number>();
    for (const model of filtered)
      providerCounts.set(
        model.provider,
        (providerCounts.get(model.provider) ?? 0) + 1,
      );
    lines.push(
      `${filtered.length} models from ${providerCounts.size} providers`,
    );
    if (!this.#modelFilter) {
      for (const [provider, count] of [...providerCounts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8))
        lines.push(`  ${provider}  ${count} models`);
      lines.push(
        "",
        "Search to choose an exact model. The full catalog stays out of the main view.",
      );
    } else {
      const pageSize = Math.max(3, this.#getHeight() - lines.length - 4);
      const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
      const page = Math.min(
        Math.floor(this.#settingsScroll / pageSize),
        pages - 1,
      );
      const start = page * pageSize;
      for (const model of filtered.slice(start, start + pageSize))
        lines.push(
          `  ${model.provider}/${model.modelId}  ·  ${model.thinkingLevels.join(" ")}`,
        );
      lines.push(
        `Page ${page + 1}/${pages}  ·  ↑↓ browse  ·  d set scoped default`,
      );
    }
    return lines;
  }

  private async loadSettings(): Promise<void> {
    try {
      const [capabilities, settings] = await Promise.all([
        this.#client.request("model.capabilities", {}),
        this.#client.request("model.policy.get", {}),
      ]);
      this.#capabilities = capabilities as PiCapabilitySnapshot;
      const loaded = settings as {
        policy?: ModelPolicyConfig;
        lifecyclePolicy?: { autoCloseCompletedTemporary?: boolean };
      };
      this.#modelPolicy = loaded.policy;
      this.#autoCloseCompletedTemporary =
        loaded.lifecyclePolicy?.autoCloseCompletedTemporary === true;
      this.#message = "Installed model choices loaded.";
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private async toggleAutoClose(): Promise<void> {
    try {
      const enabled = !this.#autoCloseCompletedTemporary;
      await this.#client.request("lifecycle.policy.set", {
        autoCloseCompletedTemporary: enabled,
      });
      this.#autoCloseCompletedTemporary = enabled;
      this.#message = `Safe automatic closure is ${enabled ? "on" : "off"}. Protected and uncollected agents stay open.`;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private async setDefault(value: string): Promise<void> {
    const [scope, key, provider, modelId, thinkingLevel, ...extra] = value
      .split("|")
      .map((part) => part.trim());
    if (
      extra.length ||
      !scope ||
      !provider ||
      !modelId ||
      !thinkingLevel ||
      !["global", "role", "project"].includes(scope)
    ) {
      this.#message =
        "Use scope|key|provider|model|thinking. The global key is empty.";
      this.#requestRender();
      return;
    }
    try {
      await this.#client.request("model.policy.set", {
        scope,
        key: key ?? "",
        model: { provider, modelId, thinkingLevel },
      });
      await this.loadSettings();
      this.#message =
        "The scoped default was accepted for new agents. Running agents were not changed.";
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private async createAgent(value: string): Promise<void> {
    const [
      title,
      objective,
      profileId,
      provider,
      modelId,
      thinkingLevel,
      lifecycleClass,
      ...extra
    ] = value.split("|").map((part) => part.trim());
    const parent = this.selectedAgent();
    if (
      extra.length ||
      !parent?.cwd ||
      !title ||
      !objective ||
      !profileId ||
      !provider ||
      !modelId ||
      !thinkingLevel ||
      !["temporary", "reusable", "retained", "pinned"].includes(
        lifecycleClass ?? "",
      )
    ) {
      this.#message =
        "Use title|objective|profile|provider|model|thinking|lifecycle with a parent that has a project.";
      this.#requestRender();
      return;
    }
    try {
      await this.#client.request("agent.spawn", {
        parentAgentId: parent.id,
        task: { title, objective },
        profileId,
        model: { provider, modelId, thinkingLevel },
        lifecycleClass,
        keepForReuse: lifecycleClass === "reusable",
        project: { cwd: parent.cwd },
        isolation: {
          mode: ["scout", "reviewer"].includes(profileId)
            ? "shared-readonly"
            : "worktree",
        },
        budget: { wallTimeMs: 1_800_000 },
        wait: false,
      });
      this.#message = `Creation accepted with explicit ${provider}/${modelId} and ${thinkingLevel} thinking.`;
      await this.#client.refresh();
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private confirmTaskCancel(): void {
    const task = this.selectedTask(
      this.scopedWorkState(this.#client.store.state),
    );
    if (!task) {
      this.#message = "Select a task first.";
      return;
    }
    const key = `task-cancel:${task.id}`;
    if (this.#closeConfirmation === key) void this.run("cancelTask");
    else {
      this.#closeConfirmation = key;
      this.#message = `Press Cancel task again to cancel ${task.title}.`;
    }
  }

  private async copySelectedId(): Promise<void> {
    try {
      await this.run("copyId");
    } catch {
      /* run reports the visible failure */
    }
  }

  private confirmGroup(action: "groupStop" | "groupClose"): void {
    const group = this.selectedGroup();
    if (!group) {
      this.#message = "Select a group first.";
      return;
    }
    const key = `${action}:${group.id}`;
    if (this.#closeConfirmation === key) void this.run(action);
    else {
      this.#closeConfirmation = key;
      this.#message = `Press the button again to ${action === "groupStop" ? "stop" : "close"} ${group.name ?? group.id}.`;
    }
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
