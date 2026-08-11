import { Buffer } from "node:buffer";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_ID_LENGTH = 256;
export const MAX_COLLECTION_ITEMS = 4096;

export type ActivityState = "idle" | "working";
export type DeliveryMode = "normal" | "steer" | "followUp";
export type ToolGroupScope = "currentTurn" | "session";
export type ToolStatus =
  "pending" | "running" | "complete" | "error" | "unknown";

export interface ModelChoice {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
}

export interface ModelState {
  provider: string;
  id: string;
  name: string;
}

export interface ContextState {
  tokens: number | null;
  window: number;
  percent: number | null;
}

export interface ToolExpansionState {
  id: string;
  name: string;
  expanded: boolean;
  status: ToolStatus;
  turnIndex: number;
}

export interface DeckState {
  sessionId?: string;
  herdrPaneId: string;
  activity: ActivityState;
  queuedMessage: boolean;
  model?: ModelState;
  modelChoices: ModelChoice[];
  thinkingLevel: string;
  allowedThinkingLevels: string[];
  context?: ContextState;
  activeTools: string[];
  availableTools: string[];
  tools: ToolExpansionState[];
  turnIndex: number;
  lastError?: string;
}

export interface HelloPayload {
  accepted: boolean;
  controller: boolean;
  readOnly: boolean;
  paneId: string;
  sessionId?: string;
  reason?: string;
  capabilities: {
    mouse: boolean;
    perToolExpansion: boolean;
    bulkToolExpansion: boolean;
    expansionSubscription: boolean;
  };
}

export interface HelloFrame {
  v: typeof PROTOCOL_VERSION;
  type: "hello";
  seq: number;
  payload: HelloPayload;
}

export interface StateFrame {
  v: typeof PROTOCOL_VERSION;
  type: "state";
  seq: number;
  payload: DeckState;
}

export interface CommandArgsMap {
  abort: Record<string, never>;
  compact: Record<string, never>;
  sendUserMessage: { message: string; delivery: DeliveryMode };
  setThinkingLevel: { level: string };
  setModel: { provider: string; modelId: string };
  setActiveTools: { tools: string[] };
  setToolExpanded: { toolCallId: string; expanded: boolean };
  setToolGroupExpanded: { scope: ToolGroupScope; expanded: boolean };
  refreshState: Record<string, never>;
}

export type CommandName = keyof CommandArgsMap;
export type CommandFrame<N extends CommandName = CommandName> =
  N extends CommandName
    ? { type: "command"; id: string; name: N; args: CommandArgsMap[N] }
    : never;

export interface ProtocolError {
  code: string;
  message: string;
}

export type ResultFrame =
  | { type: "result"; id: string; ok: true; value: unknown }
  | { type: "result"; id: string; ok: false; error: ProtocolError };

export type ServerFrame = HelloFrame | StateFrame | ResultFrame;
export type ClientFrame = CommandFrame;
export type AnyFrame = ServerFrame | ClientFrame;

export class ProtocolValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolValidationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownKeysExactly(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new ProtocolValidationError(
      "malformed_frame",
      `${label} must be an object.`,
    );
  return value;
}

function requireString(
  value: unknown,
  label: string,
  maxLength = MAX_ID_LENGTH,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new ProtocolValidationError(
      "malformed_frame",
      `${label} must be a non-empty string of at most ${maxLength} characters.`,
    );
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new ProtocolValidationError(
      "malformed_frame",
      `${label} must be a boolean.`,
    );
  return value;
}

function requireInteger(value: unknown, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new ProtocolValidationError(
      "malformed_frame",
      `${label} must be an integer >= ${min}.`,
    );
  }
  return value as number;
}

function requireFiniteNumber(value: unknown, label: string, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new ProtocolValidationError(
      "malformed_frame",
      `${label} must be a finite number >= ${min}.`,
    );
  }
  return value;
}

function requireDisplayString(
  value: unknown,
  label: string,
  maxLength = MAX_ID_LENGTH,
): string {
  const result = requireString(value, label, maxLength);
  if (
    [...result].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || code === 0x7f;
    })
  )
    throw new ProtocolValidationError(
      "malformed_frame",
      `${label} contains control characters.`,
    );
  return result;
}

function requireDisplayStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_ITEMS) {
    throw new ProtocolValidationError(
      "malformed_frame",
      `${label} must be an array with at most ${MAX_COLLECTION_ITEMS} items.`,
    );
  }
  const result = value.map((item, index) =>
    requireDisplayString(item, `${label}[${index}]`),
  );
  if (new Set(result).size !== result.length) {
    throw new ProtocolValidationError(
      "malformed_frame",
      `${label} must not contain duplicate values.`,
    );
  }
  return result;
}

function optionalString(
  value: unknown,
  label: string,
  maxLength = 4096,
): string | undefined {
  if (value === undefined) return undefined;
  return requireDisplayString(value, label, maxLength);
}

function validateEmptyArgs(
  value: unknown,
  label: string,
): Record<string, never> {
  const record = requireRecord(value, label);
  if (Object.keys(record).length !== 0) {
    throw new ProtocolValidationError(
      "invalid_command",
      `${label} must be empty.`,
    );
  }
  return {};
}

function validateCommandArgs(
  name: CommandName,
  args: unknown,
): CommandArgsMap[CommandName] {
  const record = requireRecord(args, "command.args");
  switch (name) {
    case "abort":
    case "compact":
    case "refreshState":
      return validateEmptyArgs(record, "command.args");
    case "sendUserMessage": {
      if (!ownKeysExactly(record, ["message", "delivery"])) {
        throw new ProtocolValidationError(
          "invalid_command",
          "sendUserMessage received unknown arguments.",
        );
      }
      const message = requireString(
        record.message,
        "command.args.message",
        MAX_MESSAGE_BYTES,
      );
      if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
        throw new ProtocolValidationError(
          "invalid_command",
          `Message exceeds ${MAX_MESSAGE_BYTES} bytes.`,
        );
      }
      if (message.trim().length === 0) {
        throw new ProtocolValidationError(
          "invalid_command",
          "Message must not be empty.",
        );
      }
      const delivery = record.delivery;
      if (
        delivery !== "normal" &&
        delivery !== "steer" &&
        delivery !== "followUp"
      ) {
        throw new ProtocolValidationError(
          "invalid_command",
          "delivery must be normal, steer, or followUp.",
        );
      }
      return { message, delivery };
    }
    case "setThinkingLevel":
      if (!ownKeysExactly(record, ["level"]))
        throw new ProtocolValidationError(
          "invalid_command",
          "setThinkingLevel received unknown arguments.",
        );
      return { level: requireString(record.level, "command.args.level") };
    case "setModel":
      if (!ownKeysExactly(record, ["provider", "modelId"]))
        throw new ProtocolValidationError(
          "invalid_command",
          "setModel received unknown arguments.",
        );
      return {
        provider: requireString(record.provider, "command.args.provider"),
        modelId: requireString(record.modelId, "command.args.modelId"),
      };
    case "setActiveTools":
      if (!ownKeysExactly(record, ["tools"]))
        throw new ProtocolValidationError(
          "invalid_command",
          "setActiveTools received unknown arguments.",
        );
      return {
        tools: requireDisplayStringArray(record.tools, "command.args.tools"),
      };
    case "setToolExpanded":
      if (!ownKeysExactly(record, ["toolCallId", "expanded"]))
        throw new ProtocolValidationError(
          "invalid_command",
          "setToolExpanded received unknown arguments.",
        );
      return {
        toolCallId: requireString(record.toolCallId, "command.args.toolCallId"),
        expanded: requireBoolean(record.expanded, "command.args.expanded"),
      };
    case "setToolGroupExpanded": {
      if (!ownKeysExactly(record, ["scope", "expanded"]))
        throw new ProtocolValidationError(
          "invalid_command",
          "setToolGroupExpanded received unknown arguments.",
        );
      if (record.scope !== "currentTurn" && record.scope !== "session") {
        throw new ProtocolValidationError(
          "invalid_command",
          "scope must be currentTurn or session.",
        );
      }
      return {
        scope: record.scope,
        expanded: requireBoolean(record.expanded, "command.args.expanded"),
      };
    }
  }
}

