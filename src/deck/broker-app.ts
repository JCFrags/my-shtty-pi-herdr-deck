import type { Component, TuiMouseEvent } from "@pi-herdr-deck/tui";
import { BrokerClient, type BrokerStatus } from "./broker-client.js";
import { DeckActions, type DeckAction } from "./actions.js";
import {
  currentBlockingQuestions,
  currentProviderProjection,
  getAgentModelChoices,
  getAgentThinkingChoices,
  renderAgentInspector,
  renderAgents,
  renderGroupDetail,
  renderNotifications,
  renderResultDetail,
  renderTaskDetail,
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
import type { DeckGroup, DeckQuestion } from "./types.js";
import type { AgentBoardPendingQuestion } from "../shared/provider-projections.js";
import {
  visibleSurfaceSignature,
  type VisibleWorkView,
} from "./render-dependencies.js";
import {
  selectActivityPresentation,
  selectUnifiedBoardPresentation,
  type ActivityItem,
  type AgentBoardTab,
  type BoardItem,
} from "./product-presentation.js";
import {
  selectAdoptedRootAgent,
  selectAdoptedScope,
  selectFilesPresentationAuthority,
} from "./scope.js";
import {
  effectiveSelection,
  moveAgentListSelection,
  selectAgentListPresentation,
} from "./selections.js";
import { selectBoardPresentation } from "./board-presentation.js";

export interface BrokerDeckAppOptions {
  client: BrokerClient;
  requestRender(): void;
  getHeight(): number;
  targetPaneId?: string;
  onClose?(): void;
  onRenderDecision?(decision: {
    rendered: boolean;
    tab: AgentBoardTab;
    workView: VisibleWorkView;
  }): void;
  onActionTarget?(
    action: DeckAction,
    target: import("./actions.js").ActionTarget,
  ): void;
}

type DeckTab = AgentBoardTab;
type WorkView = VisibleWorkView;
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

const NAV_TABS: readonly DeckTab[] = ["board", "files", "agents", "activity"];

export class BrokerDeckApp implements Component {
  readonly #client: BrokerClient;
  readonly #actions: DeckActions;
  readonly #requestRender: () => void;
  readonly #getHeight: () => number;
  readonly #targetPaneId: string | undefined;
  readonly #onClose: () => void;
  readonly #onRenderDecision: BrokerDeckAppOptions["onRenderDecision"];
  readonly #onActionTarget: BrokerDeckAppOptions["onActionTarget"];
  readonly #unsubscribers: Array<() => void> = [];
  readonly #tracker = new PressReleaseTracker();
  #status: BrokerStatus;
  #tab: DeckTab = "board";
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
  #filesPreviewScroll = 0;
  #filesTreeRegion: { start: number; end: number } | undefined;
  #filesPreviewRegion: { start: number; end: number } | undefined;
  #filesPreviewPath: string | undefined;
  #boardTab: "inbox" | "updates" | "decisions" | "history" = "inbox";
  #boardSelection: string | undefined;
  #unifiedBoardSelection: string | undefined;
  #activitySelection: string | undefined;
  #activityScroll = 0;
  #settingsOpen = false;
  #helpOpen = false;
  #renderSignature = "";

  constructor(options: BrokerDeckAppOptions) {
    this.#client = options.client;
    this.#actions = new DeckActions(options.client);
    this.#requestRender = options.requestRender;
    this.#getHeight = options.getHeight;
    this.#targetPaneId = options.targetPaneId;
    this.#onClose = options.onClose ?? (() => undefined);
    this.#onRenderDecision = options.onRenderDecision;
    this.#onActionTarget = options.onActionTarget;
    this.#status = options.client.status;
    this.#renderSignature = this.visibleSignature(options.client.store.state);
    this.#unsubscribers.push(
      options.client.onStatus((status) => {
        this.#status = status;
        this.#requestRender();
      }),
      options.client.store.onChange((state) => {
        const projection = currentProviderProjection(state, this.#targetPaneId);
        const previousMessage = this.#message;
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
        const signature = this.visibleSignature(state);
        const rendered =
          signature !== this.#renderSignature ||
          previousMessage !== this.#message;
        this.#onRenderDecision?.({
          rendered,
          tab: this.#tab,
          workView: this.#workView,
        });
        if (!rendered) return;
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
      `AGENT BOARD  ${this.#status === "connected" ? "● ONLINE" : "○ OFFLINE"}`,
    ];
    const tabNames: Record<DeckTab, string> = {
      board: "Board",
      files: "Files",
      agents: "Agents",
      activity: "Activity",
    };
    this.addControlRow(
      lines,
      [
        ...NAV_TABS.map((tab, index) => ({
          id: `tab:${tab}`,
          label: `${this.#tab === tab ? tabNames[tab].toUpperCase() : tabNames[tab]} ${index + 1}`,
          activate: () => this.selectTab(tab),
        })),
        {
          id: "header:settings",
          label: "Settings ,",
          activate: () => this.toggleSettings(),
        },
        {
          id: "header:help",
          label: "Help ?",
          activate: () => this.toggleHelp(),
        },
      ],
      safeWidth,
    );
    lines.push(
      "────────────────────────────────────────────────────────────────────────────────",
      "↑↓ move  •  click controls  •  r refresh  •  , settings  •  ? help  •  q close",
      ...(this.#message ? [`◆ ${this.#message}`] : []),
      "",
    );

    if (this.#settingsOpen) this.renderSettingsSurface(lines, safeWidth);
    else if (this.#helpOpen) this.renderHelpSurface(lines);
    else if (this.#tab === "board")
      this.renderUnifiedBoard(lines, safeWidth, state);
    else if (this.#tab === "files")
      this.renderFilesProvider(lines, safeWidth, state);
    else if (this.#tab === "agents")
      this.renderAgentsSurface(lines, safeWidth, state);
    else this.renderActivitySurface(lines, safeWidth, state);

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
    if (this.#tab === "board" && this.#client.store.notifications.length > 0)
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
      if (data >= "1" && data <= "4") {
        this.selectTab(NAV_TABS[Number(data) - 1]!);
        return;
      }
      this.handleEditorInput(data);
      this.#requestRender();
      return;
    }
    if (data === "\u001b" && (this.#settingsOpen || this.#helpOpen)) {
      this.#settingsOpen = false;
      this.#helpOpen = false;
    } else if (data === "q" || data === "\u0003" || data === "\u001b") {
      this.#onClose();
      return;
    } else if (data >= "1" && data <= "4")
      this.selectTab(NAV_TABS[Number(data) - 1]!);
    else if (data === ",") this.toggleSettings();
    else if (data === "?") this.toggleHelp();
    else if (this.#settingsOpen && data === "/")
      this.beginInput("model-filter");
    else if (this.#settingsOpen && data === "d") this.beginInput("default");
    else if (this.#settingsOpen && data === "o") void this.toggleAutoClose();
    else if (data === "r") void this.run("refresh");
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
    else if (data === "f" && this.#tab === "agents") void this.run("focus");
    else if (data === "p" && this.#tab === "agents") this.beginInput("prompt");
    else if (data === "a" && this.#tab === "agents") this.beginInput("ask");
    else if (data === "a" && this.#tab === "board")
      this.beginInput(this.selectedBoardQuestion() ? "board-answer" : "answer");
    else if (data === "y" && this.#tab === "board")
      void this.runBoard("accept-recommendation");
    else if (data === "i" && this.#tab === "agents") void this.run("interrupt");
    else if (data === "s" && this.#tab === "agents") void this.run("stop");
    else if (data === "x" && this.#tab === "agents") this.confirmClose();
    else if (data === "m" && this.#tab === "agents") this.cycleModel();
    else if (data === "t" && this.#tab === "agents") this.cycleThinking();
    else if (data === "\u001b[A" || data === "k") this.move(-1);
    else if (data === "\u001b[B" || data === "j") this.move(1);
    this.syncVisibleSignature();
    this.#requestRender();
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (event.type === "wheel") {
      const delta = event.direction === "down" ? 1 : -1;
      if (
        this.#tab === "files" &&
        this.#filesPreviewRegion &&
        event.y >= this.#filesPreviewRegion.start &&
        event.y <= this.#filesPreviewRegion.end
      )
        this.#filesPreviewScroll = Math.max(
          0,
          this.#filesPreviewScroll + delta,
        );
      else if (this.#tab === "files" && this.#filesTreeRegion)
        this.#filesScroll = Math.max(0, this.#filesScroll + delta);
      else this.move(delta);
      this.syncVisibleSignature();
      this.#requestRender();
      return true;
    }
    const handled = this.#tracker.handle(event, this.#hitBoxes);
    if (handled) {
      this.syncVisibleSignature();
      this.#requestRender();
    }
    return handled;
  }

  invalidate(): void {
    this.#requestRender();
  }

  private visibleSignature(state = this.#client.store.state): string {
    return visibleSurfaceSignature(state, {
      tab: this.#tab,
      workView: this.#workView,
      ...(this.#targetPaneId ? { targetPaneId: this.#targetPaneId } : {}),
      ...(this.#selectedTask ? { selectedTaskId: this.#selectedTask } : {}),
      ...(this.#selectedResult
        ? { selectedResultId: this.#selectedResult }
        : {}),
      ...(this.#selectedGroup ? { selectedGroupId: this.#selectedGroup } : {}),
      ...(this.#selectedAgent ? { selectedAgentId: this.#selectedAgent } : {}),
      agentFilter: this.#agentFilter,
      agentPage: this.#agentPage,
      boardTab: this.#boardTab,
      ...(this.#tab === "activity" && this.#activitySelection
        ? { boardSelectionId: this.#activitySelection }
        : this.#unifiedBoardSelection
          ? { boardSelectionId: this.#unifiedBoardSelection }
          : {}),
      notifications: this.#client.store.notifications,
    });
  }

  private syncVisibleSignature(): void {
    this.#renderSignature = this.visibleSignature();
  }

  private selectTab(tab: DeckTab): void {
    this.#inputMode = undefined;
    this.#input = "";
    this.#settingsOpen = false;
    this.#helpOpen = false;
    this.#tab = tab;
    this.#closeConfirmation = undefined;
    this.#tracker.reset();
    this.syncVisibleSignature();
    this.#requestRender();
  }

  private toggleSettings(): void {
    this.#settingsOpen = !this.#settingsOpen;
    this.#helpOpen = false;
    this.#settingsScroll = 0;
    if (this.#settingsOpen) void this.loadSettings();
    this.syncVisibleSignature();
    this.#requestRender();
  }

  private toggleHelp(): void {
    this.#helpOpen = !this.#helpOpen;
    this.#settingsOpen = false;
    this.#requestRender();
  }

  private renderSettingsSurface(lines: string[], width: number): void {
    lines.push("SETTINGS  Escape or , closes", "");
    this.addControlRow(
      lines,
      [
        {
          id: "settings:default",
          label: "Set model default",
          activate: () => this.beginInput("default"),
        },
        {
          id: "settings:auto-close",
          label: "Toggle auto-close",
          activate: () => void this.toggleAutoClose(),
        },
        {
          id: "settings:close",
          label: "Close",
          activate: () => this.toggleSettings(),
        },
      ],
      width,
    );
    lines.push("", ...this.renderSettings(width));
  }

  private renderHelpSurface(lines: string[]): void {
    lines.push(
      "HELP  Escape or ? closes",
      "1 Board  2 Files  3 Agents  4 Activity",
      "Board combines current work, questions, Signals updates, and recommendations.",
      "Files: row previews; caret expands; checkbox selects; each pane scrolls independently.",
      "Agents: f focus, p prompt, a ask, i interrupt, s stop, x close.",
      "Activity contains results, decisions, updates, groups, tasks, and lifecycle history.",
    );
  }

  private selectBoardItem(item: BoardItem): void {
    this.#unifiedBoardSelection = item.id;
    if (item.kind === "todo") this.#selectedProviderTodo = item.source.id;
    else if (item.kind === "task") this.#selectedTask = item.source.id;
    else if (item.kind === "group") this.#selectedGroup = item.source.id;
    else if (item.kind === "broker-question")
      this.#selectedQuestion = item.source.id;
    else {
      const separator = item.id.indexOf(":");
      this.#boardSelection = item.id.slice(separator + 1);
      this.#boardTab =
        item.kind === "signal-question"
          ? "inbox"
          : item.kind === "signal-update"
            ? "updates"
            : "decisions";
    }
  }

  private renderUnifiedBoard(
    lines: string[],
    width: number,
    state: DeckState,
  ): void {
    const model = selectUnifiedBoardPresentation(
      state,
      this.#targetPaneId,
      this.#unifiedBoardSelection,
    );
    lines.push(
      `BOARD  ${model.counts.work} current · ${model.counts.attention} need attention`,
      "CURRENT WORK  Pi Todo and orchestrator work",
    );
    this.renderBoardItems(lines, width, model.work);
    lines.push("", "ATTENTION  Broker questions and SIGNALS");
    this.renderBoardItems(lines, width, model.attention);
    const selected = model.selected;
    if (!selected) return;
    this.selectBoardItem(selected);
    lines.push(
      "",
      `DETAIL  ${selected.kind.toUpperCase()} · ${selected.status}`,
      selected.title,
    );
    if (selected.kind === "task")
      lines.push(
        ...renderTaskDetail(
          selected.source,
          this.scopedWorkState(state),
          width,
        ),
      );
    else if (selected.kind === "group")
      lines.push(...renderGroupDetail(selected.source, width));
    else if (selected.kind === "broker-question")
      lines.push(`Question ${selected.source.id}: ${selected.source.prompt}`);
    else if (selected.kind.startsWith("signal-")) {
      const projection = currentProviderProjection(
        state,
        this.#targetPaneId,
      )?.agentBoard;
      const tab =
        selected.kind === "signal-question"
          ? "inbox"
          : selected.kind === "signal-update"
            ? "updates"
            : "decisions";
      const presentation = selectBoardPresentation(
        projection,
        tab,
        this.#boardSelection,
      );
      if (Object.keys(presentation.detail).length > 0)
        lines.push(...this.renderBoardDetail(presentation.detail, width));
    }
    this.addControlRow(
      lines,
      [
        {
          id: "board:start",
          label: "Start",
          disabled: selected.kind !== "todo",
          activate: () => void this.runProvider("todoStart", "todo-start"),
        },
        {
          id: "board:done",
          label: "Mark done",
          disabled: selected.kind !== "todo",
          activate: () => void this.runProvider("todoDone", "todo-done"),
        },
        {
          id: "board:answer",
          label: "Answer",
          disabled: !["broker-question", "signal-question"].includes(
            selected.kind,
          ),
          activate: () =>
            this.beginInput(
              selected.kind === "signal-question" ? "board-answer" : "answer",
            ),
        },
        {
          id: "board:recommendation",
          label: "Use recommendation",
          disabled: selected.kind !== "signal-recommendation",
          activate: () => void this.runBoard("accept-recommendation"),
        },
        {
          id: "board:cancel",
          label: "Cancel task",
          disabled: selected.kind !== "task",
          activate: () => this.confirmTaskCancel(),
        },
        {
          id: "board:wait",
          label: "Wait group",
          disabled: selected.kind !== "group",
          activate: () => void this.run("groupWait"),
        },
        {
          id: "board:stop",
          label: "Stop group",
          disabled: selected.kind !== "group",
          activate: () => this.confirmGroup("groupStop"),
        },
        {
          id: "board:close",
          label: "Close group",
          disabled: selected.kind !== "group",
          activate: () => this.confirmGroup("groupClose"),
        },
      ],
      width,
    );
  }

  private renderBoardItems(
    lines: string[],
    width: number,
    items: BoardItem[],
  ): void {
    if (items.length === 0) lines.push("  ✓ Clear");
    for (const item of items) {
      const y = lines.length;
      const selected = item.id === this.#unifiedBoardSelection;
      lines.push(`${selected ? ">" : " "} [${item.status}] ${item.title}`);
      this.addHitBox(`board:item:${item.id}`, y, width, () =>
        this.selectBoardItem(item),
      );
    }
  }

  private renderAgentsSurface(
    lines: string[],
    width: number,
    state: DeckState,
  ): void {
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
      width,
    );
    const scoped = this.scopedWorkState(state);
    const visible = this.visibleAgents(scoped);
    const start = lines.length;
    lines.push(
      ...renderAgents(
        scoped,
        width,
        agent?.id,
        this.#agentFilter,
        this.#agentPage,
      ),
      "",
    );
    this.addEntityHitBoxes(
      lines,
      start,
      visible,
      (item) => item.displayName ?? item.herdrName ?? item.id,
      (id) => {
        this.#selectedAgent = id;
      },
    );
    lines.push(...renderAgentInspector(agent, state, width), "");
    this.addControlRow(
      lines,
      [
        {
          id: "agent:focus",
          label: "Focus",
          disabled: !agent?.paneId,
          activate: () => void this.run("focus"),
        },
        {
          id: "agent:prompt",
          label: "Prompt",
          disabled: !agent,
          activate: () => this.beginInput("prompt"),
        },
        {
          id: "agent:ask",
          label: "Ask",
          disabled: !agent,
          activate: () => this.beginInput("ask"),
        },
        {
          id: "agent:interrupt",
          label: "Interrupt",
          disabled: agent?.state !== "working",
          activate: () => void this.run("interrupt"),
        },
        {
          id: "agent:stop",
          label: "Stop",
          disabled: !agent,
          activate: () => void this.run("stop"),
        },
        {
          id: "agent:close",
          label: "Close",
          disabled: !agent,
          activate: () => this.confirmClose(),
        },
        {
          id: "agent:create",
          label: "Create",
          disabled: !agent?.cwd,
          activate: () => this.beginInput("create"),
        },
      ],
      width,
    );
    this.addControlRow(
      lines,
      [
        {
          id: "agent:steer",
          label: "Steer",
          disabled: !agent,
          activate: () => this.beginInput("steer"),
        },
        {
          id: "agent:follow",
          label: "Follow-up",
          disabled: !agent,
          activate: () => this.beginInput("followUp"),
        },
        {
          id: "agent:compact",
          label: "Compact",
          disabled: agent?.state !== "idle",
          activate: () => void this.run("compact"),
        },
        {
          id: "agent:restart",
          label: "Restart",
          disabled: !agent || ["closed", "stopped"].includes(agent.state),
          activate: () => void this.run("restart"),
        },
        {
          id: "agent:worktree",
          label: "Worktree",
          disabled: !agent?.cwd,
          activate: () => void this.run("openWorktree"),
        },
        {
          id: "agent:copy",
          label: "Copy ID",
          disabled: !agent,
          activate: () => void this.copySelectedId(),
        },
        {
          id: "agent:model",
          label: "Model",
          disabled: getAgentModelChoices(agent).length === 0,
          activate: () => this.cycleModel(),
        },
        {
          id: "agent:thinking",
          label: "Thinking",
          disabled: getAgentThinkingChoices(agent).length === 0,
          activate: () => this.cycleThinking(),
        },
      ],
      width,
    );
  }

  private selectActivityItem(item: ActivityItem): void {
    this.#activitySelection = item.id;
    if (item.kind === "result") this.#selectedResult = item.source.id;
    else if (item.kind === "task") this.#selectedTask = item.source.id;
    else if (item.kind === "group") this.#selectedGroup = item.source.id;
    else if (item.kind === "agent") this.#selectedAgent = item.source.id;
  }

  private renderActivitySurface(
    lines: string[],
    width: number,
    state: DeckState,
  ): void {
    const model = selectActivityPresentation(
      state,
      this.#targetPaneId,
      this.#activitySelection,
    );
    lines.push(
      "ACTIVITY  Results · decisions · updates · groups · lifecycle",
      `${model.items.length} retained events`,
    );
    if (model.items.length === 0)
      lines.push("✓ No historical activity is available.");
    const rowBudget = Math.max(4, this.#getHeight() - lines.length - 8);
    const selectedIndex = model.selected
      ? model.items.findIndex((item) => item.id === model.selected?.id)
      : -1;
    if (selectedIndex >= 0) {
      if (selectedIndex < this.#activityScroll)
        this.#activityScroll = selectedIndex;
      if (selectedIndex >= this.#activityScroll + rowBudget)
        this.#activityScroll = selectedIndex - rowBudget + 1;
    }
    this.#activityScroll = Math.max(
      0,
      Math.min(
        this.#activityScroll,
        Math.max(0, model.items.length - rowBudget),
      ),
    );
    for (const item of model.items.slice(
      this.#activityScroll,
      this.#activityScroll + rowBudget,
    )) {
      const y = lines.length;
      lines.push(
        `${item.id === model.selected?.id ? ">" : " "} [${item.status}] ${item.title}`,
      );
      this.addHitBox(`activity:item:${item.id}`, y, width, () =>
        this.selectActivityItem(item),
      );
    }
    if (model.items.length > rowBudget)
      lines.push(
        `  ↕ ${this.#activityScroll + 1}-${Math.min(model.items.length, this.#activityScroll + rowBudget)} of ${model.items.length}`,
      );
    if (model.selected) {
      this.selectActivityItem(model.selected);
      lines.push(
        "",
        `DETAIL  ${model.selected.kind.toUpperCase()} · ${model.selected.status}`,
        model.selected.title,
      );
      if (model.selected.kind === "result")
        lines.push(...renderResultDetail(model.selected.source, width));
      else if (model.selected.kind === "task")
        lines.push(
          ...renderTaskDetail(
            model.selected.source,
            this.scopedWorkState(state),
            width,
          ),
        );
      else if (model.selected.kind === "group")
        lines.push(...renderGroupDetail(model.selected.source, width));
    }
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
    return selectAdoptedRootAgent(this.#client.store.state, this.#targetPaneId);
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
    const filesAuthority = selectFilesPresentationAuthority(
      state,
      this.#targetPaneId,
    );
    const files = filesAuthority.provider?.files;
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
    const treeStart = lines.length;
    for (const row of visible.slice(
      this.#filesScroll,
      this.#filesScroll + rowBudget,
    )) {
      const path = String(row.path ?? "");
      const selected = row.selected === true;
      const marker = selected ? "x" : row.partiallySelected ? "−" : " ";
      const folder = row.kind === "directory" || row.kind === "root";
      const caret = folder ? (row.expanded ? "▾" : "▸") : "·";
      const cursor = path === this.#filesPath ? ">" : " ";
      const indent = "  ".repeat(Math.max(0, Number(row.depth ?? 0)));
      const prefix = `${cursor} ${indent}${caret} [${marker}] `;
      const y = lines.length;
      lines.push(
        `${prefix}${String(row.name ?? path)}${row.error ? `  ! ${String(row.error)}` : ""}`,
      );
      const caretX = 2 + indent.length;
      const checkX = caretX + 2;
      if (folder)
        this.addHitBox(
          `files:caret:${path}`,
          y,
          1,
          () => {
            this.#filesPath = path;
            void this.runFiles("expand", path);
          },
          false,
          caretX,
        );
      this.addHitBox(
        `files:check:${path}`,
        y,
        3,
        () => {
          this.#filesPath = path;
          void this.runFiles("toggle-selection", path);
        },
        false,
        checkX,
      );
      this.addHitBox(
        `files:row:${path}`,
        y,
        Math.max(1, width - prefix.length),
        () => {
          this.#filesPath = path;
          if (!folder) {
            this.#filesPreviewScroll = 0;
            void this.runFiles("preview", path);
          }
        },
        false,
        prefix.length,
      );
    }
    this.#filesTreeRegion = {
      start: treeStart,
      end: Math.max(treeStart, lines.length - 1),
    };
    if (visible.length > rowBudget)
      lines.push(
        `  ↕ ${this.#filesScroll + 1}-${Math.min(visible.length, this.#filesScroll + rowBudget)} of ${visible.length} · scroll or ↑↓ to move`,
      );
    const preview = this.providerRecord(view.preview);
    this.#filesPreviewRegion = undefined;
    if (Object.keys(preview).length) {
      lines.push(
        "",
        `PREVIEW  ${String(this.#filesPreviewPath ?? this.#filesPath)}`,
      );
      const previewStart = lines.length;
      const previewLines = Array.isArray(preview.lines) ? preview.lines : [];
      this.#filesPreviewScroll = Math.max(
        0,
        Math.min(
          this.#filesPreviewScroll,
          Math.max(0, previewLines.length - 8),
        ),
      );
      for (const line of previewLines.slice(
        this.#filesPreviewScroll,
        this.#filesPreviewScroll + 8,
      ))
        lines.push(`│ ${String(line)}`);
      if (previewLines.length > 8)
        lines.push(
          `  ↕ preview ${this.#filesPreviewScroll + 1}-${Math.min(previewLines.length, this.#filesPreviewScroll + 8)} of ${previewLines.length}`,
        );
      if (preview.error) lines.push(`! ${String(preview.error)}`);
      this.#filesPreviewRegion = {
        start: previewStart,
        end: Math.max(previewStart, lines.length - 1),
      };
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
          disabled: !filesAuthority.canOpenStandalone,
          activate: () => void this.runProvider("filesOpen", "files-open"),
        },
      ],
      width,
    );
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
    if (action === "accept-recommendation" && this.#boardTab !== "decisions")
      return;
    const agent = this.adoptedRootAgent();
    const projection = currentProviderProjection(
      this.#client.store.state,
      this.#targetPaneId,
    )?.agentBoard;
    const presentation = selectBoardPresentation(
      projection,
      this.#boardTab,
      this.#boardSelection,
    );
    if (!agent || !presentation.selectedId) return;
    const id = presentation.selectedId;
    const detail = presentation.detail;
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
        ? { updateId: id, expectedRevision: presentation.selectedRevision }
        : action === "acknowledge-answer"
          ? {
              answerId,
              outcome: "applied",
              summary: "Acknowledged from Agent Board.",
            }
          : action === "retry-delivery"
            ? {
                questionId,
                answerId,
                expectedRevision: presentation.selectedRevision,
              }
            : {
                questionId,
                expectedRevision: presentation.selectedRevision,
              };
    try {
      await this.#actions.run("boardAction", {
        agent,
        boardAction: { action, fields },
      } as never);
      this.#message = `Signals ${action} succeeded.`;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private scopedWorkState(state: DeckState): DeckState {
    return selectAdoptedScope(state, this.#targetPaneId).state;
  }

  private agentPresentation(state: DeckState = this.#client.store.state) {
    const scoped = this.scopedWorkState(state);
    return selectAgentListPresentation(
      scoped.agents.values(),
      this.#agentFilter,
      this.#agentPage,
      this.#selectedAgent,
    );
  }

  private visibleAgents(state: DeckState): Agent[] {
    return this.agentPresentation(state).visible;
  }

  private selectedAgent(): Agent | undefined {
    return this.agentPresentation().selected;
  }
  private selected<T extends { id: string }>(
    items: T[],
    id: string | undefined,
  ): T | undefined {
    return effectiveSelection(items, id);
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
  private selectedQuestion(): DeckQuestion | undefined {
    return this.selected(
      currentBlockingQuestions(this.#client.store.state, this.#targetPaneId),
      this.#selectedQuestion,
    );
  }

  private selectedBoardQuestion(): AgentBoardPendingQuestion | undefined {
    if (this.#boardTab !== "inbox") return undefined;
    const projection = currentProviderProjection(
      this.#client.store.state,
      this.#targetPaneId,
    )?.agentBoard;
    const questions = projection?.pendingQuestions ?? [];
    const presentation = selectBoardPresentation(
      projection,
      "inbox",
      this.#boardSelection,
    );
    if (presentation.pendingQuestion) return presentation.pendingQuestion;
    const detail = presentation.detail;
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
        (presentation.selectedId
          ? questions.find(
              (entry) => entry.questionId === presentation.selectedId,
            )
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

  private move(delta: number): void {
    const state = this.#client.store.state;
    if (this.#settingsOpen) {
      this.#settingsScroll = Math.max(
        0,
        Math.min(
          Math.max(0, (this.#capabilities?.models.length ?? 0) - 1),
          this.#settingsScroll + delta,
        ),
      );
    } else if (this.#tab === "agents") {
      const moved = moveAgentListSelection(
        this.agentPresentation(state),
        delta,
      );
      this.#selectedAgent = moved.selectedId;
      this.#agentPage = moved.page;
    } else if (this.#tab === "board") {
      const model = selectUnifiedBoardPresentation(
        state,
        this.#targetPaneId,
        this.#unifiedBoardSelection,
      );
      const items = [...model.attention, ...model.work];
      if (items.length > 0) {
        const index = Math.max(
          0,
          items.findIndex((item) => item.id === model.selected?.id),
        );
        this.selectBoardItem(
          items[(index + delta + items.length) % items.length]!,
        );
      }
    } else if (this.#tab === "activity") {
      const model = selectActivityPresentation(
        state,
        this.#targetPaneId,
        this.#activitySelection,
      );
      if (model.items.length > 0) {
        const index = Math.max(
          0,
          model.items.findIndex((item) => item.id === model.selected?.id),
        );
        this.selectActivityItem(
          model.items[
            (index + delta + model.items.length) % model.items.length
          ]!,
        );
      }
    } else {
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
    }
    this.#closeConfirmation = undefined;
  }

  private target() {
    const agent =
      this.#tab === "board" || this.#tab === "files"
        ? this.adoptedRootAgent()
        : (this.selectedAgent() ?? this.adoptedRootAgent());
    const scoped = this.scopedWorkState(this.#client.store.state);
    const task =
      this.#tab === "board" ? this.selectedTask(scoped) : this.selectedTask();
    const question = this.selectedQuestion();
    const group =
      this.#tab === "board" ? this.selectedGroup(scoped) : this.selectedGroup();
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
      const target = this.target() as import("./actions.js").ActionTarget;
      this.#onActionTarget?.(action, target);
      const result = await this.#actions.run(action, target, value);
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
      this.#message = "Select a Signals question first.";
      return;
    }
    if (mode === "create" && !target.agent) {
      this.#message = "Select a parent agent first.";
      return;
    }
    const action: DeckAction =
      mode === "answer" ? "answer" : (mode as DeckAction);
    const denied =
      mode === "create" || mode === "default" || mode === "board-answer"
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
    const group = this.selectedGroup(
      this.scopedWorkState(this.#client.store.state),
    );
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
