import { truncateToWidth, visibleWidth } from "@pi-herdr-deck/tui";
import type { HitBox } from "./components/controls.js";
import { renderButton } from "./components/controls.js";
import type { RenderedSurface, SurfaceRegion } from "./screen-types.js";

export interface GeometryButton {
  id: string;
  label: string;
  disabled?: boolean;
  focused?: boolean;
  activate(): void;
}

export class SurfaceBuilder {
  readonly #width: number;
  readonly #ids = new Set<string>();
  readonly lines: string[] = [];
  readonly hitBoxes: HitBox[] = [];
  readonly regions: SurfaceRegion[] = [];

  constructor(width: number) {
    this.#width = Math.max(1, width);
  }

  get width(): number {
    return this.#width;
  }

  addLine(text = ""): number {
    const y = this.lines.length;
    this.lines.push(
      visibleWidth(text) <= this.#width
        ? text
        : `${truncateToWidth(text, Math.max(0, this.#width - 1))}…`,
    );
    return y;
  }

  addRow(
    id: string,
    text: string,
    activate: () => void,
    options: { disabled?: boolean; x?: number; width?: number } = {},
  ): number {
    const y = this.addLine(text);
    const x = Math.max(0, options.x ?? 0);
    const width = Math.max(
      0,
      Math.min(options.width ?? this.#width - x, this.#width - x),
    );
    this.addHitBox({
      id,
      x,
      y,
      width,
      height: 1,
      disabled: options.disabled === true,
      activate,
    });
    return y;
  }

  addButtons(buttons: readonly GeometryButton[]): void {
    let line = "";
    let entries: Array<{ button: GeometryButton; x: number; width: number }> =
      [];
    const flush = () => {
      if (entries.length === 0) return;
      const y = this.addLine(line);
      for (const entry of entries)
        this.addHitBox({
          id: entry.button.id,
          x: entry.x,
          y,
          width: entry.width,
          height: 1,
          disabled: entry.button.disabled === true,
          activate: entry.button.activate,
        });
      line = "";
      entries = [];
    };
    for (const button of buttons) {
      const rendered = renderButton(button.label, {
        ...(button.disabled === undefined ? {} : { disabled: button.disabled }),
        ...(button.focused === undefined ? {} : { focused: button.focused }),
      });
      const renderedWidth = visibleWidth(rendered);
      const separator = line ? " " : "";
      if (line && visibleWidth(line) + 1 + renderedWidth > this.#width) flush();
      const x = visibleWidth(line) + (line ? 1 : 0);
      line += `${line ? separator : ""}${rendered}`;
      entries.push({
        button,
        x,
        width: Math.min(renderedWidth, this.#width - x),
      });
    }
    flush();
  }

  addRegion(region: SurfaceRegion): void {
    this.unique(region.id);
    const x = Math.max(0, region.x);
    const y = Math.max(0, region.y);
    const width = Math.max(0, Math.min(region.width, this.#width - x));
    if (width === 0 || region.height <= 0) return;
    this.regions.push({ ...region, x, y, width });
  }

  addHitBox(box: HitBox): void {
    this.unique(box.id);
    if (box.width <= 0 || box.height <= 0) return;
    this.hitBoxes.push(box);
  }

  finish<S>(
    options: {
      correctedState?: S;
      effectiveSelectedId?: string;
    } = {},
  ): RenderedSurface<S> {
    return {
      lines: this.lines,
      hitBoxes: this.hitBoxes,
      regions: this.regions,
      ...(options.correctedState === undefined
        ? {}
        : { correctedState: options.correctedState }),
      ...(options.effectiveSelectedId === undefined
        ? {}
        : { effectiveSelectedId: options.effectiveSelectedId }),
    };
  }

  private unique(id: string): void {
    if (this.#ids.has(id))
      throw new Error(`Duplicate surface geometry ID: ${id}`);
    this.#ids.add(id);
  }
}

export function composeColumns(
  left: RenderedSurface,
  right: RenderedSurface,
  leftWidth: number,
  rightWidth: number,
  separator = "│",
): RenderedSurface {
  const lines: string[] = [];
  const height = Math.max(left.lines.length, right.lines.length);
  for (let y = 0; y < height; y += 1) {
    const leftLine = truncateToWidth(left.lines[y] ?? "", leftWidth);
    const rightLine = truncateToWidth(right.lines[y] ?? "", rightWidth);
    lines.push(
      `${leftLine}${" ".repeat(Math.max(0, leftWidth - visibleWidth(leftLine)))}${separator}${rightLine}`,
    );
  }
  const rightOffset = leftWidth + visibleWidth(separator);
  return {
    lines,
    hitBoxes: [
      ...left.hitBoxes,
      ...right.hitBoxes.map((box) => ({ ...box, x: box.x + rightOffset })),
    ],
    regions: [
      ...left.regions,
      ...right.regions.map((region) => ({
        ...region,
        x: region.x + rightOffset,
      })),
    ],
  };
}