export function validateCommandFrame(value: unknown): CommandFrame {
  const record = requireRecord(value, "frame");
  if (!ownKeysExactly(record, ["type", "id", "name", "args"])) {
    throw new ProtocolValidationError(
      "malformed_frame",
      "Command frame contains unknown fields.",
    );
  }
  if (record.type !== "command")
    throw new ProtocolValidationError(
      "malformed_frame",
      "Expected a command frame.",
    );
  const id = requireString(record.id, "command.id");
  const names: readonly CommandName[] = [
    "abort",
    "compact",
    "sendUserMessage",
    "setThinkingLevel",
    "setModel",
    "setActiveTools",
    "setToolExpanded",
    "setToolGroupExpanded",
    "refreshState",
  ];
  if (
    typeof record.name !== "string" ||
    !names.includes(record.name as CommandName)
  ) {
    throw new ProtocolValidationError(
      "unknown_command",
      "Unknown command name.",
    );
  }
  const name = record.name as CommandName;
  const args = validateCommandArgs(name, record.args);
  return { type: "command", id, name, args } as CommandFrame;
}

function validateModelChoice(value: unknown, label: string): ModelChoice {
  const record = requireRecord(value, label);
  if (!ownKeysExactly(record, ["provider", "id", "name", "contextWindow"])) {
    throw new ProtocolValidationError(
      "malformed_frame",
      `${label} contains unknown fields.`,
    );
  }
  const choice: ModelChoice = {
    provider: requireDisplayString(record.provider, `${label}.provider`),
    id: requireDisplayString(record.id, `${label}.id`),
    name: requireDisplayString(record.name, `${label}.name`, 1024),
  };
  if (record.contextWindow !== undefined)
    choice.contextWindow = requireInteger(
      record.contextWindow,
      `${label}.contextWindow`,
      1,
    );
  return choice;
}

function validateModelState(value: unknown, label: string): ModelState {
  const record = requireRecord(value, label);
  if (!ownKeysExactly(record, ["provider", "id", "name"]))
    throw new ProtocolValidationError(
      "malformed_frame",
      `${label} contains unknown fields.`,
    );
  return {
    provider: requireDisplayString(record.provider, `${label}.provider`),
    id: requireDisplayString(record.id, `${label}.id`),
    name: requireDisplayString(record.name, `${label}.name`, 1024),
  };
}

function validateContextState(value: unknown, label: string): ContextState {
  const record = requireRecord(value, label);
  if (!ownKeysExactly(record, ["tokens", "window", "percent"]))
    throw new ProtocolValidationError(
      "malformed_frame",
      `${label} contains unknown fields.`,
    );
  const tokens =
    record.tokens === null
      ? null
      : requireInteger(record.tokens, `${label}.tokens`);
  const percent =
    record.percent === null
      ? null
      : requireFiniteNumber(record.percent, `${label}.percent`);
  return {
    tokens,
    window: requireInteger(record.window, `${label}.window`, 1),
    percent,
  };
}

function validateToolState(value: unknown, label: string): ToolExpansionState {
  const record = requireRecord(value, label);
  if (
    !ownKeysExactly(record, ["id", "name", "expanded", "status", "turnIndex"])
  ) {
    throw new ProtocolValidationError(
      "malformed_frame",
      `${label} contains unknown fields.`,
    );
  }
  const statuses: readonly ToolStatus[] = [
    "pending",
    "running",
    "complete",
    "error",
    "unknown",
  ];
  if (
    typeof record.status !== "string" ||
    !statuses.includes(record.status as ToolStatus)
  ) {
    throw new ProtocolValidationError(
      "malformed_frame",
      `${label}.status is invalid.`,
    );
  }
  return {
    id: requireDisplayString(record.id, `${label}.id`),
    name: requireDisplayString(record.name, `${label}.name`),
    expanded: requireBoolean(record.expanded, `${label}.expanded`),
    status: record.status as ToolStatus,
    turnIndex: requireInteger(record.turnIndex, `${label}.turnIndex`),
  };
}

