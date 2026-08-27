import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "@pi-herdr-deck/tui";
import { BrokerClient, type BrokerStatus } from "./broker-client.js";
import { DeckActions, type DeckAction } from "./actions.js";
import {
  currentProviderProjection,
  getAgentModelChoices,
  getAgentThinkingChoices,
  renderNotifications,
} from "./views.js";
import { type HitBox, PressReleaseTracker } from "./components/controls.js";
import type { Agent } from "../state/types.js";
import type { DeckState } from "./types.js";
import { styleLines } from "./theme.js";
import type { PiCapabilitySnapshot } from "../pi/model-capabilities.js";
import type { ModelPolicyConfig } from "../broker/model-policy.js";
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
} from "./product-presentation.js";
import {
  selectAdoptedRootAgent,
  selectAdoptedScope,
  selectFilesPresentationAuthority,
} from "./scope.js";
import {
  moveAgentListSelection,
  selectAgentListPresentation,
} from "./selections.js";
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
  activateAgentMore,
  agentMoreGuard,
  isAgentMoreGuardCurrent,
  moveAgentMoreFocus,
  openAgentMore,
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
  allowsEmptyText,
  boundedOverlayText,
  noOverlay,
  questionResponseValid,
  toggleQuestionOption,
  applyQuestionRecommendation,
  type OverlayState,
  type TextInputPurpose,
} from "./overlay-screen.js";
import { renderSettingsScreen } from "./screens/settings-screen.js";
import { renderSettingsContent } from "./settings-presentation.js";
import {
  actionTargetForActivityItem,
  actionTargetForAgent,
  actionTargetForBoardItem,
  activityActionRequest,
  normalizedSignalsQuestionForBoardItem,
  signalsActionRequest,
  signalsQuestionForBoardItem,
} from "./product-actions.js";
import { renderHelpScreen } from "./screens/help-screen.js";
import { renderAgentMoreScreen } from "./screens/agent-more-screen.js";
import { renderConfirmationScreen } from "./screens/confirmation-screen.js";
import { renderTextInputScreen } from "./screens/text-input-screen.js";
import { renderQuestionResponseScreen } from "./screens/question-response-screen.js";
import { renderHeader } from "./shell/header.js";
import type { RenderedSurface } from "./screen-types.js";
import {
  buildQuestionResponsePayload,
  type QuestionResponseSelection,
} from "./question-response.js";

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
  #unifiedBoardSelection: string | undefined;
  #boardFilter: BoardFilter = "all-current";
  #boardScroll = 0;
  #boardWheelDetached = false;
  #activitySelection: string | undefined;
  #activityFilter: ActivityFilter = "all";
  #activityScroll = 0;
  #activityDetailScroll = 0;
  #activityWheelDetached = false;
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
          !isAgentMoreGuardCurrent(
            this.scopedWorkState(state),
            this.#overlay.guard,
          )
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
    if (!this.ensureAgentMoreCurrent()) this.#requestRender();
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
    if (!this.ensureAgentMoreCurrent()) {
      this.#requestRender();
      return;
    }
    if (this.#overlay.kind !== "none") {
      this.handleOverlayInput(data);
      this.syncVisibleSignature();
      this.#requestRender();
      return;
    }
    if (
      data === "\u001b" &&
      this.#tab === "files" &&
      this.#filesSurface?.layout.narrow &&
      this.#filesScreen.activePane === "preview"
    ) {
      this.#filesScreen = {
        ...this.#filesScreen,
        activePane: "tree",
        focusTarget: "tree",
      };
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
    else if (data === "r" && this.#tab === "files")
      handleFilesKey(this.filesScreenOptions(), "r");
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
            : data === "\u001b[C"
              ? "ArrowRight"
              : data === "\u001b[D"
                ? "ArrowLeft"
                : data === "\r" || data === "\n"
                  ? "Enter"
                  : data === "\t"
                    ? "Tab"
                    : data === "\u001b[Z"
                      ? "Shift+Tab"
                      : data === "\u001b[5~"
                        ? "PageUp"
                        : data === "\u001b[6~"
                          ? "PageDown"
                          : data;
      if (!handleFilesKey(this.filesScreenOptions(), key) && data === "/")
        this.beginInput("files-filter");
    } else if (data === "f" && this.#tab === "agents") void this.run("focus");
    else if (data === "p" && this.#tab === "agents") this.beginInput("prompt");
    else if (data === "a" && this.#tab === "agents") this.beginInput("ask");
    else if (data === "a" && this.#tab === "board") {
      const item = this.selectedBoardItem();
      if (item?.kind === "signal-question")
        this.beginQuestionResponse("board-answer", item);
      else if (item?.kind === "broker-question")
        this.beginQuestionResponse("answer", item);
      else this.#message = "Select a question first.";
    } else if (data === "y" && this.#tab === "board") {
      const item = this.selectedBoardItem();
      if (item?.kind === "signal-question")
        void this.runSignalsAction(item, "accept-recommendation");
    } else if (data === "i" && this.#tab === "agents")
      void this.run("interrupt");
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
    if (!this.ensureAgentMoreCurrent()) {
      this.#requestRender();
      return true;
    }
    if (this.#overlay.kind !== "none") {
      if (this.#overlay.kind === "agent-more" && event.type === "wheel") {
        this.setAgentMoreFocus(event.direction === "down" ? 1 : -1);
        this.#requestRender();
        return true;
      }
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
        this.#activityWheelDetached = result.state.wheelDetached;
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
    if (!this.ensureAgentMoreCurrent()) {
      this.#renderSignature = this.visibleSignature();
    }
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
      ...(this.#unifiedBoardSelection
        ? { boardSelectedId: this.#unifiedBoardSelection }
        : {}),
      ...(this.#activitySelection
        ? { activitySelectedId: this.#activitySelection }
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

  private guardedAgent(
    guard: Extract<OverlayState, { kind: "agent-more" }>["guard"],
  ): Agent | undefined {
    const agent = this.scopedWorkState(this.#client.store.state).agents.get(
      guard.agentId,
    );
    return agent?.generation === guard.generation ? agent : undefined;
  }

  private ensureAgentMoreCurrent(): boolean {
    if (
      this.#overlay.kind === "agent-more" &&
      !this.guardedAgent(this.#overlay.guard)
    ) {
      this.closeOverlay();
      this.syncVisibleSignature();
      return false;
    }
    return true;
  }

  private setAgentMoreFocus(delta: number): void {
    const overlay = this.#overlay;
    if (overlay.kind !== "agent-more" || !this.ensureAgentMoreCurrent()) return;
    const presentation = openAgentMore(
      this.scopedWorkState(this.#client.store.state),
      overlay.guard,
      overlay.focusedIndex ?? 0,
      this.agentActionContract(),
    );
    if (!presentation) {
      this.closeOverlay();
      return;
    }
    this.#overlay = {
      ...overlay,
      focusedIndex: moveAgentMoreFocus(presentation, delta).focusedIndex,
    };
  }

  private activateAgentMore(
    guard: Extract<OverlayState, { kind: "agent-more" }>["guard"],
    index: number,
  ): void {
    if (!this.ensureAgentMoreCurrent()) return;
    const presentation = openAgentMore(
      this.scopedWorkState(this.#client.store.state),
      guard,
      index,
      this.agentActionContract(),
    );
    if (!presentation) {
      this.closeOverlay();
      return;
    }
    activateAgentMore(
      this.scopedWorkState(this.#client.store.state),
      presentation,
      this.agentActionContract(),
    );
    this.syncVisibleSignature();
    this.#requestRender();
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
          content: renderSettingsContent({
            capabilities: this.#capabilities,
            modelPolicy: this.#modelPolicy,
            modelFilter: this.#modelFilter,
            autoCloseCompletedTemporary: this.#autoCloseCompletedTemporary,
            scroll: overlay.scroll ?? 0,
            height: this.#getHeight(),
          }),
          onDefault: () => this.beginInput("default"),
          onAutoClose: () => void this.toggleAutoClose(),
          onClose: () => this.closeOverlay(),
        });
      case "help":
        return renderHelpScreen(width, () => this.closeOverlay());
      case "agent-more": {
        const presentation = openAgentMore(
          this.scopedWorkState(this.#client.store.state),
          overlay.guard,
          overlay.focusedIndex ?? 0,
          this.agentActionContract(),
        );
        return renderAgentMoreScreen({
          width,
          agent: this.guardedAgent(overlay.guard),
          ...(presentation ? { presentation } : {}),
          onActivate: (index) => this.activateAgentMore(overlay.guard, index),
          onCompact: () => undefined,
          onRestart: () => undefined,
          onCloseAgent: () => undefined,
          onWorktree: () => undefined,
          onCopy: () => undefined,
          onModel: () => undefined,
          onThinking: () => undefined,
          onCreate: () => undefined,
          onClose: () => this.closeOverlay(),
        });
      }
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
          onRecommendation: () =>
            void this.handleQuestionRecommendation(overlay),
          onSubmit: () => void this.submitQuestionResponse(),
          onCancel: () => this.closeOverlay(),
          onDismiss: () => void this.dismissQuestion(overlay),
          onRetry: () => void this.retryQuestionDelivery(overlay),
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
      if (data === "m" || data === "\u001b") this.closeOverlay();
      else if (data === "\u001b[A" || data === "k" || data === "\u001b[Z")
        this.setAgentMoreFocus(-1);
      else if (data === "\u001b[B" || data === "j" || data === "\t")
        this.setAgentMoreFocus(1);
      else if (data === "\r" || data === "\n")
        this.activateAgentMore(overlay.guard, overlay.focusedIndex ?? 0);
      return;
    }
    if (overlay.kind === "text-input") {
      this.handleTextInput(data);
      return;
    }
    if (overlay.kind === "question-response") {
      if (data === "y") this.handleQuestionRecommendation(overlay);
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

  private beginInput(
    purpose: TextInputPurpose,
    targetOverride?: import("./actions.js").ActionTarget,
  ): void {
    const target = targetOverride ?? this.target();
    if (purpose === "create" && !target.agent) {
      this.#message = "Select a parent agent first.";
      return;
    }
    const denied =
      purpose === "create" ||
      purpose === "default" ||
      purpose === "files-filter" ||
      purpose === "model-filter"
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

  private beginQuestionResponse(
    source: "answer" | "board-answer",
    item: BoardItem,
  ): void {
    const target = actionTargetForBoardItem(item, this.productTargetContext());
    if (source === "answer" && item.kind === "broker-question") {
      const normalized = normalizeBrokerQuestion(item.source);
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
        target,
        question: normalized,
        guard: { questionId: item.source.id },
        selectedOptionIds: [],
        text: "",
        cursor: 0,
        focus: "options",
        scroll: 0,
        pending: false,
      };
    } else if (source === "board-answer" && item.kind === "signal-question") {
      const pending = signalsQuestionForBoardItem(
        item,
        this.productTargetContext().agentBoard,
      );
      const normalized = normalizedSignalsQuestionForBoardItem(
        item,
        this.productTargetContext().agentBoard,
      );
      if (!pending || !normalized) {
        this.#message = "Select a Signals question first.";
        return;
      }
      this.#overlay = {
        kind: "question-response",
        target: {
          ...target,
          boardQuestion: pending,
          questionId: pending.questionId,
        },
        question: normalized,
        guard: { questionId: pending.questionId, revision: pending.revision },
        selectedOptionIds: [],
        text: "",
        cursor: 0,
        focus: "options",
        scroll: 0,
        pending: false,
      };
    } else {
      this.#message = "Select a question first.";
      return;
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
    if (!value && !allowsEmptyText(overlay.purpose)) {
      this.#overlay = { ...overlay, error: "Text is required." };
      return;
    }
    const target = this.targetForOverlayGuard(overlay.guard);
    if (overlay.guard?.agentId && !target?.agent) {
      this.#overlay = {
        ...overlay,
        error: "The agent changed. Close and select it again.",
      };
      return;
    }
    if (overlay.purpose === "create" && !target?.agent) {
      this.#overlay = { ...overlay, error: "Select a parent agent first." };
      return;
    }
    const action = overlay.purpose;
    if (
      action !== "create" &&
      action !== "default" &&
      action !== "files-filter" &&
      action !== "model-filter"
    ) {
      const denied = this.#actions.authorize(
        action as DeckAction,
        target ?? {},
      );
      if (denied) {
        this.#overlay = { ...overlay, error: denied };
        return;
      }
    }
    const { error: _overlayError, ...overlayWithoutError } = overlay;
    this.#overlay = { ...overlayWithoutError, pending: true };
    try {
      let accepted = true;
      if (overlay.purpose === "create")
        accepted = await this.createAgent(value, target?.agent);
      else if (overlay.purpose === "files-filter") {
        this.#filesScreen = { ...this.#filesScreen, treeScroll: 0 };
        accepted = await this.runFiles("filter", value);
      } else if (overlay.purpose === "model-filter") {
        this.#modelFilter = value;
        accepted = await this.loadSettings();
      } else if (overlay.purpose === "default")
        accepted = await this.setDefault(value);
      else accepted = await this.run(overlay.purpose, value, target);
      if (!accepted) {
        this.#overlay = {
          ...overlay,
          pending: false,
          error: this.#message || "The request was rejected.",
        };
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
    } catch (error) {
      this.#overlay = {
        ...overlay,
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.#requestRender();
  }

  private targetForOverlayGuard(
    guard: import("./overlay-screen.js").OverlayTargetGuard | undefined,
  ): import("./actions.js").ActionTarget | undefined {
    if (!guard?.agentId) return this.target();
    const agent = this.scopedWorkState(this.#client.store.state).agents.get(
      guard.agentId,
    );
    if (!agent || agent.generation !== guard.generation) return undefined;
    return actionTargetForAgent(agent);
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
    const model = selectUnifiedBoardPresentation(
      this.#client.store.state,
      this.#targetPaneId,
      undefined,
      "all-current",
    );
    const currentItem = model.visible.find(
      (item) =>
        item.entityId === overlay.guard?.questionId &&
        (overlay.question.source === "signals"
          ? item.kind === "signal-question"
          : item.kind === "broker-question"),
    );
    if (!currentItem) {
      this.#overlay = {
        ...overlay,
        error: "The question changed. Close and select it again.",
      };
      return;
    }
    const context = this.productTargetContext();
    const currentTarget = actionTargetForBoardItem(currentItem, context);
    const currentQuestion =
      currentItem.kind === "signal-question"
        ? normalizedSignalsQuestionForBoardItem(currentItem, context.agentBoard)
        : currentItem.kind === "broker-question"
          ? normalizeBrokerQuestion(currentItem.source)
          : undefined;
    if (!currentQuestion) {
      this.#overlay = {
        ...overlay,
        error: "The current Signals question is unavailable.",
      };
      return;
    }
    if (
      currentQuestion.terminal ||
      currentQuestion.responseKind !== overlay.question.responseKind ||
      (overlay.guard?.revision !== undefined &&
        currentQuestion.revision !== overlay.guard.revision)
    ) {
      this.#overlay = {
        ...overlay,
        error: "The question changed. Close and select it again.",
      };
      return;
    }
    const selection: QuestionResponseSelection = {
      selectedOptionIds: [...overlay.selectedOptionIds],
      text: overlay.text,
    };
    this.#overlay = { ...overlay, pending: true };
    try {
      // Validate against the freshly resolved question. DeckActions rebuilds the
      // same typed payload and never accepts a caller-supplied wire value.
      buildQuestionResponsePayload(currentQuestion, selection);
      await this.#actions.run(
        currentQuestion.source === "signals" ? "agentBoardAnswer" : "answer",
        currentTarget,
        selection,
      );
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

  private async handleQuestionRecommendation(
    overlay: Extract<OverlayState, { kind: "question-response" }>,
  ): Promise<void> {
    if (overlay.question.source !== "signals") {
      this.#overlay = applyQuestionRecommendation(overlay);
      return;
    }
    await this.runQuestionMutation(overlay, "accept-recommendation");
  }

  private async dismissQuestion(
    overlay: Extract<OverlayState, { kind: "question-response" }>,
  ): Promise<void> {
    if (overlay.question.source !== "signals") return;
    await this.runQuestionMutation(overlay, "dismiss-question");
  }

  private async retryQuestionDelivery(
    overlay: Extract<OverlayState, { kind: "question-response" }>,
  ): Promise<void> {
    if (
      overlay.question.source !== "signals" ||
      !overlay.question.retryableDelivery ||
      !overlay.question.answerId
    )
      return;
    await this.runQuestionMutation(overlay, "retry-delivery");
  }

  private async runQuestionMutation(
    overlay: Extract<OverlayState, { kind: "question-response" }>,
    action: "accept-recommendation" | "dismiss-question" | "retry-delivery",
  ): Promise<void> {
    if (this.#overlay.kind !== "question-response" || this.#overlay.pending)
      return;
    const item = this.currentBoardQuestionItem(overlay.guard?.questionId);
    const current = item
      ? normalizedSignalsQuestionForBoardItem(
          item,
          this.productTargetContext().agentBoard,
        )
      : undefined;
    if (
      !item ||
      !current ||
      current.terminal ||
      current.revision !== overlay.guard?.revision ||
      (action === "dismiss-question" && !current.dismissible) ||
      (action === "retry-delivery" &&
        (!current.retryableDelivery || !current.answerId))
    ) {
      this.#overlay = {
        ...overlay,
        error: "The question changed. Close and select it again.",
      };
      return;
    }
    const request = signalsActionRequest(
      item,
      action,
      this.productTargetContext().agentBoard,
    );
    if (!request) {
      this.#overlay = { ...overlay, error: "The action is unavailable." };
      return;
    }
    const { error: _previousError, ...pendingOverlay } = overlay;
    this.#overlay = { ...pendingOverlay, pending: true };
    this.#requestRender();
    const target = actionTargetForBoardItem(item, this.productTargetContext());
    const ok = await this.run("boardAction", undefined, {
      ...target,
      boardAction: request,
    });
    if (ok) this.closeOverlay();
    else
      this.#overlay = {
        ...overlay,
        pending: false,
        error: this.#message.slice(0, 4_000),
      };
    this.#requestRender();
  }

  private currentBoardQuestionItem(questionId?: string): BoardItem | undefined {
    if (!questionId) return undefined;
    return selectUnifiedBoardPresentation(
      this.#client.store.state,
      this.#targetPaneId,
      undefined,
      "all-current",
    ).visible.find(
      (item) => item.kind === "signal-question" && item.entityId === questionId,
    );
  }

  private async submitConfirmation(): Promise<void> {
    const overlay = this.#overlay;
    if (overlay.kind !== "confirm" || overlay.pending) return;
    const state = this.scopedWorkState(this.#client.store.state);
    const guard = overlay.guard ?? {};
    let target: import("./actions.js").ActionTarget | undefined;
    if (overlay.action === "cancelTask") {
      const taskId = overlay.target.task?.id ?? guard.targetId;
      const task = state.tasks.get(taskId ?? "");
      if (
        !task ||
        ["succeeded", "failed", "cancelled", "timed_out"].includes(task.state)
      ) {
        this.#message = "The task changed or became terminal.";
        this.closeOverlay();
        return;
      }
      const item = selectUnifiedBoardPresentation(
        this.#client.store.state,
        this.#targetPaneId,
        `orchestrator:task:${task.id}`,
        this.#boardFilter,
      ).visible.find(
        (candidate) =>
          candidate.kind === "task" && candidate.source.id === task.id,
      );
      if (!item || item.kind !== "task") {
        this.#message = "The task changed. Close and select it again.";
        this.closeOverlay();
        return;
      }
      target = actionTargetForBoardItem(item, this.productTargetContext());
    } else if (
      overlay.action === "groupStop" ||
      overlay.action === "groupClose"
    ) {
      const groupId = overlay.target.group?.id ?? guard.targetId;
      const group = state.groups.get(groupId ?? "");
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
      const item = selectUnifiedBoardPresentation(
        this.#client.store.state,
        this.#targetPaneId,
        `orchestrator:group:${group.id}`,
        this.#boardFilter,
      ).visible.find(
        (candidate) =>
          candidate.kind === "group" && candidate.source.id === group.id,
      );
      if (!item || item.kind !== "group") {
        this.#message = "The group changed. Close and select it again.";
        this.closeOverlay();
        return;
      }
      target = actionTargetForBoardItem(item, this.productTargetContext());
    } else {
      const agentId =
        overlay.target.agent?.id ?? guard.agentId ?? guard.targetId;
      const agent = state.agents.get(agentId ?? "");
      if (
        !agent ||
        (guard.generation !== undefined &&
          agent.generation !== guard.generation)
      ) {
        this.#message = "The agent changed or disappeared.";
        this.closeOverlay();
        return;
      }
      target = actionTargetForAgent(agent);
    }
    const denied = this.#actions.authorize(overlay.action, target);
    if (denied) {
      this.#message = denied;
      this.closeOverlay();
      return;
    }
    this.#onActionTarget?.(overlay.action, target);
    this.closeOverlay();
    try {
      await this.#actions.run(overlay.action, target);
      this.#message = `${overlay.action} accepted.`;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private selectBoardItem(item: BoardItem): void {
    this.#unifiedBoardSelection = item.id;
    this.#boardWheelDetached = false;
  }

  private selectedBoardItem(): BoardItem | undefined {
    return selectUnifiedBoardPresentation(
      this.#client.store.state,
      this.#targetPaneId,
      this.#unifiedBoardSelection,
      this.#boardFilter,
    ).selected;
  }

  private runSignalsAction(item: BoardItem, action: string): void {
    const request = signalsActionRequest(
      item,
      action,
      this.productTargetContext().agentBoard,
    );
    if (!request) return;
    const target = actionTargetForBoardItem(item, this.productTargetContext());
    void this.run("boardAction", undefined, {
      ...target,
      boardAction: request,
    });
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
          this.#boardWheelDetached = false;
        },
        answer: (item) => {
          if (item.kind === "signal-question")
            this.beginQuestionResponse("board-answer", item);
          else if (item.kind === "broker-question")
            this.beginQuestionResponse("answer", item);
        },
        run: (item, action) => {
          const target = actionTargetForBoardItem(
            item,
            this.productTargetContext(),
          );
          if (item.kind === "todo" && action === "start")
            void this.runProvider("todoStart", "todo-start", undefined, target);
          else if (item.kind === "todo" && action === "mark-done")
            void this.runProvider("todoDone", "todo-done", undefined, target);
          else if (item.kind === "task" && action === "cancel-task")
            this.confirmTaskCancel(item);
          else if (item.kind === "group" && action === "wait")
            void this.run("groupWait", undefined, target);
          else if (item.kind === "group" && action === "stop")
            this.confirmGroup("groupStop", item);
          else if (item.kind === "group" && action === "close")
            this.confirmGroup("groupClose", item);
          else if (item.kind === "task" && action === "focus-agent")
            void this.run("focus", undefined, target);
          else if (item.kind === "task" && action === "open-agents")
            this.selectTab("agents");
          else if (item.kind === "agent-alert" && action === "focus")
            void this.run("focus", undefined, target);
          else if (item.kind === "agent-alert" && action === "prompt")
            this.beginInput("prompt", target);
          else if (item.kind === "agent-alert" && action === "open-agents")
            this.selectTab("agents");
          else if (item.kind.startsWith("signal-"))
            void this.runSignalsAction(item, action);
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
        if (action === "create-child-agent") this.beginInput("create", target);
        else if (
          action === "prompt" ||
          action === "ask" ||
          action === "steer" ||
          action === "followUp"
        )
          this.beginInput(action, target);
        else if (action === "stop") this.confirmAgentStop(target);
        else if (action === "close") this.confirmClose(target);
        else if (action === "setModel") this.cycleModel(target.agent);
        else if (action === "setThinking") this.cycleThinking(target.agent);
        else void this.run(action, undefined, target);
      },
    };
  }

  private openAgentMore(guard = agentMoreGuard(this.selectedAgent())): void {
    if (!guard) return;
    this.#overlay = {
      kind: "agent-more",
      guard,
      focusedIndex: 0,
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
    const model = selectActivityPresentation(
      this.#client.store.state,
      this.#targetPaneId,
      item.id,
      this.#activityFilter,
      this.#client.store.notifications,
    );
    const index = model.items.findIndex(
      (candidate) => candidate.id === item.id,
    );
    const visibleCount = Math.max(1, this.#getHeight() - 12);
    if (index >= 0) {
      if (index < this.#activityScroll) this.#activityScroll = index;
      else if (index >= this.#activityScroll + visibleCount)
        this.#activityScroll = index - visibleCount + 1;
    }
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
    if (surface.correctedState) {
      this.#activityScroll = surface.correctedState.listScroll;
      this.#activityDetailScroll = surface.correctedState.detailScroll;
      this.#activityWheelDetached = surface.correctedState.wheelDetached;
    }
    this.#activitySurface = surface;
    this.#activitySurfaceOffset = lines.length;
    this.appendSurface(lines, surface);
  }

  private currentActivityItem(uiId: string): ActivityItem | undefined {
    return selectActivityPresentation(
      this.#client.store.state,
      this.#targetPaneId,
      uiId,
      this.#activityFilter,
      this.#client.store.notifications,
    ).items.find((candidate) => candidate.uiId === uiId);
  }

  private isActivityActionAllowed(
    item: ActivityItem,
    action: ActivityAction,
  ): boolean {
    const current = this.currentActivityItem(item.uiId);
    if (!current || !current.actions.actions.includes(action)) return false;
    const target = actionTargetForActivityItem(
      current,
      this.productTargetContext(),
    );
    if (action === "archive-update" || action === "retry-delivery") {
      const request = activityActionRequest(current, action);
      return Boolean(
        request &&
        !this.#actions.authorize("boardAction", {
          ...target,
          boardAction: request,
        }),
      );
    }
    if (action === "focus") return !this.#actions.authorize("focus", target);
    return !this.#actions.authorize("copyId", target);
  }

  private activateActivityAction(
    item: ActivityItem,
    action: ActivityAction,
  ): void {
    const current = this.currentActivityItem(item.uiId);
    if (!current || !this.isActivityActionAllowed(current, action)) return;
    this.selectActivityItem(current);
    const target = actionTargetForActivityItem(
      current,
      this.productTargetContext(),
    );
    const request = activityActionRequest(current, action);
    if (request)
      void this.run("boardAction", undefined, {
        ...target,
        boardAction: request,
      });
    else if (action === "focus") void this.run("focus", undefined, target);
    else void this.run("copyId", undefined, target);
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
      Math.max(1, this.#getHeight() - 12),
    );
    this.#activityScroll = result.state.listScroll;
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
      wheelDetached: this.#activityWheelDetached,
    } as const;
  }

  private adoptedRootAgent(): Agent | undefined {
    return selectAdoptedRootAgent(this.#client.store.state, this.#targetPaneId);
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
      case "toggle-hidden":
        void this.runFiles(request.action);
        return;
      case "refresh":
        void this.runFiles("snapshot");
        return;
    }
  }

  private async runFiles(
    action: string,
    value?: string,
    expanded?: boolean,
  ): Promise<boolean> {
    const agent = this.adoptedRootAgent();
    if (!agent) {
      this.#message = "Files provider owner is unavailable.";
      return false;
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
      this.#requestRender();
      return false;
    }
    this.#requestRender();
    return true;
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

  private productTargetContext() {
    const state = this.#client.store.state;
    return {
      rootAgent: this.adoptedRootAgent(),
      scopedAgents: this.scopedWorkState(state).agents,
      runs: this.scopedWorkState(state).runs,
      agentBoard: currentProviderProjection(state, this.#targetPaneId)
        ?.agentBoard,
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

  private selectedActivityItem(): ActivityItem | undefined {
    return selectActivityPresentation(
      this.#client.store.state,
      this.#targetPaneId,
      this.#activitySelection,
      this.#activityFilter,
      this.#client.store.notifications,
    ).selected;
  }

  private target(): import("./actions.js").ActionTarget {
    if (this.#tab === "board") {
      const item = this.selectedBoardItem();
      return item
        ? actionTargetForBoardItem(item, this.productTargetContext())
        : actionTargetForAgent(this.adoptedRootAgent());
    }
    if (this.#tab === "activity") {
      const item = this.selectedActivityItem();
      return item
        ? actionTargetForActivityItem(item, this.productTargetContext())
        : actionTargetForAgent(this.adoptedRootAgent());
    }
    return actionTargetForAgent(
      this.#tab === "files"
        ? this.adoptedRootAgent()
        : (this.selectedAgent() ?? this.adoptedRootAgent()),
    );
  }

  private runProvider(
    action: DeckAction,
    key: string,
    value?: unknown,
    targetOverride?: import("./actions.js").ActionTarget,
  ): void {
    if (this.#providerPending.has(key)) return;
    this.#providerPending.add(key);
    this.#message = `${action} pending…`;
    const target = targetOverride ?? this.target();
    this.#onActionTarget?.(action, target);
    this.#requestRender();
    void this.#actions
      .run(action, target, value as never)
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
  private async run(
    action: DeckAction,
    value?: string,
    targetOverride?: import("./actions.js").ActionTarget,
  ): Promise<boolean> {
    try {
      const target = targetOverride ?? this.target();
      this.#onActionTarget?.(action, target);
      const result = await this.#actions.run(action, target, value);
      this.#message =
        action === "copyId"
          ? `Copied ID: ${String(result)}`
          : `${action} accepted.`;
      if (this.#overlay.kind === "confirm") this.closeOverlay();
      this.#requestRender();
      return true;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
      this.#requestRender();
      return false;
    }
  }

  private async loadSettings(): Promise<boolean> {
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
      this.#requestRender();
      return false;
    }
    this.#requestRender();
    return true;
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

  private async setDefault(value: string): Promise<boolean> {
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
      return false;
    }
    try {
      await this.#client.request("model.policy.set", {
        scope,
        key: key ?? "",
        model: { provider, modelId, thinkingLevel },
      });
      const settingsAccepted = await this.loadSettings();
      if (!settingsAccepted) return false;
      this.#message =
        "The scoped default was accepted for new agents. Running agents were not changed.";
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
      this.#requestRender();
      return false;
    }
    this.#requestRender();
    return true;
  }

  private async createAgent(
    value: string,
    parentOverride?: Agent,
  ): Promise<boolean> {
    const parts = value.split("|").map((part) => part.trim());
    const automatic = parts.length === 5 && parts[3] === "auto";
    const [title, objective, profileId] = parts;
    const provider = automatic ? undefined : parts[3];
    const modelId = automatic ? undefined : parts[4];
    const thinkingLevel = automatic ? undefined : parts[5];
    const lifecycleClass = automatic ? parts[4] : parts[6];
    const parent = parentOverride ?? this.selectedAgent();
    if (
      (!automatic && parts.length !== 7) ||
      !parent?.cwd ||
      !title ||
      !objective ||
      !profileId ||
      (!automatic && (!provider || !modelId || !thinkingLevel)) ||
      !["temporary", "reusable", "retained", "pinned"].includes(
        lifecycleClass ?? "",
      )
    ) {
      this.#message =
        "Use title|objective|profile|auto|lifecycle or title|objective|profile|provider|model|thinking|lifecycle.";
      this.#requestRender();
      return false;
    }
    try {
      await this.#client.request("agent.spawn", {
        parentAgentId: parent.id,
        task: { title, objective },
        profileId,
        ...(automatic ? {} : { model: { provider, modelId, thinkingLevel } }),
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
      this.#message = automatic
        ? "Creation accepted with broker-owned model selection."
        : `Creation accepted with explicit ${provider}/${modelId} and ${thinkingLevel} thinking.`;
      await this.#client.refresh();
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
      this.#requestRender();
      return false;
    }
    this.#requestRender();
    return true;
  }

  private confirmTaskCancel(item?: BoardItem): void {
    const selected = item ?? this.selectedBoardItem();
    if (!selected || selected.kind !== "task") {
      this.#message = "Select a task first.";
      return;
    }
    const target = actionTargetForBoardItem(
      selected,
      this.productTargetContext(),
    );
    this.#overlay = {
      kind: "confirm",
      action: "cancelTask",
      target,
      guard: { targetId: selected.source.id },
      summary: `Cancel ${selected.source.title ?? selected.source.id}?`,
      focus: "primary",
      scroll: 0,
      pending: false,
    };
    this.#tracker.reset();
  }

  private confirmGroup(
    action: "groupStop" | "groupClose",
    item?: BoardItem,
  ): void {
    const selected = item ?? this.selectedBoardItem();
    if (!selected || selected.kind !== "group") {
      this.#message = "Select a group first.";
      return;
    }
    const target = actionTargetForBoardItem(
      selected,
      this.productTargetContext(),
    );
    this.#overlay = {
      kind: "confirm",
      action,
      target,
      guard: { targetId: selected.source.id },
      summary: `${action === "groupStop" ? "Stop" : "Close"} ${selected.source.name ?? selected.source.title ?? selected.source.id}?`,
      focus: "primary",
      scroll: 0,
      pending: false,
    };
    this.#tracker.reset();
  }

  private confirmAgentStop(
    targetOverride?: import("./actions.js").ActionTarget,
  ): void {
    const agent = targetOverride?.agent ?? this.selectedAgent();
    if (!agent) return;
    this.#overlay = {
      kind: "confirm",
      action: "stop",
      target: targetOverride ?? actionTargetForAgent(agent),
      guard: { agentId: agent.id, generation: agent.generation },
      summary: `Stop ${agent.displayName ?? agent.id}?`,
      focus: "primary",
      scroll: 0,
      pending: false,
    };
    this.#tracker.reset();
  }

  private confirmClose(
    targetOverride?: import("./actions.js").ActionTarget,
  ): void {
    const agent = targetOverride?.agent ?? this.selectedAgent();
    if (!agent) {
      this.#message = "Select an agent first.";
      return;
    }
    this.#overlay = {
      kind: "confirm",
      action: "close",
      target: targetOverride ?? actionTargetForAgent(agent),
      guard: { agentId: agent.id, generation: agent.generation },
      summary: `Close ${agent.displayName ?? agent.id}?`,
      focus: "primary",
      scroll: 0,
      pending: false,
    };
    this.#tracker.reset();
  }

  private cycleModel(agent = this.selectedAgent()): void {
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

  private cycleThinking(agent = this.selectedAgent()): void {
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
