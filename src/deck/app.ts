import type { Component, TuiMouseEvent } from "@pi-herdr-deck/tui";
import { BridgeClient, type ClientConnectionStatus } from "../bridge/client.js";
import type {
  CommandArgsMap,
  CommandName,
  DeckState,
  DeliveryMode,
  ToolExpansionState,
  ToolStatus,
} from "../bridge/protocol.js";
import type { HerdrApi } from "../herdr/api.js";
import {
  type HitBox,
  PressReleaseTracker,
  renderButton,
  truncatePlain,
} from "./components/controls.js";

type DeckTab = "overview" | "tools";
type DropdownKind = "model" | "thinking" | "status";
type StatusFilter = "all" | ToolStatus;

interface FocusControl {
  id: string;
  disabled: boolean;
  activate(): void;
}

interface DropdownOption {
  key: string;
  label: string;
  activate(): void;
}

interface RowControl {
  id: string;
  label: string;
  disabled: boolean;
  activate(): void;
}

const STATUS_FILTERS: readonly StatusFilter[] = [
  "all",
  "pending",
  "running",
  "complete",
  "error",
  "unknown",
];

function isPrintableInput(data: string): boolean {
  return (
    data.length > 0 &&
    !data.includes("\x1b") &&
    [...data].every(
      (character) =>
        character === "\n" ||
        character === "\t" ||
        character.codePointAt(0)! >= 0x20,
    )
  );
}

function wrapPlain(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const normalized = text.replace(/\t/g, "  ");
  const sourceLines = normalized.split("\n");
  const lines: string[] = [];
  for (const source of sourceLines) {
    if (source.length === 0) {
      lines.push("");
      continue;
    }
    for (let offset = 0; offset < source.length; offset += width)
      lines.push(source.slice(offset, offset + width));
  }
  return lines.length > 0 ? lines : [""];
}