export function validateDeckState(value: unknown): DeckState {
  const record = requireRecord(value, "state.payload");
  const allowed = [
    "sessionId",
    "herdrPaneId",
    "activity",
    "queuedMessage",
    "model",
    "modelChoices",
    "thinkingLevel",
    "allowedThinkingLevels",
    "context",
    "activeTools",
    "availableTools",
    "tools",
    "turnIndex",
    "lastError",
  ] as const;
  if (!ownKeysExactly(record, allowed))
    throw new ProtocolValidationError(
      "malformed_frame",
      "State contains unknown fields.",
    );
  if (record.activity !== "idle" && record.activity !== "working") {
    throw new ProtocolValidationError(
      "malformed_frame",
      "state.activity must be idle or working.",
    );
  }
  if (
    !Array.isArray(record.modelChoices) ||
    record.modelChoices.length > MAX_COLLECTION_ITEMS
  ) {
    throw new ProtocolValidationError(
      "malformed_frame",
      "state.modelChoices is invalid.",
    );
  }
  if (
    !Array.isArray(record.tools) ||
    record.tools.length > MAX_COLLECTION_ITEMS
  ) {
    throw new ProtocolValidationError(
      "malformed_frame",
      "state.tools is invalid.",
    );
  }
  const state: DeckState = {
    herdrPaneId: requireDisplayString(record.herdrPaneId, "state.herdrPaneId"),
    activity: record.activity,
    queuedMessage: requireBoolean(record.queuedMessage, "state.queuedMessage"),
    modelChoices: record.modelChoices.map((item, index) =>
      validateModelChoice(item, `state.modelChoices[${index}]`),
    ),
    thinkingLevel: requireDisplayString(
      record.thinkingLevel,
      "state.thinkingLevel",
    ),
    allowedThinkingLevels: requireDisplayStringArray(
      record.allowedThinkingLevels,
      "state.allowedThinkingLevels",
    ),
    activeTools: requireDisplayStringArray(
      record.activeTools,
      "state.activeTools",
    ),
    availableTools: requireDisplayStringArray(
      record.availableTools,
      "state.availableTools",
    ),
    tools: record.tools.map((item, index) =>
      validateToolState(item, `state.tools[${index}]`),
    ),
    turnIndex: requireInteger(record.turnIndex, "state.turnIndex"),
  };
  const sessionId = optionalString(record.sessionId, "state.sessionId", 4096);
  const lastError = optionalString(record.lastError, "state.lastError", 1024);
  if (sessionId !== undefined) state.sessionId = sessionId;
  if (lastError !== undefined) state.lastError = lastError;
  if (record.model !== undefined)
    state.model = validateModelState(record.model, "state.model");
  if (record.context !== undefined)
    state.context = validateContextState(record.context, "state.context");
  return state;
}

function validateHelloPayload(value: unknown): HelloPayload {
  const record = requireRecord(value, "hello.payload");
  if (
    !ownKeysExactly(record, [
      "accepted",
      "controller",
      "readOnly",
      "paneId",
      "sessionId",
      "reason",
      "capabilities",
    ])
  ) {
    throw new ProtocolValidationError(
      "malformed_frame",
      "hello.payload contains unknown fields.",
    );
  }
  const capabilities = requireRecord(
    record.capabilities,
    "hello.payload.capabilities",
  );
  if (
    !ownKeysExactly(capabilities, [
      "mouse",
      "perToolExpansion",
      "bulkToolExpansion",
      "expansionSubscription",
    ])
  ) {
    throw new ProtocolValidationError(
      "incompatible_protocol",
      "Bridge capability declaration is invalid.",
    );
  }
  const mouse = requireBoolean(
    capabilities.mouse,
    "hello.payload.capabilities.mouse",
  );
  const perToolExpansion = requireBoolean(
    capabilities.perToolExpansion,
    "hello.payload.capabilities.perToolExpansion",
  );
  const bulkToolExpansion = requireBoolean(
    capabilities.bulkToolExpansion,
    "hello.payload.capabilities.bulkToolExpansion",
  );
  const expansionSubscription = requireBoolean(
    capabilities.expansionSubscription,
    "hello.payload.capabilities.expansionSubscription",
  );
  const payload: HelloPayload = {
    accepted: requireBoolean(record.accepted, "hello.payload.accepted"),
    controller: requireBoolean(record.controller, "hello.payload.controller"),
    readOnly: requireBoolean(record.readOnly, "hello.payload.readOnly"),
    paneId: requireDisplayString(record.paneId, "hello.payload.paneId"),
    capabilities: {
      mouse,
      perToolExpansion,
      bulkToolExpansion,
      expansionSubscription,
    },
  };
  const sessionId = optionalString(record.sessionId, "hello.payload.sessionId");
  const reason = optionalString(record.reason, "hello.payload.reason", 4096);
  if (sessionId !== undefined) payload.sessionId = sessionId;
  if (reason !== undefined) payload.reason = reason;
  return payload;
}

