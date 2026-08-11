import assert from "node:assert/strict";
import test from "node:test";
import { validatePiSessionReference } from "../../src/broker/broker.js";
import { piHerdrSessionReference } from "../../extensions/pi-herdr-orchestrator.js";
import type { PiContextLike } from "../../src/pi/types.js";

const base = {
  source: "herdr:pi",
  agent: "pi",
  kind: "path",
  value: "/home/test/.pi/sessions/exact.jsonl",
} as const;

test("Pi sender prefers the official path and falls back to the durable ID", () => {
  const context = {
    sessionManager: {
      getSessionFile: () => "/home/test/.pi/sessions/exact.jsonl",
      getSessionId: () => "durable-id",
    },
  } as PiContextLike;
  assert.deepEqual(piHerdrSessionReference(context), base);
  context.sessionManager.getSessionFile = () => undefined;
  assert.deepEqual(piHerdrSessionReference(context), {
    source: "herdr:pi",
    agent: "pi",
    kind: "id",
    value: "durable-id",
  });
});

test("Pi sender rejects unsafe references before registration", () => {
  for (const value of [
    "relative.jsonl",
    "/tmp/control\n",
    `/${"é".repeat(2048)}`,
  ])
    assert.throws(
      () =>
        piHerdrSessionReference({
          sessionManager: {
            getSessionFile: () => value,
            getSessionId: () => "durable-id",
          },
        } as PiContextLike),
      /PI_SESSION_REFERENCE_INVALID/,
    );
});

test("Pi session reference accepts exact official path and ID forms", () => {
  assert.deepEqual(validatePiSessionReference(base), base);
  const id = { ...base, kind: "id", value: "session-id-1" } as const;
  assert.deepEqual(validatePiSessionReference(id), id);
});

test("Pi session reference rejects missing, changed, relative, control, and overlong values", () => {
  const privateValue = "private-value-that-must-not-be-echoed";
  for (const value of [
    undefined,
    { ...base, source: "wrong" },
    { ...base, agent: "wrong" },
    { ...base, kind: "wrong" },
    { ...base, value: `relative/${privateValue}` },
    { ...base, value: `/tmp/${privateValue}\n` },
    { ...base, extra: true },
    { ...base, kind: "id", value: "é".repeat(129) },
    { ...base, value: `/${"é".repeat(2048)}` },
  ])
    assert.throws(
      () => validatePiSessionReference(value),
      (error: unknown) =>
        error instanceof Error && !error.message.includes(privateValue),
    );
});
