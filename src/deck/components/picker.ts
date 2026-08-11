import type { Component, TuiMouseEvent } from "@pi-herdr-deck/tui";
import type { HerdrAgentInfo } from "../../herdr/context.js";
import {
  type HitBox,
  PressReleaseTracker,
  renderButton,
  truncatePlain,
} from "./controls.js";

export class PanePicker implements Component {
  readonly #agents: HerdrAgentInfo[];
  readonly #reason: string;
  readonly #onSelect: (agent: HerdrAgentInfo) => void;
  readonly #onCancel: () => void;
  readonly #requestRender: () => void;
  #selected = 0;
  #boxes: HitBox[] = [];
  #tracker = new PressReleaseTracker();

  constructor(options: {
    agents: HerdrAgentInfo[];
    reason: string;
    onSelect(agent: HerdrAgentInfo): void;
    onCancel(): void;
    requestRender(): void;
  }) {
    this.#agents = options.agents;
    this.#reason = options.reason;
    this.#onSelect = options.onSelect;
    this.#onCancel = options.onCancel;
    this.#requestRender = options.requestRender;
  }

  render(width: number): string[] {
    this.#boxes = [];
    const lines = ["Pi Deck", "", truncatePlain(this.#reason, width), ""];
    for (const [index, agent] of this.#agents.entries()) {
      const marker = index === this.#selected ? ">" : " ";
      const label = `${marker} ${agent.name ?? agent.displayAgent ?? agent.agent ?? "Pi"}  ${agent.paneId}`;
      const y = lines.length;
      lines.push(truncatePlain(label, width));
      this.#boxes.push({
        id: `agent:${agent.paneId}`,
        x: 0,
        y,
        width: Math.max(1, Math.min(width, label.length)),
        height: 1,
        disabled: false,
        activate: () => {
          this.#selected = index;
          this.#onSelect(agent);
        },
      });
    }
    const openButton = renderButton("Open", { focused: true });
    const cancelButton = renderButton("Cancel");
    lines.push(
      "",
      `${openButton} ${cancelButton}`,
      "",
      "↑/↓ select · Enter open · Esc cancel",
    );
    const buttonY = lines.length - 3;
    this.#boxes.push({
      id: "open",
      x: 0,
      y: buttonY,
      width: openButton.length,
      height: 1,
      disabled: false,
      activate: () => this.#activate(),
    });
    this.#boxes.push({
      id: "cancel",
      x: openButton.length + 1,
      y: buttonY,
      width: cancelButton.length,
      height: 1,
      disabled: false,
      activate: this.#onCancel,
    });
    return lines;
  }

  handleInput(data: string): void {
    if (data === "\x1b[A" || data === "k")
      this.#selected = Math.max(0, this.#selected - 1);
    else if (data === "\x1b[B" || data === "j")
      this.#selected = Math.min(this.#agents.length - 1, this.#selected + 1);
    else if (data === "\r" || data === "\n") this.#activate();
    else if (data === "\x1b" || data === "q") this.#onCancel();
    this.#requestRender();
  }

  handleMouse(event: TuiMouseEvent): boolean {
    const handled = this.#tracker.handle(event, this.#boxes);
    if (handled) this.#requestRender();
    return handled;
  }

  invalidate(): void {
    this.#requestRender();
  }

  #activate(): void {
    const agent = this.#agents[this.#selected];
    if (agent) this.#onSelect(agent);
  }
}