function validateJsonValue(value: unknown, label: string, depth = 0): unknown {
  if (depth > 32)
    throw new ProtocolValidationError(
      "malformed_frame",
      `${label} exceeds the maximum nesting depth.`,
    );
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new ProtocolValidationError(
        "malformed_frame",
        `${label} must contain only finite numbers.`,
      );
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ITEMS) {
      throw new ProtocolValidationError(
        "malformed_frame",
        `${label} contains too many array items.`,
      );
    }
    return value.map((item, index) =>
      validateJsonValue(item, `${label}[${index}]`, depth + 1),
    );
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > MAX_COLLECTION_ITEMS) {
      throw new ProtocolValidationError(
        "malformed_frame",
        `${label} contains too many object fields.`,
      );
    }
    const validated: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      if (key.length === 0 || key.length > MAX_ID_LENGTH) {
        throw new ProtocolValidationError(
          "malformed_frame",
          `${label} contains an invalid object key.`,
        );
      }
      validated[key] = validateJsonValue(item, `${label}.${key}`, depth + 1);
    }
    return validated;
  }
  throw new ProtocolValidationError(
    "malformed_frame",
    `${label} must be JSON-compatible.`,
  );
}

export function validateServerFrame(value: unknown): ServerFrame {
  const record = requireRecord(value, "frame");
  if (record.type === "hello") {
    if (!ownKeysExactly(record, ["v", "type", "seq", "payload"]))
      throw new ProtocolValidationError(
        "malformed_frame",
        "Hello frame contains unknown fields.",
      );
    if (record.v !== PROTOCOL_VERSION)
      throw new ProtocolValidationError(
        "incompatible_protocol",
        `Expected protocol version ${PROTOCOL_VERSION}.`,
      );
    return {
      v: PROTOCOL_VERSION,
      type: "hello",
      seq: requireInteger(record.seq, "hello.seq", 1),
      payload: validateHelloPayload(record.payload),
    };
  }
  if (record.type === "state") {
    if (!ownKeysExactly(record, ["v", "type", "seq", "payload"]))
      throw new ProtocolValidationError(
        "malformed_frame",
        "State frame contains unknown fields.",
      );
    if (record.v !== PROTOCOL_VERSION)
      throw new ProtocolValidationError(
        "incompatible_protocol",
        `Expected protocol version ${PROTOCOL_VERSION}.`,
      );
    return {
      v: PROTOCOL_VERSION,
      type: "state",
      seq: requireInteger(record.seq, "state.seq", 1),
      payload: validateDeckState(record.payload),
    };
  }
  if (record.type === "result") {
    if (record.ok === true) {
      if (
        !ownKeysExactly(record, ["type", "id", "ok", "value"]) ||
        !Object.hasOwn(record, "value")
      ) {
        throw new ProtocolValidationError(
          "malformed_frame",
          "Successful result frame must contain exactly id, ok, type, and value.",
        );
      }
      return {
        type: "result",
        id: requireString(record.id, "result.id"),
        ok: true,
        value: validateJsonValue(record.value, "result.value"),
      };
    }
    if (record.ok === false) {
      if (!ownKeysExactly(record, ["type", "id", "ok", "error"]))
        throw new ProtocolValidationError(
          "malformed_frame",
          "Result frame contains unknown fields.",
        );
      const error = requireRecord(record.error, "result.error");
      if (!ownKeysExactly(error, ["code", "message"]))
        throw new ProtocolValidationError(
          "malformed_frame",
          "result.error contains unknown fields.",
        );
      return {
        type: "result",
        id: requireString(record.id, "result.id"),
        ok: false,
        error: {
          code: requireString(error.code, "result.error.code"),
          message: requireDisplayString(
            error.message,
            "result.error.message",
            8192,
          ),
        },
      };
    }
  }
  throw new ProtocolValidationError(
    "malformed_frame",
    "Unknown server frame type.",
  );
}

