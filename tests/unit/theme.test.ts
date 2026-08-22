import assert from "node:assert/strict";
import test from "node:test";
import {
  paint,
  styleLine,
  styleLines,
  toneForLine,
} from "../../src/deck/theme.js";

test("theme styles semantic lines without changing plain content", () => {
  const plain = "AGENT BOARD · healthy";
  const styled = styleLine(plain, true);
  assert.match(styled, /\u001b\[/);
  assert.equal(toneForLine(plain), "heading");
  assert.deepEqual(styleLines(["x", "y"], false), ["x", "y"]);
});

test("theme gives selected rows and controls distinct semantic tones", () => {
  assert.equal(toneForLine("> task-1 · Build"), "selected");
  assert.equal(toneForLine("(Refresh) (Clear)"), "button");
  assert.match(paint("connected", "healthy", true), /\u001b\[/);
});

test("NO_COLOR path emits no ANSI escape sequences", () => {
  const lines = styleLines(
    ["Pi Herd", "AGENT BOARD · healthy", "> selected"],
    false,
  );
  assert.deepEqual(lines, ["Pi Herd", "AGENT BOARD · healthy", "> selected"]);
  assert.equal(styleLine("error: failed", false), "error: failed");
});
