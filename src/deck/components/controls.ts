import type { TuiMouseEvent } from "@pi-herdr-deck/tui";

export interface HitBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  disabled: boolean;
  activate(): void;
}

export function hitTest(
  boxes: readonly HitBox[],
  x: number,
  y: number,
): HitBox | undefined {
  return boxes.find(
    (box) =>
      x >= box.x &&
      x < box.x + box.width &&
      y >= box.y &&
      y < box.y + box.height,
  );
}

export class PressReleaseTracker {
  #pressedId: string | undefined;
  #pressX = 0;
  #pressY = 0;
  #dragged = false;

  reset(): void {
    this.#pressedId = undefined;
    this.#dragged = false;
  }

  handle(event: TuiMouseEvent, boxes: readonly HitBox[]): boolean {
    if (event.type === "wheel") return false;
    if (event.button !== "left") return false;
    if (event.type === "press") {
      const box = hitTest(boxes, event.x, event.y);
      this.#pressedId = box?.id;
      this.#pressX = event.x;
      this.#pressY = event.y;
      this.#dragged = false;
      return Boolean(box);
    }
    if (event.type === "move") {
      if (!this.#pressedId) return false;
      if (event.x !== this.#pressX || event.y !== this.#pressY)
        this.#dragged = true;
      return true;
    }
    const pressedId = this.#pressedId;
    this.#pressedId = undefined;
    const dragged = this.#dragged;
    this.#dragged = false;
    if (!pressedId) return false;
    const box = hitTest(boxes, event.x, event.y);
    if (!dragged && box?.id === pressedId && !box.disabled) box.activate();
    return true;
  }
}

export function renderButton(
  label: string,
  options: { disabled?: boolean; focused?: boolean } = {},
): string {
  const wrapped = `[${label}]`;
  if (options.disabled) return `(${label})`;
  return options.focused ? `>${wrapped}<` : wrapped;
}

export function truncatePlain(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}
