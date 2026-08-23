import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "@pi-herdr-deck/tui";
import { BrokerClient, type BrokerStatus } from "./broker-client.js";
import { DeckActions, type DeckAction } from "./actions.js";
import {
  currentBlockingQuestions,
  currentProviderProjection,
  getAgentModelChoices,
  getAgentThinkingChoices,
  renderNotifications,
} from "./views.js";
import { type HitBox, PressReleaseTracker } from "./components/controls.js";
import type { Agent, Task } from "../state/types.js";
import type { DeckState } from "./types.js";
import { styleLines } from "./theme.js";
import type { PiCapabilitySnapshot } from "../pi/model-capabilities.js";
import type { ModelPolicyConfig } from "../broker/model-policy.js";
import type { DeckGroup, DeckQuestion } from "./types.js";
import type { AgentBoardPendingQuestion } from "../shared/provider-projections.js";
import {
  shellHeaderPresentation,
  visibleSurfaceSignature,
} from "./render-dependencies.js";
import {
  selectActivityPresentation,
  selectUnifiedBoardPresentation,
  type ActivityFilter,
  type ActivityItem,
  type AgentBoardTab,
  type BoardFilter,
  type BoardItem,
  normalizeBrokerQuestion,
  normalizeSignalsQuestion,
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
import {
  handleFilesKey,
  handleFilesMouse,
  normalizeFilesPresentation,
  renderFilesScreen,
  type FilesActionRequest,
  type FilesScreenOptions,
  type FilesScreenSurface,
} from "./files-screen.js";
import {
  agentMoreGuard,
  isAgentMoreGuardCurrent,
  renderAgents,
  type AgentActionContract,
  type AgentContractAction,
} from "./agents.js";
import {
  applyActivityWheel,
  handleActivityKey,
  renderActivity,
  type ActivityAction,
} from "./activity.js";
import { renderBoardScreen } from "./board-screen.js";
import {
  boundedOverlayText,
  noOverlay,
  questionResponseValid,
  toggleQuestionOption,
  applyQuestionRecommendation,
  type OverlayState,
  type TextInputPurpose,
} from "./overlay-screen.js";
import { renderSettingsScreen } from "./screens/settings-screen.js";
import { renderHelpScreen } from "./screens/help-screen.js";
import { renderAgentMoreScreen } from "./screens/agent-more-screen.js";
import { renderConfirmationScreen } from "./screens/confirmation-screen.js";
import { renderTextInputScreen } from "./screens/text-input-screen.js";
import { renderQuestionResponseScreen } from "./screens/question-response-screen.js";
import { renderHeader } from "./shell/header.js";
import type { RenderedSurface } from "./screen-types.js";

export interface BrokerDeckAppOptions {
  client: BrokerClient;
  requestRender(): void;
  getHeight(): number;
  targetPaneId?: string;
  onClose?(): void;
  onRenderDecision?(decision: { rendered: boolean; tab: AgentBoardTab }): void;
  onActionTarget?(
    action: DeckAction,
    target: import("./actions.js").ActionTarget,
  ): void;
}

type DeckTab = AgentBoardTab;

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
  #hitBoxes: HitBox[] = [];
  #selectedAgent: string | undefined;
  #selectedGroup: string | undefined;
  #selectedTask: string | undefined;
  #selectedProviderTodo: string | undefined;
  #selectedQuestion: string | undefined;
  #agentFilter: import("./views.js").AgentViewFilter = "active";
  #agentPage = 0;
  #modelFilter = "";
  #providerPending = new Set<string>();
  #message = "";
  #overlay: OverlayState = noOverlay();
  #capabilities: PiCapabilitySnapshot | undefined;
  #modelPolicy: ModelPolicyConfig | undefined;
  #autoCloseCompletedTemporary = false;
  #filesScreen: import("./screen-types.js").FilesScreenState = {
    activePane: "tree",
    treeScroll: 0,
    previewScroll: 0,
    focusTarget: "tree",
    wheelDetached: false,
  };
  #filesSurface: FilesScreenSurface | undefined;
  #filesOptions: FilesScreenOptions | undefined;
  #filesSurfaceOffset = 0;
  #boardTab: "inbox" | "updates" | "decisions" | "history" = "inbox";
  #boardSelection: string | undefined;
  #unifiedBoardSelection: string | undefined;
  #boardFilter: BoardFilter = "all-current";
  #boardScroll = 0;
  #boardWheelDetached = false;
  #activitySelection: string | undefined;
  #activityFilter: ActivityFilter = "all";
  #activityScroll = 0;
  #activityDetailScroll = 0;
  #activitySurface: import("./screen-types.js").RenderedSurface | undefined;
  #activitySurfaceOffset = 0;
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
        if (status === this.#status) return;
        this.#status = status;
        const signature = this.visibleSignature();
        if (signature === this.#renderSignature) return;
        this.#renderSignature = signature;
        this.#requestRender();
      }),
      options.client.store.onChange((state) => {
        if (
          this.#overlay.kind === "agent-more" &&
          !isAgentMoreGuardCurrent(state, this.#overlay.guard)
        )
          this.closeOverlay();
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
        this.#onRenderDecision?.({ rendered, tab: this.#tab });
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
    const overlay = this.#overlay;
    const header = renderHeader(
      safeWidth,
      shellHeaderPresentation(state, {
        tab: this.#tab,
        ...(this.#targetPaneId ? { targetPaneId: this.#targetPaneId } : {}),
        online: this.#status === "connected",
      }),
      overlay.kind === "none"
        ? {
            selectTab: (tab) => this.selectTab(tab),
            toggleSettings: () => this.toggleSettings(),
            toggleHelp: () => this.toggleHelp(),
          }
        : undefined,
    );
    this.#hitBoxes = [...header.hitBoxes];
    const lines = [
      ...header.lines,
      "────────────────────────────────────────────────────────────────────────────────",
      "↑↓ move  •  click controls  •  r refresh  •  , settings  •  ? help  •  q close",
      ...(this.#message ? [`◆ ${this.#message}`] : []),
      "",
    ];
    if (overlay.kind !== "none")
      this.appendSurface(lines, this.renderOverlay(overlay, safeWidth));
    else if (this.#tab === "board")
      this.renderUnifiedBoard(lines, safeWidth, state);
    else if (this.#tab === "files")
      this.renderFilesProvider(lines, safeWidth, state);
    else if (this.#tab === "agents")
      this.renderAgentsSurface(lines, safeWidth, state);
    else this.renderActivitySurface(lines, safeWidth, state);
    if (
      overlay.kind === "none" &&
      this.#tab === "board" &&
      this.#client.store.notifications.length > 0
    )
      lines.push(
        "",
        ...renderNotifications(
          this.#client.store.notifications.slice(0, 4),
          safeWidth,
        ),
      );
    const height = Math.max(1, this.#getHeight());
    while (lines.length < height) lines.push("");
    return styleLines(
      lines
        .slice(0, height)
        .map((line) =>
          visibleWidth(line) <= safeWidth
            ? line
            : `${truncateToWidth(line, Math.max(0, safeWidth - 1))}…`,
        ),
    );
  }

  handleInput(data: string): void {
    if (this.#overlay.kind !== "none") {
      this.handleOverlayInput(data);
      this.syncVisibleSignature();
      this.#requestRender();
      return;
    }
    if (data === "q" || data === "\u0003" || data === "\u001b") {
      this.#onClose();
      return;
    } else if (data >= "1" && data <= "4")
      this.selectTab(NAV_TABS[Number(data) - 1]!);
    else if (data === ",") this.toggleSettings();
    else if (data === "?") this.toggleHelp();
    else if (data === "r") void this.run("refresh");
    else if (data === "v" && this.#tab === "board") this.cycleBoardFilter();
    else if (data === "v" && this.#tab === "activity")
      this.cycleActivityFilter();
    else if (data === "n" && this.#tab === "agents") this.beginInput("create");
    else if (data === "/" && this.#tab === "files")
      this.beginInput("files-filter");
    else if (this.#tab === "files") {
      const key =
        data === "\u001b[A"
          ? "ArrowUp"
          : data === "\u001b[B"
            ? "ArrowDown"
            : data === "\r" || data === "\n"
              ? "Enter"
              : data;
      if (!handleFilesKey(this.filesScreenOptions(), key) && data === "/")
        this.beginInput("files-filter");
    } else if (data === "f" && this.#tab === "agents") void this.run("focus");
    else if (data === "p" && this.#tab === "agents") this.beginInput("prompt");
    else if (data === "a" && this.#tab === "agents") this.beginInput("ask");
    else if (data === "a" && this.#tab === "board")
      this.beginQuestionResponse(
        this.selectedBoardQuestion() ? "board-answer" : "answer",
      );
    else if (data === "y" && this.#tab === "board")
      void this.runBoard("accept-recommendation");
    else if (data === "i" && this.#tab === "agents") void this.run("interrupt");
    else if (data === "s" && this.#tab === "agents") this.confirmAgentStop();
    else if (data === "x" && this.#tab === "agents") this.confirmClose();
    else if (data === "m" && this.#tab === "agents") this.openAgentMore();
    else if (data === "t" && this.#tab === "agents") this.cycleThinking();
    else if (
      this.#tab === "activity" &&
      (data === "\u001b[A" ||
        data === "\u001b[B" ||
        data === "k" ||
        data === "j")
    )
      this.handleActivityKey(
        data === "\u001b[A"
          ? "ArrowUp"
          : data === "\u001b[B"
            ? "ArrowDown"
            : data,
      );
    else if (data === "\u001b[A" || data === "k") this.move(-1);
    else if (data === "\u001b[B" || data === "j") this.move(1);
    this.syncVisibleSignature();
    this.#requestRender();
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (this.#overlay.kind !== "none") {
      if (event.type === "wheel") {
        this.#overlay = {
          ...this.#overlay,
          scroll: Math.max(
            0,
            (this.#overlay.scroll ?? 0) + (event.direction === "down" ? 1 : -1),
          ),
        };
        this.#requestRender();
        return true;
      }
      const handled = this.#tracker.handle(event, this.#hitBoxes);
      if (
        !handled &&
        event.type === "release" &&
        ["settings", "help", "agent-more"].includes(this.#overlay.kind)
      )
        this.closeOverlay();
      if (handled) this.#requestRender();
      return true;
    }
    if (this.#tab === "files" && this.#filesSurface) {
      const localEvent =
        event.type === "wheel"
          ? { ...event, y: event.y - this.#filesSurfaceOffset }
          : { ...event, y: event.y - this.#filesSurfaceOffset };
      const handled = handleFilesMouse(
        this.#filesOptions ?? this.filesScreenOptions(),
        this.#filesSurface,
        localEvent,
      );
      if (handled) {
        this.syncVisibleSignature();
        this.#requestRender();
      }
      return handled;
    }
    if (event.type === "wheel") {
      const delta = event.direction === "down" ? 1 : -1;
      if (this.#tab === "board") {
        this.#boardWheelDetached = true;
        this.#boardScroll = Math.max(0, this.#boardScroll + delta);
      } else if (this.#tab === "activity") {
        const region = this.activityWheelRegion(event.x, event.y);
        const result = applyActivityWheel(
          this.activityScreenState(),
          region,
          event.direction === "down" ? "down" : "up",
        );
        this.#activityScroll = result.state.listScroll;
        this.#activityDetailScroll = result.state.detailScroll;
        if (result.handled) {
          this.syncVisibleSignature();
          this.#requestRender();
        }
        return result.handled;
      } else this.move(delta);
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
    const overlay = this.#overlay;
    return visibleSurfaceSignature(state, {
      tab: this.#tab,
      ...(this.#targetPaneId ? { targetPaneId: this.#targetPaneId } : {}),
      ...(this.#selectedAgent ? { selectedAgentId: this.#selectedAgent } : {}),
      agentFilter: this.#agentFilter,
      agentPage: this.#agentPage,
      online: this.#status === "connected",
      boardFilter: this.#boardFilter,
      activityFilter: this.#activityFilter,
      ...(this.#tab === "activity" && this.#activitySelection
        ? { boardSelectionId: this.#activitySelection }
        : this.#unifiedBoardSelection
          ? { boardSelectionId: this.#unifiedBoardSelection }
          : {}),
      notifications: this.#client.store.notifications,
      ...(overlay.kind !== "none"
        ? { overlay: overlay.kind, overlayGuard: overlay }
        : {}),
    });
  }

  private syncVisibleSignature(): void {
    this.#renderSignature = this.visibleSignature();
  }

  private selectTab(tab: DeckTab): void {
    this.#tab = tab;
    this.closeOverlay();
    this.#tracker.reset();
    this.syncVisibleSignature();
  }

  private toggleSettings(): void {
    if (this.#overlay.kind === "settings") this.closeOverlay();
    else {
      this.#overlay = {
        kind: "settings",
        focus: "primary",
        scroll: 0,
        pending: false,
      };
      void this.loadSettings();
    }
    this.syncVisibleSignature();
    this.#requestRender();
  }

  private toggleHelp(): void {
    if (this.#overlay.kind === "help") this.closeOverlay();
    else
      this.#overlay = {
        kind: "help",
        focus: "close",
        scroll: 0,
        pending: false,
      };
    this.syncVisibleSignature();
    this.#requestRender();
  }

  private closeOverlay(): void {
    this.#overlay = noOverlay();
    this.#tracker.reset();
  }

  private appendSurface(lines: string[], surface: RenderedSurface): void {
    const yOffset = lines.length;
    lines.push(...surface.lines);
    for (const box of surface.hitBoxes)
      this.#hitBoxes.push({ ...box, y: box.y + yOffset });
  }

  private renderOverlay(
    overlay: Exclude<OverlayState, { kind: "none" }>,
    width: number,
  ): RenderedSurface {
    switch (overlay.kind) {
      case "settings":
        return renderSettingsScreen({
          width,
          scroll: overlay.scroll ?? 0,
          content: this.renderSettings(width),
          onDefault: () => this.beginInput("default"),
          onAutoClose: () => void this.toggleAutoClose(),
          onClose: () => this.closeOverlay(),
        });
      case "help":
        return renderHelpScreen(width, () => this.closeOverlay());
      case "agent-more":
        return renderAgentMoreScreen({
          width,
          agent: this.selectedAgent(),
          onCompact: () => void this.run("compact"),
          onRestart: () => void this.run("restart"),
          onCloseAgent: () => this.confirmClose(),
          onWorktree: () => void this.run("openWorktree"),
          onCopy: () => void this.copySelectedId(),
          onModel: () => this.cycleModel(),
          onThinking: () => this.cycleThinking(),
          onCreate: () => this.beginInput("create"),
          onClose: () => this.closeOverlay(),
        });
      case "confirm":
        return renderConfirmationScreen(
          width,
          overlay,
          () => this.closeOverlay(),
          () => void this.submitConfirmation(),
        );
      case "text-input":
        return renderTextInputScreen({
          width,
          state: overlay,
          onCancel: () => this.closeOverlay(),
          onSubmit: () => void this.submitTextInput(),
        });
      case "question-response":
        return renderQuestionResponseScreen({
          width,
          state: overlay,
          onToggle: (id) => {
            this.#overlay = toggleQuestionOption(overlay, id);
          },
          onRecommendation: () => {
            this.#overlay = applyQuestionRecommendation(overlay);
          },
          onSubmit: () => void this.submitQuestionResponse(),
          onCancel: () => this.closeOverlay(),
        });
    }
  }

  private handleOverlayInput(data: string): void {
    const overlay = this.#overlay;
    if (data === "\u001b") {
      if (
        overlay.kind === "text-input" &&
        (overlay.purpose === "default" || overlay.purpose === "model-filter")
      )
        this.#overlay = {
          kind: "settings",
          focus: "primary",
          scroll: 0,
          pending: false,
        };
      else this.closeOverlay();
      return;
    }
    if (overlay.kind === "settings") {
      if (data === ",") this.closeOverlay();
      else if (data === "/") this.beginInput("model-filter");
      else if (data === "d") this.beginInput("default");
      else if (data === "o") void this.toggleAutoClose();
      else if (
        data === "\u001b[A" ||
        data === "k" ||
        data === "\u001b[B" ||
        data === "j"
      )
        this.scrollOverlay(data === "\u001b[A" || data === "k" ? -1 : 1);
      return;
    }
    if (overlay.kind === "help") {
      if (data === "?") this.closeOverlay();
      return;
    }
    if (overlay.kind === "confirm") {
      if (data === "n") this.closeOverlay();
      else if (data === "y" || data === "\r" || data === "\n")
        void this.submitConfirmation();
      return;
    }
    if (overlay.kind === "agent-more") {
      if (data === "m") this.closeOverlay();
      else if (data === "c") void this.run("compact");
      else if (data === "r") void this.run("restart");
      else if (data === "x") this.confirmClose();
      else if (data === "t") this.cycleThinking();
      else if (data === "k") this.cycleModel();
      return;
    }
    if (overlay.kind === "text-input") {
      this.handleTextInput(data);
      return;
    }
    if (overlay.kind === "question-response") {
      if (data === "y") this.#overlay = applyQuestionRecommendation(overlay);
      else if (data >= "1" && data <= "9") {
        const option = overlay.question.options[Number(data) - 1];
        if (option) this.#overlay = toggleQuestionOption(overlay, option.id);
      } else if (data === "\r" || data === "\n")
        void this.submitQuestionResponse();
      else if (
        (data === "\u007f" || data === "\b") &&
        overlay.question.allowFreeform
      )
        this.#overlay = {
          ...overlay,
          text: overlay.text.slice(0, -1),
          cursor: Math.max(0, (overlay.cursor ?? overlay.text.length) - 1),
        };
      else if (
        data.length > 0 &&
        !data.includes("\u001b") &&
        [...data].every((c) => c.codePointAt(0)! >= 0x20) &&
        overlay.question.allowFreeform
      ) {
        const text = boundedOverlayText(`${overlay.text}${data}`);
        this.#overlay = { ...overlay, text, cursor: text.length };
      }
    }
  }

  private scrollOverlay(delta: number): void {
    if (this.#overlay.kind === "none") return;
    this.#overlay = {
      ...this.#overlay,
      scroll: Math.max(0, (this.#overlay.scroll ?? 0) + delta),
    };
  }

  private beginInput(purpose: TextInputPurpose): void {
    const target = this.target() as import("./actions.js").ActionTarget;
    if (purpose === "create" && !target.agent) {
      this.#message = "Select a parent agent first.";
      return;
    }
    const denied =
      purpose === "create" || purpose === "default"
        ? undefined
        : this.#actions.authorize(purpose as DeckAction, target);
    if (denied) {
      this.#message = denied;
      return;
    }
    this.#message = "";
    this.#overlay = {
      kind: "text-input",
      purpose,
      guard: {
        ...(target.agent
          ? { agentId: target.agent.id, generation: target.agent.generation }
          : {}),
        ...(target.question ? { questionId: target.question.id } : {}),
      },
      value: "",
      cursor: 0,
      focus: "editor",
      scroll: 0,
      pending: false,
    };
    this.#tracker.reset();
  }

  private beginQuestionResponse(source: "answer" | "board-answer"): void {
    const target = this.target() as import("./actions.js").ActionTarget;
    if (source === "answer") {
      const question = this.selectedQuestion();
      if (!question) {
        this.#message = "Select a question first.";
        return;
      }
      const normalized = normalizeBrokerQuestion(question);
      if (normalized.terminal) {
        this.#message = "The selected question is terminal.";
        return;
      }
      const denied = this.#actions.authorize("answer", target);
      if (denied) {
        this.#message = denied;
        return;
      }
      this.#overlay = {
        kind: "question-response",
        question: normalized,
        guard: { questionId: question.id },
        selectedOptionIds: [],
        text: "",
        cursor: 0,
        focus: "options",
        scroll: 0,
        pending: false,
      };
    } else {
      const pending = this.selectedBoardQuestion();
      if (!pending) {
        this.#message = "Select a Signals question first.";
        return;
      }
      const normalized = normalizeSignalsQuestion(pending);
      this.#overlay = {
        kind: "question-response",
        question: normalized,
        guard: { questionId: pending.questionId, revision: pending.revision },
        selectedOptionIds: [],
        text: "",
        cursor: 0,
        focus: "options",
        scroll: 0,
        pending: false,
      };
    }
    this.#message = "";
    this.#tracker.reset();
  }

  private handleTextInput(data: string): void {
    const overlay = this.#overlay;
    if (overlay.kind !== "text-input") return;
    if (data === "\u007f" || data === "\b") {
      this.#overlay = {
        ...overlay,
        value: overlay.value.slice(0, -1),
        cursor: Math.max(0, (overlay.cursor ?? overlay.value.length) - 1),
      };
      return;
    }
    if (data === "\r" || data === "\n") {
      void this.submitTextInput();
      return;
    }
    if (
      data.length > 0 &&
      !data.includes("\u001b") &&
      [...data].every((c) => c.codePointAt(0)! >= 0x20)
    ) {
      const value = boundedOverlayText(`${overlay.value}${data}`);
      this.#overlay = { ...overlay, value, cursor: value.length };
    }
  }

  private async submitTextInput(): Promise<void> {
    const overlay = this.#overlay;
    if (overlay.kind !== "text-input" || overlay.pending) return;
    const value = overlay.value.trim();
    if (!value) {
      this.#overlay = { ...overlay, error: "Text is required." };
      return;
    }
    if (overlay.purpose === "default" || overlay.purpose === "model-filter")
      this.#overlay = {
        kind: "settings",
        focus: "primary",
        scroll: 0,
        pending: false,
      };
    else this.closeOverlay();
    if (overlay.purpose === "create") void this.createAgent(value);
    else if (overlay.purpose === "files-filter") {
      this.#filesScreen = { ...this.#filesScreen, treeScroll: 0 };
      void this.runFiles("filter", value);
    } else if (overlay.purpose === "model-filter") {
      this.#modelFilter = value;
      void this.loadSettings();
    } else if (overlay.purpose === "default") void this.setDefault(value);
    else void this.run(overlay.purpose, value);
  }

  private async submitQuestionResponse(): Promise<void> {
    const overlay = this.#overlay;
    if (overlay.kind !== "question-response" || overlay.pending) return;
    if (overlay.question.terminal || !questionResponseValid(overlay)) {
      this.#overlay = {
        ...overlay,
        error: overlay.question.terminal
          ? "This question is no longer answerable."
          : "Choose an option or enter text.",
      };
      return;
    }
    const target = this.target() as import("./actions.js").ActionTarget;
    const guard = overlay.guard;
    if (
      guard?.questionId &&
      target.questionId !== guard.questionId &&
      target.boardQuestion?.questionId !== guard.questionId
    ) {
      this.#overlay = {
        ...overlay,
        error: "The question changed. Close and select it again.",
      };
      return;
    }
    if (
      overlay.question.source === "signals" &&
      guard?.revision !== undefined &&
      target.boardQuestion?.revision !== guard.revision
    ) {
      this.#overlay = {
        ...overlay,
        error: "The question revision changed. Close and select it again.",
      };
      return;
    }
    this.#overlay = { ...overlay, pending: true };
    try {
      if (overlay.question.source === "signals") {
        const value = {
          kind: overlay.selectedOptionIds.length > 0 ? "options" : "text",
          ...(overlay.selectedOptionIds.length > 0
            ? { optionIds: [...overlay.selectedOptionIds] }
            : {}),
          ...(overlay.text.trim() ? { text: overlay.text.trim() } : {}),
        };
        await this.#actions.run("agentBoardAnswer", target, value);
      } else
        await this.#actions.run("answer", target, {
          optionId: overlay.selectedOptionIds[0] ?? null,
          text: overlay.text.trim() || null,
        });
      this.#message = "Answer accepted.";
      this.closeOverlay();
    } catch (error) {
      this.#overlay = {
        ...overlay,
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.#requestRender();
  }

  private async submitConfirmation(): Promise<void> {
    const overlay = this.#overlay;
    if (overlay.kind !== "confirm" || overlay.pending) return;
    const state = this.scopedWorkState(this.#client.store.state);
    const guard = overlay.guard ?? {};
    if (overlay.action === "cancelTask") {
      const task = state.tasks.get(guard.targetId ?? "");
      if (
        !task ||
        ["succeeded", "failed", "cancelled", "timed_out"].includes(task.state)
      ) {
        this.#message = "The task changed or became terminal.";
        this.closeOverlay();
        return;
      }
      this.#selectedTask = task.id;
    } else if (
      overlay.action === "groupStop" ||
      overlay.action === "groupClose"
    ) {
      const group = state.groups.get(guard.targetId ?? "");
      if (
        !group ||
        ["closed", "stopped", "completed", "failed", "cancelled"].includes(
          group.state,
        )
      ) {
        this.#message = "The group changed or became terminal.";
        this.closeOverlay();
        return;
      }
      this.#selectedGroup = group.id;
    } else {
      const agent = state.agents.get(guard.agentId ?? guard.targetId ?? "");
      if (
        !agent ||
        (guard.generation !== undefined &&
          agent.generation !== guard.generation)
      ) {
        this.#message = "The agent changed or disappeared.";
        this.closeOverlay();
        return;
      }
      this.#selectedAgent = agent.id;
    }
    this.closeOverlay();
    try {
      await this.run(overlay.action);
    } catch (error) {
      this.#overlay = {
        ...overlay,
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private selectBoardItem(item: BoardItem): void {
    this.#unifiedBoardSelection = item.id;
    if (item.kind === "todo") this.#selectedProviderTodo = item.source.id;
    else if (item.kind === "task") this.#selectedTask = item.source.id;
    else if (item.kind === "group") this.#selectedGroup = item.source.id;
    else if (item.kind === "broker-question")
      this.#selectedQuestion = item.source.id;
    else if (item.kind === "agent-alert") this.#selectedAgent = item.source.id;
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

  private cycleBoardFilter(): void {
    const filters: BoardFilter[] = ["attention", "active", "all-current"];
    this.#boardFilter =
      filters[(filters.indexOf(this.#boardFilter) + 1) % filters.length]!;
    this.#boardScroll = 0;
  }

  private cycleActivityFilter(): void {
    const filters: ActivityFilter[] = [
      "all",
      "results",
      "signals",
      "agents",
      "errors",
    ];
    this.#activityFilter =
      filters[(filters.indexOf(this.#activityFilter) + 1) % filters.length]!;
    this.#activityScroll = 0;
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
      this.#boardFilter,
    );
    const surface = renderBoardScreen({
      width,
      height: Math.max(1, this.#getHeight() - lines.length),
      state: {
        filter: this.#boardFilter,
        ...(this.#unifiedBoardSelection
          ? { selectedId: this.#unifiedBoardSelection }
          : {}),
        listScroll: this.#boardScroll,
        detailScroll: 0,
        wheelDetached: this.#boardWheelDetached,
      },
      model,
      actions: {
        select: (item) => this.selectBoardItem(item),
        filter: (filter) => {
          this.#boardFilter = filter;
          this.#boardScroll = 0;
        },
        answer: (item) =>
          this.beginQuestionResponse(
            item.kind === "signal-question" ? "board-answer" : "answer",
          ),
        run: (item, action) => {
          if (item.kind === "todo" && action === "start")
            void this.runProvider("todoStart", "todo-start");
          else if (item.kind === "todo" && action === "mark-done")
            void this.runProvider("todoDone", "todo-done");
          else if (item.kind === "task" && action === "cancel-task")
            this.confirmTaskCancel();
          else if (item.kind === "group" && action === "wait")
            void this.run("groupWait");
          else if (item.kind === "group" && action === "stop")
            this.confirmGroup("groupStop");
          else if (item.kind === "group" && action === "close")
            this.confirmGroup("groupClose");
          else if (item.kind === "task" && action === "focus-agent")
            void this.run("focus");
          else if (item.kind === "task" && action === "open-agents")
            this.selectTab("agents");
          else if (item.kind === "agent-alert" && action === "focus")
            void this.run("focus");
          else if (item.kind === "agent-alert" && action === "prompt")
            this.beginInput("prompt");
          else if (item.kind === "agent-alert" && action === "open-agents")
            this.selectTab("agents");
          else if (item.kind.startsWith("signal-")) void this.runBoard(action);
        },
      },
    });
    if (surface.correctedState)
      this.#boardScroll = surface.correctedState.listScroll;
    const offset = lines.length;
    lines.push(...surface.lines);
    this.#hitBoxes.push(
      ...surface.hitBoxes.map((box) => ({ ...box, y: box.y + offset })),
    );
    return;
  }

  private agentActionContract(): AgentActionContract {
    return {
      authorize: (action: AgentContractAction, target) =>
        action === "create-child-agent"
          ? target.agent?.cwd
            ? undefined
            : "Agent project is unavailable."
          : this.#actions.authorize(action, target),
      activate: (action: AgentContractAction, target) => {
        if (target.agent) this.#selectedAgent = target.agent.id;
        if (action === "create-child-agent") this.beginInput("create");
        else if (
          action === "prompt" ||
          action === "ask" ||
          action === "steer" ||
          action === "followUp"
        )
          this.beginInput(action);
        else if (action === "stop") this.confirmAgentStop();
        else if (action === "close") this.confirmClose();
        else if (action === "setModel") this.cycleModel();
        else if (action === "setThinking") this.cycleThinking();
        else void this.run(action);
      },
    };
  }

  private openAgentMore(guard = agentMoreGuard(this.selectedAgent())): void {
    if (!guard) return;
    this.#overlay = {
      kind: "agent-more",
      guard,
      focus: "primary",
      scroll: 0,
      pending: false,
    };
    this.#tracker.reset();
  }

  private renderAgentsSurface(
    lines: string[],
    width: number,
    state: DeckState,
  ): void {
    const scoped = this.scopedWorkState(state);
    const surface = renderAgents({
      state: scoped,
      screen: {
        filter: this.#agentFilter,
        requestedPage: this.#agentPage,
        ...(this.#selectedAgent ? { selectedId: this.#selectedAgent } : {}),
      },
      width,
      actions: this.agentActionContract(),
      onSelect: (id) => {
        if (id.startsWith("filter:")) {
          const filter = id.slice("filter:".length);
          if (
            filter === "active" ||
            filter === "idle" ||
            filter === "history"
          ) {
            this.#agentFilter = filter;
            this.#agentPage = 0;
            this.#selectedAgent = undefined;
          }
        } else this.#selectedAgent = id;
      },
      onOpenMore: (guard) => this.openAgentMore(guard),
    });
    if (surface.correctedState) {
      this.#agentPage = surface.correctedState.requestedPage;
      this.#selectedAgent = surface.correctedState.selectedId;
    }
    this.appendSurface(lines, surface);
  }

  private selectActivityItem(item: ActivityItem): void {
    this.#activitySelection = item.id;
    if (item.kind === "terminal-task") this.#selectedTask = item.source.id;
    else if (item.kind === "terminal-group")
      this.#selectedGroup = item.source.id;
    else if (item.kind === "terminal-agent")
      this.#selectedAgent = item.source.id;
  }

  private renderActivitySurface(
    lines: string[],
    width: number,
    state: DeckState,
  ): void {
    const surface = renderActivity(
      {
        state,
        ...(this.#targetPaneId ? { targetPaneId: this.#targetPaneId } : {}),
        notifications: this.#client.store.notifications,
        screen: this.activityScreenState(),
        width,
        height: Math.max(1, this.#getHeight() - lines.length),
        onSelect: (id) => {
          if (id.startsWith("filter:")) {
            const filter = id.slice("filter:".length);
            if (
              ["all", "results", "signals", "agents", "errors"].includes(filter)
            ) {
              this.#activityFilter = filter as ActivityFilter;
              this.#activityScroll = 0;
            }
          } else {
            const item = selectActivityPresentation(
              state,
              this.#targetPaneId,
              this.#activitySelection,
              this.#activityFilter,
              this.#client.store.notifications,
            ).items.find((candidate) => candidate.id === id);
            if (item) this.selectActivityItem(item);
          }
        },
        actions: {
          isAllowed: (item, action) =>
            this.isActivityActionAllowed(item, action),
          activate: (item, action) => this.activateActivityAction(item, action),
        },
      },
      width,
    );
    if (surface.correctedState)
      this.#activityScroll = surface.correctedState.listScroll;
    this.#activitySurface = surface;
    this.#activitySurfaceOffset = lines.length;
    this.appendSurface(lines, surface);
  }

  private isActivityActionAllowed(
    item: ActivityItem,
    action: ActivityAction,
  ): boolean {
    if (action === "archive-update" || action === "retry-delivery")
      return Boolean(this.adoptedRootAgent());
    if (action === "focus")
      return item.kind === "terminal-agent" && Boolean(item.source.paneId);
    return true;
  }

  private activateActivityAction(
    item: ActivityItem,
    action: ActivityAction,
  ): void {
    this.selectActivityItem(item);
    if (action === "archive-update" || action === "retry-delivery") {
      const source = this.providerRecord(item.source);
      const fields =
        action === "archive-update"
          ? {
              updateId: item.entityId,
              expectedRevision: Number(source.revision ?? 0),
            }
          : {
              questionId: String(
                source.questionId ?? source.id ?? item.entityId,
              ),
              ...(source.answerId ? { answerId: String(source.answerId) } : {}),
              expectedRevision: Number(source.revision ?? 0),
            };
      void this.runBoardAction(action, fields);
    } else if (action === "focus") void this.run("focus");
    else void this.run("copyId");
  }

  private async runBoardAction(
    action: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const agent = this.adoptedRootAgent();
    if (!agent) return;
    try {
      await this.#actions.run("boardAction", {
        agent,
        boardAction: { action, fields },
      });
      this.#message = `Signals ${action} succeeded.`;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private activityWheelRegion(
    x: number,
    y: number,
  ): "list" | "detail" | "outside" {
    const surface = this.#activitySurface;
    if (!surface) return "outside";
    const localY = y - this.#activitySurfaceOffset;
    const region = surface.regions.find(
      (candidate) =>
        x >= candidate.x &&
        x < candidate.x + candidate.width &&
        localY >= candidate.y &&
        localY < candidate.y + candidate.height,
    );
    return region?.id === "activity:list"
      ? "list"
      : region?.id === "activity:detail"
        ? "detail"
        : "outside";
  }

  private handleActivityKey(key: string): void {
    const model = selectActivityPresentation(
      this.#client.store.state,
      this.#targetPaneId,
      this.#activitySelection,
      this.#activityFilter,
      this.#client.store.notifications,
    );
    const result = handleActivityKey(
      this.activityScreenState(),
      key,
      model.items.map((item) => item.id),
    );
    if (result.selectedId) {
      const item = model.items.find(
        (candidate) => candidate.id === result.selectedId,
      );
      if (item) this.selectActivityItem(item);
    }
  }

  private activityScreenState() {
    return {
      filter: this.#activityFilter,
      ...(this.#activitySelection
        ? { selectedId: this.#activitySelection }
        : {}),
      listScroll: this.#activityScroll,
      detailScroll: this.#activityDetailScroll,
      wheelDetached: false,
    } as const;
  }


  private adoptedRootAgent(): Agent | undefined {
    return selectAdoptedRootAgent(this.#client.store.state, this.#targetPaneId);
  }

  private providerRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
  private filesScreenOptions(): FilesScreenOptions {
    const authority = selectFilesPresentationAuthority(
      this.#client.store.state,
      this.#targetPaneId,
    );
    return {
      presentation: normalizeFilesPresentation(
        authority.provider?.files,
        authority.canOpenStandalone,
      ),
      state: this.#filesScreen,
      onStateChange: (next) => {
        this.#filesScreen = next;
      },
      onAction: (request) => this.runFilesAction(request),
    };
  }

  private renderFilesProvider(
    lines: string[],
    width: number,
    _state: DeckState,
  ): void {
    this.#filesOptions = this.filesScreenOptions();
    const surface = renderFilesScreen(
      this.#filesOptions,
      width,
      Math.max(1, this.#getHeight() - lines.length),
    );
    if (surface.correctedState) this.#filesScreen = surface.correctedState;
    this.#filesSurface = surface;
    this.#filesSurfaceOffset = lines.length;
    this.appendSurface(lines, surface);
  }

  private runFilesAction(request: FilesActionRequest): void {
    switch (request.action) {
      case "open-standalone":
        this.runProvider("filesOpen", "files-open");
        return;
      case "set-filter":
        void this.runFiles("filter", request.filter ?? "");
        return;
      case "expand":
      case "toggle-selection":
      case "preview":
        if (request.actionPath !== undefined)
          void this.runFiles(
            request.action,
            request.actionPath,
            request.expanded,
          );
        return;
      case "insert-paths":
      case "insert-contents":
      case "clear-selection":
      case "refresh":
      case "toggle-hidden":
        void this.runFiles(request.action);
        return;
    }
  }

  private async runFiles(
    action: string,
    value?: string,
    expanded?: boolean,
  ): Promise<void> {
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
          ...(value !== undefined
            ? action === "filter"
              ? { query: value }
              : { path: value }
            : {}),
          ...(expanded !== undefined ? { expanded } : {}),
        },
      } as never);
      this.#message = `Files ${action} succeeded.`;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }
  private async runBoard(action: string): Promise<void> {
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
    if (this.#overlay.kind !== "none") {
      this.scrollOverlay(delta);
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
        this.#boardFilter,
      );
      const items = model.visible;
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
        this.#activityFilter,
        this.#client.store.notifications,
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
    }
    if (this.#overlay.kind === "confirm") this.closeOverlay();
  }

  private target() {
    const scoped = this.scopedWorkState(this.#client.store.state);
    const task =
      this.#tab === "board" ? this.selectedTask(scoped) : this.selectedTask();
    const boardSelected =
      this.#tab === "board"
        ? selectUnifiedBoardPresentation(
            this.#client.store.state,
            this.#targetPaneId,
            this.#unifiedBoardSelection,
            this.#boardFilter,
          ).selected
        : undefined;
    const boardOwner =
      boardSelected?.kind === "task" && boardSelected.source.assignedAgentId
        ? scoped.agents.get(boardSelected.source.assignedAgentId)
        : boardSelected?.kind === "agent-alert"
          ? boardSelected.source
          : undefined;
    const agent =
      boardOwner ??
      (this.#tab === "board" || this.#tab === "files"
        ? this.adoptedRootAgent()
        : (this.selectedAgent() ?? this.adoptedRootAgent()));
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
      if (this.#overlay.kind === "confirm") this.closeOverlay();
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
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
        Math.floor(
          (this.#overlay.kind === "settings"
            ? (this.#overlay.scroll ?? 0)
            : 0) / pageSize,
        ),
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
    this.#overlay = {
      kind: "confirm",
      action: "cancelTask",
      guard: { targetId: task.id },
      summary: `Cancel ${task.title}?`,
      focus: "primary",
      scroll: 0,
      pending: false,
    };
    this.#tracker.reset();
  }

  private confirmGroup(action: "groupStop" | "groupClose"): void {
    const group = this.selectedGroup(
      this.scopedWorkState(this.#client.store.state),
    );
    if (!group) {
      this.#message = "Select a group first.";
      return;
    }
    this.#overlay = {
      kind: "confirm",
      action,
      guard: { targetId: group.id },
      summary: `${action === "groupStop" ? "Stop" : "Close"} ${group.name ?? group.id}?`,
      focus: "primary",
      scroll: 0,
      pending: false,
    };
    this.#tracker.reset();
  }

  private async copySelectedId(): Promise<void> {
    await this.run("copyId");
  }

  private confirmAgentStop(): void {
    const agent = this.selectedAgent();
    if (!agent) return;
    this.#overlay = {
      kind: "confirm",
      action: "stop",
      guard: { agentId: agent.id, generation: agent.generation },
      summary: `Stop ${agent.displayName ?? agent.id}?`,
      focus: "primary",
      scroll: 0,
      pending: false,
    };
    this.#tracker.reset();
  }

  private confirmClose(): void {
    const agent = this.selectedAgent();
    if (!agent) {
      this.#message = "Select an agent first.";
      return;
    }
    this.#overlay = {
      kind: "confirm",
      action: "close",
      guard: { agentId: agent.id, generation: agent.generation },
      summary: `Close ${agent.displayName ?? agent.id}?`,
      focus: "primary",
      scroll: 0,
      pending: false,
    };
    this.#tracker.reset();
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
