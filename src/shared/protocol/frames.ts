import { LIMITS } from "../limits.js";
export const PROTOCOL_MAJOR = 1 as const;
export type PrincipalKind =
  "human" | "cli" | "deck" | "pi_parent" | "pi_child" | "observer";
export interface HelloRequest {
  v: 1;
  type: "hello";
  id: string;
  client: {
    kind: PrincipalKind;
    name: string;
    version: string;
    capabilities: string[];
  };
  sessionKey: string;
  auth: {
    kind: "client_secret" | "agent_token";
    secret?: string;
    token?: string;
    agentId?: string;
    generation?: number;
    piSessionId?: string;
  };
}
export interface RequestFrame {
  v: 1;
  type: "request";
  id: string;
  method: string;
  params: Record<string, unknown>;
  idempotencyKey?: string;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown, name: string, max = 4096): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    [...value].some((c) => c < " " || c === "\u007f")
  )
    throw new Error(`${name} is invalid.`);
  return value;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unknown frame fields.");
}
export function validateHello(value: unknown): HelloRequest {
  if (!isRecord(value)) throw new Error("Hello must be an object.");
  exact(value, ["v", "type", "id", "client", "sessionKey", "auth"]);
  if (value.v !== 1 || value.type !== "hello")
    throw new Error("Unsupported hello frame.");
  const client = isRecord(value.client) ? value.client : undefined;
  const auth = isRecord(value.auth) ? value.auth : undefined;
  if (!client || !auth) throw new Error("Hello fields are invalid.");
  exact(client, ["kind", "name", "version", "capabilities"]);
  exact(auth, [
    "kind",
    "secret",
    "token",
    "agentId",
    "generation",
    "piSessionId",
  ]);
  const kinds: PrincipalKind[] = [
    "human",
    "cli",
    "deck",
    "pi_parent",
    "pi_child",
    "observer",
  ];
  if (!kinds.includes(client.kind as PrincipalKind))
    throw new Error("Unknown client kind.");
  if (
    !Array.isArray(client.capabilities) ||
    client.capabilities.length > LIMITS.maxCollectionItems
  )
    throw new Error("Invalid capabilities.");
  if (auth.kind !== "client_secret" && auth.kind !== "agent_token")
    throw new Error("Unknown auth kind.");
  return {
    v: 1,
    type: "hello",
    id: string(value.id, "id"),
    client: {
      kind: client.kind as PrincipalKind,
      name: string(client.name, "client.name"),
      version: string(client.version, "client.version"),
      capabilities: client.capabilities.map((item) =>
        string(item, "capability"),
      ),
    },
    sessionKey: string(value.sessionKey, "sessionKey", 64),
    auth: {
      kind: auth.kind,
      ...(typeof auth.secret === "string" ? { secret: auth.secret } : {}),
      ...(typeof auth.token === "string" ? { token: auth.token } : {}),
      ...(typeof auth.agentId === "string" ? { agentId: auth.agentId } : {}),
      ...(typeof auth.generation === "number" &&
      Number.isSafeInteger(auth.generation)
        ? { generation: auth.generation }
        : {}),
      ...(typeof auth.piSessionId === "string"
        ? { piSessionId: auth.piSessionId }
        : {}),
    },
  };
}
export function validateRequest(value: unknown): RequestFrame {
  if (!isRecord(value)) throw new Error("Request must be an object.");
  exact(value, ["v", "type", "id", "method", "params", "idempotencyKey"]);
  if (value.v !== 1 || value.type !== "request")
    throw new Error("Unsupported request frame.");
  if (!isRecord(value.params))
    throw new Error("Request params must be an object.");
  return {
    v: 1,
    type: "request",
    id: string(value.id, "id"),
    method: string(value.method, "method", 128),
    params: value.params,
    ...(typeof value.idempotencyKey === "string"
      ? { idempotencyKey: string(value.idempotencyKey, "idempotencyKey", 256) }
      : {}),
  };
}
export type ResponseFrame = Record<string, unknown>;
export type EventFrame = Record<string, unknown>;