export function encodeFrame(frame: AnyFrame): Buffer {
  const validated =
    frame.type === "command"
      ? validateCommandFrame(frame)
      : validateServerFrame(frame);
  const encoded = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
  if (encoded.byteLength > MAX_LINE_BYTES + 1) {
    throw new ProtocolValidationError(
      "frame_too_large",
      `Encoded frame exceeds ${MAX_LINE_BYTES} bytes.`,
    );
  }
  return encoded;
}

export interface DecodedLine<T> {
  ok: true;
  value: T;
}

export interface FailedLine {
  ok: false;
  error: ProtocolValidationError;
  requestId?: string;
}

export type LineDecodeResult<T> = DecodedLine<T> | FailedLine;

export class NdjsonDecoder<T> {
  #buffer = Buffer.alloc(0);
  #discardingOversized = false;
  readonly #validator: (value: unknown) => T;

  constructor(validator: (value: unknown) => T) {
    this.#validator = validator;
  }

  push(chunk: Buffer | string): LineDecodeResult<T>[] {
    const input =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const results: LineDecodeResult<T>[] = [];
    let offset = 0;
    while (offset < input.length) {
      const newline = input.indexOf(0x0a, offset);
      const end = newline === -1 ? input.length : newline;
      const segment = input.subarray(offset, end);
      if (this.#discardingOversized) {
        if (newline !== -1) this.#discardingOversized = false;
      } else if (this.#buffer.length + segment.length > MAX_LINE_BYTES) {
        this.#buffer = Buffer.alloc(0);
        results.push({
          ok: false,
          error: new ProtocolValidationError(
            "frame_too_large",
            `Frame exceeds ${MAX_LINE_BYTES} bytes.`,
          ),
        });
        if (newline === -1) this.#discardingOversized = true;
      } else {
        this.#buffer =
          this.#buffer.length === 0
            ? Buffer.from(segment)
            : Buffer.concat([this.#buffer, segment]);
        if (newline !== -1) {
          let line = this.#buffer;
          this.#buffer = Buffer.alloc(0);
          if (line.length > 0 && line[line.length - 1] === 0x0d)
            line = line.subarray(0, line.length - 1);
          if (line.length > 0) results.push(this.#decodeLine(line));
        }
      }
      offset = newline === -1 ? input.length : newline + 1;
    }
    return results;
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0);
    this.#discardingOversized = false;
  }

  #decodeLine(line: Buffer): LineDecodeResult<T> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      return {
        ok: false,
        error: new ProtocolValidationError(
          "malformed_json",
          "Frame is not valid JSON.",
        ),
      };
    }
    try {
      return { ok: true, value: this.#validator(parsed) };
    } catch (error) {
      const protocolError =
        error instanceof ProtocolValidationError
          ? error
          : new ProtocolValidationError(
              "malformed_frame",
              error instanceof Error
                ? error.message
                : "Frame validation failed.",
            );
      const requestId =
        isRecord(parsed) &&
        typeof parsed.id === "string" &&
        parsed.id.length > 0 &&
        parsed.id.length <= MAX_ID_LENGTH
          ? parsed.id
          : undefined;
      return requestId === undefined
        ? { ok: false, error: protocolError }
        : { ok: false, error: protocolError, requestId };
    }
  }
}

export function errorResult(
  id: string,
  code: string,
  message: string,
): ResultFrame {
  return { type: "result", id, ok: false, error: { code, message } };
}
