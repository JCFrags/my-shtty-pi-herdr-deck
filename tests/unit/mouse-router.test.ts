import assert from "node:assert/strict";
import test from "node:test";
import {
  installMouseRouter,
  parseSgrMouse,
  MOUSE_DISABLE_BYTES,
  MOUSE_ENABLE_BYTES,
} from "../../src/deck/mouse-router.js";

test("parses SGR press, release, motion, and wheel events", () => {
  assert.deepEqual(parseSgrMouse("\x1b[<0;4;6M"), {
    type: "press",
    button: "left",
    x: 3,
    y: 5,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.equal(parseSgrMouse("\x1b[<64;2;3M")?.type, "wheel");
  assert.equal(parseSgrMouse("\x1b[<32;2;3M")?.type, "move");
  assert.equal(parseSgrMouse("\x1b[<0;4;6m")?.type, "release");
  assert.equal(parseSgrMouse("\x1b[<0;0;1M"), undefined);
});

test("routes real input and disables reporting exactly once on close", () => {
  const listeners = new Set<(chunk: Buffer) => void>();
  const writes: string[] = [];
  const input = {
    on: (_event: "data", listener: (chunk: Buffer) => void) => {
      listeners.add(listener);
      return input;
    },
    off: (_event: "data", listener: (chunk: Buffer) => void) => {
      listeners.delete(listener);
      return input;
    },
  };
  const events: unknown[] = [];
  const router = installMouseRouter(
    input,
    {
      write: (bytes: string) => {
        writes.push(bytes);
        return true;
      },
    },
    (event) => {
      events.push(event);
      return true;
    },
  );
  assert.equal(writes[0], MOUSE_ENABLE_BYTES);
  for (const listener of listeners)
    listener(Buffer.from("\x1b[<0;5;7M\x1b[<0;5;7m"));
  assert.equal(events.length, 2);
  router.close();
  router.close();
  assert.deepEqual(writes, [MOUSE_ENABLE_BYTES, MOUSE_DISABLE_BYTES]);
  assert.equal(listeners.size, 0);
});
