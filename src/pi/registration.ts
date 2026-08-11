import type { PiAdapterCapabilities, PiSafeState } from "./types.js";
const MAX_TEXT = 256;
const MAX_TOOLS = 128;
const MAX_TOOL_NAME = 128;
export interface PiRegistrationPayload {
  adapterVersion: string;
  agentId?: string;
  generation?: number;
  herdr: {
    paneId: string;
    terminalId?: string;
    detectedKind: "pi";
    name?: string;
  };
  pi: {
    sessionId: string;
    activity: "idle" | "working";
    capabilities: PiAdapterCapabilities;
  };
}
export interface PiRegistrationOptions {
  adapterVersion?: string;
  agentId?: string;
  generation?: number;
  herdr: PiRegistrationPayload["herdr"];
}
function text(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TEXT ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`PI_REGISTRATION_${field.toUpperCase()}_INVALID`);
  return value;
}
function generation(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error("PI_REGISTRATION_GENERATION_INVALID");
  return value as number;
}
function capabilities(value: unknown): PiAdapterCapabilities {
  if (!value || typeof value !== "object")
    throw new Error("PI_REGISTRATION_CAPABILITIES_INVALID");
  const source = value as Record<string, unknown>;
  const keys: (keyof PiAdapterCapabilities)[] = [
    "core",
    "prompt",
    "steer",
    "followUp",
    "abort",
    "compact",
    "model",
    "thinking",
    "tools",
    "toolExpansion",
  ];
  if (
    Object.keys(source).some(
      (key) => !keys.includes(key as keyof PiAdapterCapabilities),
    ) ||
    keys.some((key) => typeof source[key] !== "boolean")
  )
    throw new Error("PI_REGISTRATION_CAPABILITIES_INVALID");
  return Object.fromEntries(
    keys.map((key) => [key, source[key]]),
  ) as unknown as PiAdapterCapabilities;
}
export function validateRegistrationPayload(
  value: unknown,
): PiRegistrationPayload {
  if (!value || typeof value !== "object")
    throw new Error("PI_REGISTRATION_PAYLOAD_INVALID");
  const source = value as Record<string, unknown>;
  const allowed = new Set([
    "adapterVersion",
    "agentId",
    "generation",
    "herdr",
    "pi",
  ]);
  if (Object.keys(source).some((key) => !allowed.has(key)))
    throw new Error("PI_REGISTRATION_PAYLOAD_INVALID");
  if (
    !source.herdr ||
    typeof source.herdr !== "object" ||
    !source.pi ||
    typeof source.pi !== "object"
  )
    throw new Error("PI_REGISTRATION_PAYLOAD_INVALID");
  const herdr = source.herdr as Record<string, unknown>,
    pi = source.pi as Record<string, unknown>;
  const herdrKeys = new Set(["paneId", "terminalId", "detectedKind", "name"]);
  if (
    Object.keys(herdr).some((key) => !herdrKeys.has(key)) ||
    herdr.detectedKind !== "pi"
  )
    throw new Error("PI_REGISTRATION_HERDR_INVALID");
  const piKeys = new Set(["sessionId", "activity", "capabilities"]);
  if (
    Object.keys(pi).some((key) => !piKeys.has(key)) ||
    (pi.activity !== "idle" && pi.activity !== "working")
  )
    throw new Error("PI_REGISTRATION_PI_INVALID");
  return {
    adapterVersion: text(source.adapterVersion, "adapter_version"),
    ...(source.agentId === undefined
      ? {}
      : { agentId: text(source.agentId, "agent_id") }),
    ...(source.generation === undefined
      ? {}
      : { generation: generation(source.generation)! }),
    herdr: {
      paneId: text(herdr.paneId, "pane_id"),
      ...(herdr.terminalId === undefined
        ? {}
        : { terminalId: text(herdr.terminalId, "terminal_id") }),
      detectedKind: "pi",
      ...(herdr.name === undefined ? {} : { name: text(herdr.name, "name") }),
    },
    pi: {
      sessionId: text(pi.sessionId, "session_id"),
      activity: pi.activity,
      capabilities: capabilities(pi.capabilities),
    },
  };
}
export function createRegistrationPayload(
  state: PiSafeState,
  options: PiRegistrationOptions,
): PiRegistrationPayload {
  return validateRegistrationPayload({
    adapterVersion: options.adapterVersion ?? "0.1.0",
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    ...(options.generation === undefined
      ? {}
      : { generation: options.generation }),
    herdr: options.herdr,
    pi: {
      sessionId: state.sessionId,
      activity: state.activity,
      capabilities: state.capabilities,
    },
  });
}
export function validateHeartbeatState(state: PiSafeState): PiSafeState {
  const result = {
    ...state,
    sessionId: text(state.sessionId, "session_id"),
    agentId: text(state.agentId, "agent_id"),
  };
  if (
    !Number.isSafeInteger(state.generation) ||
    state.generation < 1 ||
    !Number.isSafeInteger(state.pendingMessages) ||
    state.pendingMessages < 0 ||
    state.pendingMessages > 1 ||
    (state.activity !== "idle" && state.activity !== "working")
  )
    throw new Error("PI_HEARTBEAT_STATE_INVALID");
  if (
    !Array.isArray(state.activeTools) ||
    state.activeTools.length > MAX_TOOLS ||
    state.activeTools.some(
      (name) =>
        typeof name !== "string" ||
        name.length === 0 ||
        name.length > MAX_TOOL_NAME,
    )
  )
    throw new Error("PI_HEARTBEAT_STATE_INVALID");
  return result;
}
