import type { Writable } from "node:stream";
import type { TuiMouseEvent } from "@pi-herdr-deck/tui";

const ENABLE = "\x1b[?1002h\x1b[?1006h";
const DISABLE = "\x1b[?1002l\x1b[?1006l";
const MAX_BUFFER = 4096;
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/y;

type Input = {
  on(event: "data", listener: (chunk: Buffer | string) => void): Input;
  off(event: "data", listener: (chunk: Buffer | string) => void): Input;
};

export function parseSgrMouse(input: string): TuiMouseEvent | undefined {
  SGR_MOUSE.lastIndex = 0;
  const match = SGR_MOUSE.exec(input);
  if (!match || match[0].length !== input.length) return undefined;
  const code = Number(match[1]);
  const x = Number(match[2]) - 1;
  const y = Number(match[3]) - 1;
  if (
    !Number.isSafeInteger(code) ||
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    x < 0 ||
    y < 0
  )
    return undefined;
  const wheel = code & 64;
  const buttonCode = code & 3;
  const button =
    buttonCode === 0
      ? "left"
      : buttonCode === 1
        ? "middle"
        : buttonCode === 2
          ? "right"
          : undefined;
  return {
    type: wheel
      ? "wheel"
      : code & 32
        ? "move"
        : match[4] === "M"
          ? "press"
          : "release",
    ...(wheel
      ? { direction: code & 1 ? "down" : "up" }
      : { button: button ?? "left" }),
    x,
    y,
    shift: Boolean(code & 4),
    alt: Boolean(code & 8),
    ctrl: Boolean(code & 16),
  } as TuiMouseEvent;
}

export interface MouseRouter {
  close(): void;
}

export function installMouseRouter(
  input: Input,
  output: Pick<Writable, "write">,
  handle: (event: TuiMouseEvent) => boolean,
): MouseRouter {
  let buffer = "";
  let closed = false;
  const onData = (chunk: Buffer | string): void => {
    if (closed) return;
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
    while (true) {
      const start = buffer.indexOf("\x1b[<");
      if (start < 0) {
        buffer = buffer.slice(-3);
        return;
      }
      if (start > 0) buffer = buffer.slice(start);
      const end = buffer.search(/[Mm]/);
      if (end < 0) return;
      const candidate = buffer.slice(0, end + 1);
      const event = parseSgrMouse(candidate);
      buffer = buffer.slice(end + 1);
      if (event) handle(event);
    }
  };
  output.write(ENABLE);
  input.on("data", onData);
  return {
    close(): void {
      if (closed) return;
      closed = true;
      input.off("data", onData);
      output.write(DISABLE);
      buffer = "";
    },
  };
}

export const MOUSE_ENABLE_BYTES = ENABLE;
export const MOUSE_DISABLE_BYTES = DISABLE;
