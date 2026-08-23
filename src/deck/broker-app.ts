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
import { visibleSurfaceSignature } from "./render-dependencies.js";
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
import { normalizeFilesPresentation } from "./files-screen.js";
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
import { renderHeader, adoptedScopeLabel } from "./shell/header.js";
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

function safeTerminalText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "�");
}

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
  #selectedResult: string | undefined;
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
  #filesFilter = "";
  #filesHidden = false;
  #filesPath = "";
  #filesScroll = 0;
  #filesPreviewScroll = 0;
  #filesWheelDetached = false;
  #filesTreeRegion: { start: number; end: number } | undefined;
  #filesPreviewRegion: { start: number; end: number } | undefined;
  #filesPreviewPath: string | undefined;
  #boardTab: "inbox" | "updates" | "decisions" | "history" = "inbox";
  #boardSelection: string | undefined;
  #unifiedBoardSelection: string | undefined;
  #boardFilter: BoardFilter = "all-current";
  #boardScroll = 0;
  #boardWheelDetached = false;
  #activitySelection: string | undefined;
  #activityFilter: ActivityFilter = "all";
  #activityScroll = 0;
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
      this.headerPresentation(state),
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
      else if (
        this.#tab === "files" &&
        this.#filesTreeRegion &&
        event.y >= this.#filesTreeRegion.start &&
        event.y <= this.#filesTreeRegion.end
      ) {
        this.#filesWheelDetached = true;
        this.#filesScroll = Math.max(0, this.#filesScroll + delta);
      } else if (this.#tab === "files") return false;
      else if (this.#tab === "board") {
        this.#boardWheelDetached = true;
        this.#boardScroll = Math.max(0, this.#boardScroll + delta);
      } else if (this.#tab === "activity")
        this.#activityScroll = Math.max(0, this.#activityScroll + delta);
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
    const overlay = this.#overlay;
    return visibleSurfaceSignature(state, {
      tab: this.#tab,
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
    this.#requestRender();
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

  private openAgentMore(): void {
    const agent = this.selectedAgent();
    if (!agent) return;
    this.#overlay = {
      kind: "agent-more",
      guard: { agentId: agent.id, generation: agent.generation },
      focus: "primary",
      scroll: 0,
      pending: false,
    };
    this.#tracker.reset();
  }

  private headerPresentation(state: DeckState) {
    const scope = selectAdoptedScope(state, this.#targetPaneId);
    const root = this.adoptedRootAgent();
    const model = selectUnifiedBoardPresentation(
      state,
      this.#targetPaneId,
      this.#unifiedBoardSelection,
      "attention",
    );
    return {
      productName: "AGENT BOARD" as const,
      scopeLabel: adoptedScopeLabel(
        root?.displayName ?? root?.herdrName,
        scope.state.agents.size,
      ),
      attentionCount: model.counts.attention,
      online: this.#status === "connected",
      selectedTab: this.#tab,
    };
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
      this.#filesFilter = value;
      this.#filesScroll = 0;
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
    for (const [index, item] of visible.entries()) {
      const y = start + 4 + index * 2;
      this.addHitBox(`agent:row:${item.id}`, y, width, () => {
        this.#selectedAgent = item.id;
      });
    }
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
          activate: () => this.confirmAgentStop(),
        },
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
          id: "agent:more",
          label: "More…",
          disabled: !agent,
          activate: () => {
            this.openAgentMore();
          },
        },
      ],
      width,
    );
  }

  private selectActivityItem(item: ActivityItem): void {
    this.#activitySelection = item.id;
    if (item.kind === "result") this.#selectedResult = item.source.id;
    else if (item.kind === "terminal-task") this.#selectedTask = item.source.id;
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
    const model = selectActivityPresentation(
      state,
      this.#targetPaneId,
      this.#activitySelection,
      this.#activityFilter,
      this.#client.store.notifications,
    );
    lines.push("ACTIVITY  Results · decisions · updates · groups · lifecycle");
    this.addControlRow(
      lines,
      (["all", "results", "signals", "agents", "errors"] as const).map(
        (filter) => ({
          id: `activity:filter:${filter}`,
          label: this.#activityFilter === filter ? `[${filter}]` : filter,
          activate: () => {
            this.#activityFilter = filter;
            this.#activityScroll = 0;
          },
        }),
      ),
      width,
    );
    lines.push(`${model.items.length} retained events`);
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
      else if (model.selected.kind === "terminal-task")
        lines.push(
          ...renderTaskDetail(
            model.selected.source,
            this.scopedWorkState(state),
            width,
          ),
        );
      else if (model.selected.kind === "terminal-group")
        lines.push(...renderGroupDetail(model.selected.source, width));
      else lines.push(model.selected.summary);
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
    if (folder)
      void this.runFiles("expand", this.#filesPath, row.expanded !== true);
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
    const presentation = normalizeFilesPresentation(files);
    const view: Record<string, unknown> = {
      currentPath: presentation.currentPath,
      filter: presentation.filter,
      showHidden: presentation.showHidden,
      ...(presentation.preview
        ? {
            previewPath: presentation.preview.path,
            preview: presentation.preview,
          }
        : {}),
    };
    const summary: Record<string, unknown> = {
      cwd: presentation.cwd,
      currentPath: presentation.currentPath,
      selectedCount: presentation.selectedCount,
      showHidden: presentation.showHidden,
      selectedKnownBytes: presentation.selectedKnownBytes,
      selectedApproximateTokens: presentation.selectedApproximateTokens,
      limits: presentation.limits,
    };
    const rows: Record<string, unknown>[] = presentation.rows.map((row) => ({
      ...row,
    }));
    const cwd = presentation.cwd;
    const currentPath = presentation.currentPath || ".";
    lines.push(
      "FILES",
      `${files?.available ? "● READY" : "○ CONNECTING"}  ${cwd || "Waiting for the Pi Files provider…"}`,
    );
    lines.push(
      `⌂ /${currentPath === "." ? "" : currentPath}   ${String(summary.selectedCount ?? 0)} selected   ${String(view.filter ?? "") ? `filter: ${String(view.filter)}` : "no filter"}   hidden ${summary.showHidden === true || view.showHidden === true ? "on" : "off"}   ${Number(summary.selectedApproximateTokens ?? 0)} approx tokens`,
      "TREE",
    );
    const visible = rows;
    const rowBudget = Math.max(3, this.#getHeight() - lines.length - 12);
    const selectedIndex = visible.findIndex(
      (row) => String(row.path ?? "") === this.#filesPath,
    );
    if (selectedIndex >= 0 && !this.#filesWheelDetached) {
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
        `${prefix}${safeTerminalText(row.name ?? path)}${row.error ? `  ! ${safeTerminalText(row.error)}` : ""}`,
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
            this.#filesWheelDetached = false;
            void this.runFiles("expand", path, row.expanded !== true);
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
          this.#filesWheelDetached = false;
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
          this.#filesWheelDetached = false;
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
        `PREVIEW  ${String(view.previewPath ?? this.#filesPreviewPath ?? this.#filesPath)}`,
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
      for (const [offset, line] of previewLines
        .slice(this.#filesPreviewScroll, this.#filesPreviewScroll + 8)
        .entries())
        lines.push(
          `│ ${String(this.#filesPreviewScroll + offset + 1).padStart(4)} ${safeTerminalText(line)}`,
        );
      if (previewLines.length > 8)
        lines.push(
          `  ↕ preview ${this.#filesPreviewScroll + 1}-${Math.min(previewLines.length, this.#filesPreviewScroll + 8)} of ${previewLines.length}`,
        );
      if (preview.error) lines.push(`! ${safeTerminalText(preview.error)}`);
      this.#filesPreviewRegion = {
        start: previewStart,
        end: Math.max(previewStart, lines.length - 1),
      };
    }
    if (files?.error && !(files.available && rows.length > 0))
      lines.push("", `! ${safeTerminalText(files.error)}`);
    lines.push(
      "",
      `/ filter${String(view.filter ?? "") ? `: ${String(view.filter)}` : ""}  •  h hidden ${summary.showHidden === true || view.showHidden === true ? "on" : "off"}  •  Enter primary action`,
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
        this.#filesWheelDetached = false;
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
    try {
      await this.run("copyId");
    } catch {
      /* run reports the visible failure */
    }
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
