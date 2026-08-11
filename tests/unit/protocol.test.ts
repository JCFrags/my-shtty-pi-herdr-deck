import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  encodeFrame,
  MAX_LINE_BYTES,
  NdjsonDecoder,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  validateCommandFrame,
  validateDeckState,
  validateServerFrame,
  type CommandFrame,
  type HelloFrame,
  type StateFrame,
} from "../../src/bridge/protocol.js";
import { baseState } from "../helpers.js";

const commands: CommandFrame[] = [
  { type: "command", id: "1", name: "abort", args: {} },
  { type: "command", id: "2", name: "compact", args: {} },
  {
    type: "command",
    id: "3",
    name: "sendUserMessage",
    args: { message: "hello", delivery: "normal" },
  },
  {
    type: "command",
    id: "4",
    name: "setThinkingLevel",
    args: { level: "high" },
  },
  {
    type: "command",
    id: "5",
    name: "setModel",
    args: { provider: "p", modelId: "m" },
  },
  {
    type: "command",
    id: "6",
    name: "setActiveTools",
    args: { tools: ["read"] },
  },
  {
    type: "command",
    id: "7",
    name: "setToolExpanded",
    args: { toolCallId: "call", expanded: true },
  },
  {
    type: "command",
    id: "8",
    name: "setToolGroupExpanded",
    args: { scope: "currentTurn", expanded: false },
  },
  { type: "command", id: "9", name: "refreshState", args: {} },
];

test("protocol encodes and validates every command envelope", () => {
  for (const command of commands) {
    const line = encodeFrame(command).toString("utf8").trimEnd();
    assert.deepEqual(validateCommandFrame(JSON.parse(line)), command);
  }
});

test("encoder runtime-validates outbound frames and rejects non-JSON result values", () => {
  assert.throws(
    () =>
      encodeFrame({
        type: "command",
        id: "x",
        name: "sendUserMessage",
        args: { message: "   ", delivery: "normal" },
      } as CommandFrame),
    /must not be empty/,
  );
  assert.throws(
    () =>
      encodeFrame({
        type: "result",
        id: "x",
        ok: true,
        value: undefined,
      } as never),
    /JSON-compatible/,
  );
  assert.throws(
    () =>
      encodeFrame({
        type: "result",
        id: "x",
        ok: true,
        value: Number.NaN,
      } as never),
    /finite numbers/,
  );
  assert.equal(
    encodeFrame({ type: "result", id: "x", ok: true, value: null }).toString(
      "utf8",
    ),
    '{"type":"result","id":"x","ok":true,"value":null}\n',
  );
});

test("protocol rejects malformed JSON, unknown commands, extra fields, and empty messages", () => {
  const decoder = new NdjsonDecoder(validateCommandFrame);
  const malformed = decoder.push("{not-json}\n");
  assert.equal(malformed[0]?.ok, false);
  if (!malformed[0]?.ok)
    assert.equal(malformed[0].error.code, "malformed_json");
  assert.throws(
    () =>
      validateCommandFrame({
        type: "command",
        id: "x",
        name: "shell",
        args: {},
      }),
    (error: unknown) =>
      error instanceof ProtocolValidationError &&
      error.code === "unknown_command",
  );
  assert.throws(
    () =>
      validateCommandFrame({
        type: "command",
        id: "x",
        name: "abort",
        args: {},
        shell: "rm -rf /",
      }),
    /unknown fields/,
  );
  assert.throws(
    () =>
      validateCommandFrame({
        type: "command",
        id: "x",
        name: "sendUserMessage",
        args: { message: "   ", delivery: "normal" },
      }),
    /must not be empty/,
  );
});

test("command tool names reject control characters before execution", () => {
  for (const value of [
    `unknown${String.fromCharCode(0x01)}tool`,
    `unknown${String.fromCharCode(0x1b)}[31mtool`,
  ]) {
    assert.throws(
      () =>
        validateCommandFrame({
          type: "command",
          id: "tools",
          name: "setActiveTools",
          args: { tools: [value] },
        }),
      /control characters/,
    );
  }
  assert.deepEqual(
    validateCommandFrame({
      type: "command",
      id: "tools-safe",
      name: "setActiveTools",
      args: { tools: ["unknown-tool"] },
    }),
    {
      type: "command",
      id: "tools-safe",
      name: "setActiveTools",
      args: { tools: ["unknown-tool"] },
    },
  );
});