function contextBar(percent: number | null | undefined, width = 10): string {
  if (percent === null || percent === undefined) return `${"░".repeat(width)}`;
  const filled = Math.max(
    0,
    Math.min(width, Math.round((percent / 100) * width)),
  );
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function statusLabel(status: ClientConnectionStatus): string {
  if (status.kind === "connected") return `Connected to ${status.paneId}`;
  if (status.kind === "connecting")
    return `Connecting (attempt ${status.attempt})`;
  return "Disconnected";
}

export interface DeckAppOptions {
  client: BridgeClient;
  herdr: HerdrApi;
  targetPaneId: string;
  requestRender(): void;
  getHeight(): number;
}

export class DeckApp implements Component {
  readonly #client: BridgeClient;
  readonly #herdr: HerdrApi;
  readonly #targetPaneId: string;
  readonly #requestRender: () => void;
  readonly #getHeight: () => number;
  readonly #tracker = new PressReleaseTracker();
  readonly #unsubscribers: Array<() => void> = [];
  #tab: DeckTab = "overview";
  #state: DeckState | undefined;
  #connection: ClientConnectionStatus;
  #message = "";
  #notice = "";
  #dropdown: DropdownKind | undefined;
  #dropdownIndex = 0;
  #filter: StatusFilter = "all";
  #toolScroll = 0;
  #hitBoxes: HitBox[] = [];
  #focusControls: FocusControl[] = [];
  #focusedId = "tab:overview";

  constructor(options: DeckAppOptions) {
    this.#client = options.client;
    this.#herdr = options.herdr;
    this.#targetPaneId = options.targetPaneId;
    this.#requestRender = options.requestRender;
    this.#getHeight = options.getHeight;
    this.#connection = options.client.status;
    this.#state = options.client.state;
    if (this.#connection.kind === "disconnected")
      this.#notice = this.#connection.reason;
    this.#unsubscribers.push(
      options.client.onStatus((status) => {
        this.#connection = status;
        this.#notice = status.kind === "disconnected" ? status.reason : "";
        if (status.kind !== "connected") this.#dropdown = undefined;
        this.#requestRender();
      }),
    );
    this.#unsubscribers.push(
      options.client.onState((state) => {
        this.#state = state;
        this.#requestRender();
      }),
    );
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    this.#hitBoxes = [];
    this.#focusControls = [];
    const lines: string[] = [];
    lines.push(truncatePlain("Pi Deck", safeWidth));
    this.#addControlRow(
      lines,
      [
        {
          id: "tab:overview",
          label: "Overview",
          disabled: false,
          activate: () => this.#selectTab("overview"),
        },
        {
          id: "tab:tools",
          label: "Tools",
          disabled: false,
          activate: () => this.#selectTab("tools"),
        },
        {
          id: "focus-pi",
          label: "Focus Pi",
          disabled: false,
          activate: () => void this.#focusPi(),
        },
      ],
      safeWidth,
    );
    lines.push(
      truncatePlain(`Connection: ${statusLabel(this.#connection)}`, safeWidth),
    );
    if (this.#notice)
      lines.push(truncatePlain(`Notice: ${this.#notice}`, safeWidth));
    lines.push("");
    if (this.#tab === "overview") this.#renderOverview(lines, safeWidth);
    else this.#renderTools(lines, safeWidth);
    this.#normalizeFocus();
    const height = Math.max(1, this.#getHeight());
    if (lines.length < height)
      lines.push(...Array.from({ length: height - lines.length }, () => ""));
    return lines.slice(0, height).map((line) => truncatePlain(line, safeWidth));
  }

  handleInput(data: string): void {
    if (this.#dropdown) {
      if (data === "\x1b[A" || data === "k") this.#moveDropdown(-1);
      else if (data === "\x1b[B" || data === "j") this.#moveDropdown(1);
      else if (data === "\r" || data === "\n" || data === " ")
        this.#activateDropdownChoice();
      else if (data === "\x1b") this.#dropdown = undefined;
      this.#requestRender();
      return;
    }
    if (this.#focusedId === "message") {
      if (data === "\x1b") this.#focusedId = "send:normal";
      else if (data === "\x7f" || data === "\b")
        this.#message = this.#message.slice(0, -1);
      else if (data === "\x0a") this.#message += "\n";
      else if (data === "\t") this.#moveFocus(1);
      else if (data === "\x1b[Z") this.#moveFocus(-1);
      else if (isPrintableInput(data)) this.#message += data;
      this.#requestRender();
      return;
    }
    if (data === "\t") this.#moveFocus(1);
    else if (data === "\x1b[Z") this.#moveFocus(-1);
    else if (data === "\r" || data === "\n" || data === " ")
      this.#activateFocused();
    else if (data === "1") this.#selectTab("overview");
    else if (data === "2") this.#selectTab("tools");
    else if (data === "\x1b[C") this.#selectTab("tools");
    else if (data === "\x1b[D") this.#selectTab("overview");
    else if (data === "\x1b[A" && this.#tab === "tools")
      this.#toolScroll = Math.max(0, this.#toolScroll - 1);
    else if (data === "\x1b[B" && this.#tab === "tools") this.#toolScroll += 1;
    this.#requestRender();
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (event.type === "wheel") {
      if (this.#tab !== "tools") return false;
      this.#toolScroll = Math.max(
        0,
        this.#toolScroll + (event.direction === "down" ? 2 : -2),
      );
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

  #renderOverview(lines: string[], width: number): void {
    const state = this.#state;
    const connected = this.#client.connected && Boolean(state);
    const activity =
      !connected || !state
        ? "Unavailable"
        : state.activity === "working"
          ? "Working"
          : "Idle";
    lines.push(`State: ${activity}`);
    const modelName = state?.model?.name ?? state?.model?.id ?? "Unavailable";
    this.#addControlRow(
      lines,
      [
        {
          id: "model",
          label: `Model: ${modelName} ▼`,
          disabled: !connected || (state?.modelChoices.length ?? 0) === 0,
          activate: () => this.#openDropdown("model"),
        },
      ],
      width,
    );
    this.#addControlRow(
      lines,
      [
        {
          id: "thinking",
          label: `Thinking: ${state?.thinkingLevel ?? "Unavailable"} ▼`,
          disabled:
            !connected || (state?.allowedThinkingLevels.length ?? 0) === 0,
          activate: () => this.#openDropdown("thinking"),
        },
      ],
      width,
    );
    const percent = state?.context?.percent;
    const percentText =
      percent === null || percent === undefined
        ? "?"
        : `${Math.round(percent)}%`;
    lines.push(
      truncatePlain(
        `Context: ${percentText.padStart(4)}  ${contextBar(percent)}`,
        width,
      ),
    );
    lines.push(`Queue: ${state?.queuedMessage ? 1 : 0}`);
    this.#addControlRow(
      lines,
      [
        {
          id: "stop",
          label: "Stop",
          disabled: !connected || state?.activity !== "working",
          activate: () => void this.#command("abort", {}),
        },
        {
          id: "compact",
          label: "Compact",
          disabled: !connected || state?.activity !== "idle",
          activate: () => void this.#command("compact", {}),
        },
      ],
      width,
    );
    lines.push("");
    lines.push("Message:");
    this.#renderMessageEditor(lines, width, !connected);
    this.#addControlRow(
      lines,
      [
        {
          id: "send:normal",
          label: "Send",
          disabled:
            !connected ||
            state?.activity !== "idle" ||
            this.#message.trim().length === 0,
          activate: () => void this.#sendMessage("normal"),
        },
        {
          id: "send:steer",
          label: "Steer",
          disabled:
            !connected ||
            state?.activity !== "working" ||
            this.#message.trim().length === 0,
          activate: () => void this.#sendMessage("steer"),
        },
        {
          id: "send:followUp",
          label: "Follow-up",
          disabled:
            !connected ||
            state?.activity !== "working" ||
            this.#message.trim().length === 0,
          activate: () => void this.#sendMessage("followUp"),
        },
      ],
      width,
    );
    this.#renderDropdown(lines, width);
    if (state?.lastError)
      lines.push(truncatePlain(`Pi error: ${state.lastError}`, width));
  }

  #renderMessageEditor(
    lines: string[],
    width: number,
    disabled: boolean,
  ): void {
    const innerWidth = Math.max(1, width - 2);
    const wrapped = wrapPlain(this.#message, innerWidth).slice(-4);
    const topY = lines.length;
    lines.push(`┌${"─".repeat(innerWidth)}┐`);
    for (const line of wrapped) lines.push(`│${line.padEnd(innerWidth)}│`);
    lines.push(`└${"─".repeat(innerWidth)}┘`);
    const height = wrapped.length + 2;
    this.#hitBoxes.push({
      id: "message",
      x: 0,
      y: topY,
      width,
      height,
      disabled,
      activate: () => {
        this.#focusedId = "message";
      },
    });
    this.#focusControls.push({
      id: "message",
      disabled,
      activate: () => {
        this.#focusedId = "message";
      },
    });
  }

  #renderTools(lines: string[], width: number): void {
    const state = this.#state;
    const connected = this.#client.connected && Boolean(state);
    const tools = state?.tools ?? [];
    const expanded = tools.filter((tool) => tool.expanded).length;
    lines.push(`Expanded: ${expanded}/${tools.length}`);
    this.#addControlRow(
      lines,
      [
        {
          id: "turn-expand",
          label: "Turn Expand",
          disabled: !connected,
          activate: () => void this.#setGroup("currentTurn", true),
        },
        {
          id: "turn-collapse",
          label: "Turn Collapse",
          disabled: !connected,
          activate: () => void this.#setGroup("currentTurn", false),
        },
      ],
      width,
    );
    this.#addControlRow(
      lines,
      [
        {
          id: "session-expand",
          label: "Session Expand",
          disabled: !connected,
          activate: () => void this.#setGroup("session", true),
        },
        {
          id: "session-collapse",
          label: "Session Collapse",
          disabled: !connected,
          activate: () => void this.#setGroup("session", false),
        },
      ],
      width,
    );
    this.#addControlRow(
      lines,
      [
        {
          id: "status-filter",
          label: `Status: ${this.#filter} ▼`,
          disabled: !connected,
          activate: () => this.#openDropdown("status"),
        },
      ],
      width,
    );
    lines.push("");
    lines.push("Active tools:");
    for (const tool of state?.availableTools ?? []) {
      const active = state?.activeTools.includes(tool) ?? false;
      this.#addControlRow(
        lines,
        [
          {
            id: `active:${tool}`,
            label: `${active ? "☑" : "☐"} ${tool}`,
            disabled: !connected,
            activate: () => void this.#toggleActiveTool(tool),
          },
        ],
        width,
      );
    }
    lines.push("");
    lines.push("Tool calls:");
    const filtered = tools.filter(
      (tool) => this.#filter === "all" || tool.status === this.#filter,
    );
    const room = Math.max(1, this.#getHeight() - lines.length - 2);
    const maximumScroll = Math.max(0, filtered.length - room);
    this.#toolScroll = Math.min(this.#toolScroll, maximumScroll);
    for (const tool of filtered.slice(
      this.#toolScroll,
      this.#toolScroll + room,
    ))
      this.#renderToolRow(lines, width, tool, !connected);
    if (filtered.length === 0)
      lines.push(
        connected
          ? "No matching tool calls."
          : "Controls disabled while disconnected.",
      );
    this.#renderDropdown(lines, width);
  }

  #renderToolRow(
    lines: string[],
    width: number,
    tool: ToolExpansionState,
    disabled: boolean,
  ): void {
    const caret = tool.expanded ? "▼" : "▶";
    const label = `${caret} ${tool.name}  ${tool.status}  turn ${tool.turnIndex}`;
    const y = lines.length;
    lines.push(truncatePlain(label, width));
    const id = `expand:${tool.id}`;
    const activate = (): void =>
      void this.#command("setToolExpanded", {
        toolCallId: tool.id,
        expanded: !tool.expanded,
      });
    this.#hitBoxes.push({
      id,
      x: 0,
      y,
      width: 1,
      height: 1,
      disabled,
      activate,
    });
    this.#focusControls.push({ id, disabled, activate });
  }

  #renderDropdown(lines: string[], width: number): void {
    if (!this.#dropdown) return;
    const options = this.#dropdownOptions();
    if (options.length === 0) return;
    lines.push("");
    lines.push(
      `${this.#dropdown[0]!.toUpperCase()}${this.#dropdown.slice(1)} choices:`,
    );
    for (const [index, option] of options.entries()) {
      const label = `${index === this.#dropdownIndex ? ">" : " "} ${option.label}`;
      const y = lines.length;
      lines.push(truncatePlain(label, width));
      this.#hitBoxes.push({
        id: `dropdown:${index}`,
        x: 0,
        y,
        width: Math.min(width, label.length),
        height: 1,
        disabled: false,
        activate: () => {
          this.#dropdownIndex = index;
          this.#activateDropdownChoice();
        },
      });
    }
  }

  #dropdownOptions(): DropdownOption[] {
    const state = this.#state;
    if (this.#dropdown === "model") {
      return (state?.modelChoices ?? []).map((model) => ({
        key: `${model.provider}\0${model.id}`,
        label: `${model.provider}/${model.id}${model.name !== model.id ? ` — ${model.name}` : ""}`,
        activate: () =>
          void this.#command("setModel", {
            provider: model.provider,
            modelId: model.id,
          }),
      }));
    }
    if (this.#dropdown === "thinking") {
      return (state?.allowedThinkingLevels ?? []).map((level) => ({
        key: level,
        label: level,
        activate: () => void this.#command("setThinkingLevel", { level }),
      }));
    }
    if (this.#dropdown === "status") {
      return STATUS_FILTERS.map((filter) => ({
        key: filter,
        label: filter,
        activate: () => {
          this.#filter = filter;
          this.#toolScroll = 0;
        },
      }));
    }
    return [];
  }

  #addControlRow(lines: string[], controls: RowControl[], width: number): void {
    let line = "";
    const y = lines.length;
    for (const control of controls) {
      if (line.length > 0) line += " ";
      const x = line.length;
      const focused = this.#focusedId === control.id;
      const rendered = renderButton(control.label, {
        disabled: control.disabled,
        focused,
      });
      line += rendered;
      this.#hitBoxes.push({
        id: control.id,
        x,
        y,
        width: rendered.length,
        height: 1,
        disabled: control.disabled,
        activate: control.activate,
      });
      this.#focusControls.push({
        id: control.id,
        disabled: control.disabled,
        activate: control.activate,
      });
    }
    lines.push(truncatePlain(line, width));
  }

  #normalizeFocus(): void {
    const current = this.#focusControls.find(
      (control) => control.id === this.#focusedId && !control.disabled,
    );
    if (current) return;
    this.#focusedId =
      this.#focusControls.find((control) => !control.disabled)?.id ?? "";
  }

  #moveFocus(direction: 1 | -1): void {
    const enabled = this.#focusControls.filter((control) => !control.disabled);
    if (enabled.length === 0) return;
    const current = enabled.findIndex(
      (control) => control.id === this.#focusedId,
    );
    const next =
      current < 0 ? 0 : (current + direction + enabled.length) % enabled.length;
    this.#focusedId = enabled[next]!.id;
  }

  #activateFocused(): void {
    this.#focusControls
      .find((control) => control.id === this.#focusedId && !control.disabled)
      ?.activate();
  }

  #selectTab(tab: DeckTab): void {
    this.#tab = tab;
    this.#dropdown = undefined;
    this.#focusedId = `tab:${tab}`;
    this.#requestRender();
  }

  #openDropdown(kind: DropdownKind): void {
    this.#dropdown = kind;
    const options = this.#dropdownOptions();
    const selectedKey =
      kind === "status"
        ? this.#filter
        : kind === "thinking"
          ? this.#state?.thinkingLevel
          : this.#state?.model
            ? `${this.#state.model.provider}\0${this.#state.model.id}`
            : undefined;
    this.#dropdownIndex = Math.max(
      0,
      options.findIndex((option) => option.key === selectedKey),
    );
    this.#requestRender();
  }

  #moveDropdown(delta: number): void {
    const length = this.#dropdownOptions().length;
    if (length === 0) return;
    this.#dropdownIndex = (this.#dropdownIndex + delta + length) % length;
  }

  #activateDropdownChoice(): void {
    const choice = this.#dropdownOptions()[this.#dropdownIndex];
    this.#dropdown = undefined;
    choice?.activate();
    this.#requestRender();
  }

  async #command<N extends CommandName>(
    name: N,
    args: CommandArgsMap[N],
  ): Promise<boolean> {
    if (!this.#client.connected) {
      this.#notice = "Disconnected; command not queued.";
      this.#requestRender();
      return false;
    }
    try {
      await this.#client.send(name, args);
      this.#notice = "";
      this.#requestRender();
      return true;
    } catch (error) {
      this.#notice = error instanceof Error ? error.message : "Command failed.";
      this.#requestRender();
      return false;
    }
  }

  async #sendMessage(delivery: DeliveryMode): Promise<void> {
    const message = this.#message;
    if (message.trim().length === 0) return;
    if (await this.#command("sendUserMessage", { message, delivery })) {
      this.#message = "";
      this.#requestRender();
    }
  }

  async #setGroup(
    scope: "currentTurn" | "session",
    expanded: boolean,
  ): Promise<void> {
    await this.#command("setToolGroupExpanded", { scope, expanded });
  }

  async #toggleActiveTool(tool: string): Promise<void> {
    const state = this.#state;
    if (!state) return;
    const active = state.activeTools.includes(tool);
    const tools = active
      ? state.activeTools.filter((name) => name !== tool)
      : [...state.activeTools, tool];
    await this.#command("setActiveTools", { tools });
  }

  async #focusPi(): Promise<void> {
    try {
      await this.#herdr.focusPane(this.#targetPaneId);
      this.#notice = "Focused Pi pane.";
    } catch (error) {
      this.#notice =
        error instanceof Error ? error.message : "Could not focus Pi pane.";
    }
    this.#requestRender();
  }
}
