import { isAbsolute } from "node:path";
import { ensureBroker } from "../broker/startup.js";

const MAX_SOCKET_PATH_BYTES = 103;

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes("\u0000") &&
    isAbsolute(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_SOCKET_PATH_BYTES
  );
}

function contextSocket(contextJson: string | undefined): string | undefined {
  if (!contextJson?.trim()) return undefined;
  const value: unknown = JSON.parse(contextJson);
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const root = value as Record<string, unknown>;
  const orchestrator = root.orchestrator;
  if (
    orchestrator &&
    typeof orchestrator === "object" &&
    !Array.isArray(orchestrator)
  ) {
    const nested = orchestrator as Record<string, unknown>;
    if (validPath(nested.brokerSocketPath)) return nested.brokerSocketPath;
    if (validPath(nested.socketPath)) return nested.socketPath;
  }
  if (validPath(root.brokerSocketPath)) return root.brokerSocketPath;
  return undefined;
}

export async function resolveBrokerContext(): Promise<{
  socketPath: string;
  secretPath: string;
  sessionKey: string;
}> {
  const paths = await ensureBroker();
  return {
    socketPath: paths.socket,
    secretPath: paths.secret,
    sessionKey: paths.sessionKey,
  };
}

/** Compatibility parser for explicit managed contexts. Public deck startup uses resolveBrokerContext. */
export function resolveBrokerSocketPath(
  environment: NodeJS.ProcessEnv = process.env,
  contextJson = environment.HERDR_PLUGIN_CONTEXT_JSON,
): string {
  const explicit =
    environment.PI_HERDR_ORCH_BROKER_SOCKET ??
    environment.PI_HERDR_ORCH_SOCKET_PATH;
  if (validPath(explicit)) return explicit;
  const fromContext = contextSocket(contextJson);
  if (fromContext) return fromContext;
  throw new Error("The managed broker context is missing or invalid.");
}