test("protocol result errors reject controls and preserve ordinary safe errors", () => {
  for (const message of [
    `bad${String.fromCharCode(0x01)}error`,
    `bad${String.fromCharCode(0x1b)}[31merror`,
  ]) {
    assert.throws(
      () =>
        validateServerFrame({
          type: "result",
          id: "error",
          ok: false,
          error: { code: "unknown_tool", message },
        }),
      /control characters/,
    );
  }
  const safe = {
    type: "result",
    id: "safe",
    ok: false,
    error: { code: "unknown_tool", message: "Unknown tools: unknown-tool." },
  } as const;
  assert.deepEqual(validateServerFrame(safe), safe);
});

test("NDJSON decoder rejects oversized frames and recovers for the next line", () => {
  const decoder = new NdjsonDecoder(validateCommandFrame);
  const oversized = Buffer.alloc(MAX_LINE_BYTES + 32, 0x61);
  const first = decoder.push(oversized);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.ok, false);
  if (!first[0]?.ok) assert.equal(first[0].error.code, "frame_too_large");
  const recovered = decoder.push(`\n${JSON.stringify(commands[0])}\n`);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.ok, true);
});

test("hello and state frames use protocol version 1 and validated sequence numbers", () => {
  const hello: HelloFrame = {
    v: PROTOCOL_VERSION,
    type: "hello",
    seq: 1,
    payload: {
      accepted: true,
      controller: true,
      readOnly: false,
      paneId: "1:1/2",
      capabilities: {
        mouse: true,
        perToolExpansion: true,
        bulkToolExpansion: true,
        expansionSubscription: true,
      },
    },
  };
  const state: StateFrame = {
    v: PROTOCOL_VERSION,
    type: "state",
    seq: 2,
    payload: baseState(),
  };
  assert.deepEqual(validateServerFrame(hello), hello);
  assert.deepEqual(validateServerFrame(state), state);
  assert.throws(
    () => validateServerFrame({ ...state, seq: 0 }),
    /integer >= 1/,
  );
  assert.throws(
    () => validateServerFrame({ ...hello, v: 2 }),
    /protocol version 1/,
  );
});

test("context percentage may exceed 100 after an overflow", () => {
  const state = validateDeckState({
    ...baseState(),
    context: { tokens: 1200, window: 1000, percent: 120 },
  });
  assert.equal(state.context?.percent, 120);
});

test("state display strings reject ASCII controls and terminal escape sequences", () => {
  const fields = [
    "thinkingLevel",
    "allowedThinkingLevels",
    "activeTools",
    "availableTools",
  ] as const;
  for (const field of fields) {
    for (const value of [
      `bad${String.fromCharCode(0x01)}value`,
      `bad${String.fromCharCode(0x1b)}[31mvalue`,
    ]) {
      const state = baseState() as unknown as Record<string, unknown>;
      state[field] = field === "thinkingLevel" ? value : [value];
      assert.throws(() => validateDeckState(state), /control characters/);
    }
    const state = baseState() as unknown as Record<string, unknown>;
    state[field] = field === "thinkingLevel" ? "safe-level" : ["safe-tool"];
    assert.deepEqual(validateDeckState(state)[field], state[field]);
  }
});

test("serialized state is a whitelist and contains no secret-bearing fields", () => {
  const state = validateDeckState(baseState());
  const encoded = JSON.stringify(state);
  for (const forbidden of [
    "credential",
    "apiKey",
    "environment",
    "prompt",
    "toolOutput",
    "fileContents",
    "OPENAI_API_KEY",
  ]) {
    assert.equal(encoded.includes(forbidden), false);
  }
  assert.throws(
    () =>
      validateDeckState({
        ...baseState(),
        environment: { OPENAI_API_KEY: "secret" },
      }),
    /unknown fields/,
  );
  assert.throws(
    () =>
      validateDeckState({ ...baseState(), sessionFile: "/private/session" }),
    /unknown fields/,
  );
  assert.throws(
    () => validateDeckState({ ...baseState(), cwd: "/private/project" }),
    /unknown fields/,
  );
  assert.throws(
    () =>
      validateDeckState({
        ...baseState(),
        model: {
          provider: "test",
          id: "model",
          name: `bad${String.fromCharCode(0x1b)}[31m`,
        },
      }),
    /control characters/,
  );
});
