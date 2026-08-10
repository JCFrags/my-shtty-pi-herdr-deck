import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiAdapter, piSessionId } from "../src/pi/adapter.js";
import { PiBrokerClient } from "../src/pi/broker-client.js";
import type { PiApiLike, PiContextLike, PiLifecycleEvent } from "../src/pi/types.js";
import { registerOrchestratorTools, type PiToolBinding } from "../src/pi/tools.js";
import { readManagedTokenFile, siblingSecretPath } from "../src/pi/token-file.js";
import { readPrivateRegular } from "../src/shared/private-fs.js";
const KEY = Symbol.for("pi-herdr-orchestrator.runtime.v1");
interface Runtime { cleanup(): void; }
const TOOL_KEY = Symbol.for("pi-herdr-orchestrator.tools.v1");
type Global = typeof globalThis & { [KEY]?: Runtime; [TOOL_KEY]?: PiToolBinding };
function inactive(context: PiContextLike): void { context.ui.setStatus?.("pi-herdr-orchestrator", "Orchestrator inactive: Pi is outside a Herdr pane."); }
export default async function piHerdrOrchestrator(api: ExtensionAPI): Promise<void> {
  const pi = api as unknown as PiApiLike; const global = globalThis as Global; global[KEY]?.cleanup(); const binding: PiToolBinding = global[TOOL_KEY] ?? { adapter: undefined, client: undefined }; global[TOOL_KEY] = binding;
  let adapter: PiAdapter | undefined; let client: PiBrokerClient | undefined; let heartbeat: NodeJS.Timeout | undefined; let toolsRegistered = false;
  const managed = process.env.PI_HERDR_ORCH_MANAGED === "1";
  const socketPath = process.env.PI_HERDR_ORCH_BROKER_SOCKET ?? process.env.HERDR_SOCKET_PATH;
  const active = process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID && !!process.env.HERDR_BIN_PATH && !!socketPath && !!process.env.PI_HERDR_ORCH_SESSION_KEY;
  const runtime: Runtime = { cleanup() { if (heartbeat) clearInterval(heartbeat); binding.adapter = undefined; binding.client = undefined; if (client) client.close(); adapter = undefined; client = undefined; } }; global[KEY] = runtime;
  const start = async (next: PiContextLike): Promise<void> => {
    if (!active || !socketPath || !process.env.PI_HERDR_ORCH_SESSION_KEY) { inactive(next); return; }
    const agentId = process.env.PI_HERDR_ORCH_AGENT_ID ?? ""; const generation = Number(process.env.PI_HERDR_ORCH_GENERATION ?? "1"); adapter = new PiAdapter(pi, next, agentId, generation);
    const tokenFile = process.env.PI_HERDR_ORCH_TOKEN_FILE;
    const handleControlRequest = async (request: { id: string; method: string; params: Record<string, unknown> }): Promise<unknown> => { if (!adapter) throw new Error("AGENT_DISCONNECTED"); return adapter.handleControl(request.method, request.params); };
    const handleServerRequest = async (request: { id: string; method: string; params: Record<string, unknown> }): Promise<unknown> => {
      if (request.method !== "assignment.deliver" || !adapter) throw new Error("PI_METHOD_UNAVAILABLE");
      const value = request.params.assignment;
      if (!value || typeof value !== "object") throw new Error("INVALID_REQUEST");
      const source = value as Record<string, unknown>;
      const assignment = { ...source, id: typeof source.id === "string" ? source.id : source.assignmentId } as Parameters<PiAdapter["deliver"]>[0];
      return { status: await adapter.deliver(assignment) };
    };
    const token = managed && tokenFile ? await readManagedTokenFile(tokenFile).catch(() => undefined) : undefined;
    if (managed && !token) { next.ui.setStatus?.("pi-herdr-orchestrator", "Managed token file unavailable; orchestration controls are disabled."); return; }
    const secret = !managed ? await (async () => { try { return await readPrivateRegular(siblingSecretPath(socketPath)); } catch { return undefined; } })() : undefined;
    if (!managed && !secret) { next.ui.setStatus?.("pi-herdr-orchestrator", "Broker secret file unavailable; orchestration controls are disabled."); return; }
    client = managed && token ? new PiBrokerClient({ socketPath, sessionKey: process.env.PI_HERDR_ORCH_SESSION_KEY, piSessionId: piSessionId(next), agentId, generation, token, onServerRequest: handleServerRequest, onControlRequest: handleControlRequest }) : new PiBrokerClient({ socketPath, sessionKey: process.env.PI_HERDR_ORCH_SESSION_KEY, piSessionId: piSessionId(next), secret: secret!, onServerRequest: handleServerRequest, onControlRequest: handleControlRequest });
    binding.adapter = undefined; binding.client = undefined;
    try { await client.connect(); const registration = await client.register(adapter.safeState()); adapter.bindIdentity(registration.agentId, registration.generation, registration.connectionGeneration); binding.adapter = adapter; binding.client = client; if (!toolsRegistered) { registerOrchestratorTools(pi, binding, managed); toolsRegistered = true; } heartbeat = setInterval(() => { if (client?.connected && adapter) void client.heartbeat(adapter.safeState()).catch(() => undefined); }, 5_000); heartbeat.unref(); next.ui.setStatus?.("pi-herdr-orchestrator", managed ? "Managed Pi connected" : "Adopted Pi connected"); } catch { next.ui.setStatus?.("pi-herdr-orchestrator", "Broker unavailable; orchestration controls are disabled."); }
  };
  api.registerCommand("orchestrator-status", { description: "Show Pi Herd Orchestrator status", handler: async (_args, next) => { await start(next as PiContextLike); (next as PiContextLike).ui.notify?.(client?.connected ? "Pi Herd Orchestrator connected." : "Pi Herd Orchestrator disconnected.", client?.connected ? "info" : "warning"); } });
  api.on("session_start", (_event, next) => void start(next as PiContextLike));
  api.on("session_shutdown", () => runtime.cleanup());
  for (const type of ["before_agent_start", "agent_start", "turn_start", "turn_end", "agent_end", "agent_settled", "session_compact", "tool_execution_start", "tool_execution_end"] as const) api.on(type, (_event, raw) => { const next = raw as PiContextLike; adapter?.updateContext(next); const safe = adapter?.safeState(); if (safe && client?.connected) void client.heartbeat(safe).catch(() => undefined); const lifecycle: PiLifecycleEvent = { type, agentId: safe?.agentId ?? "", generation: safe?.generation ?? 1, piSessionId: safe?.sessionId ?? "", ...(safe?.turnIndex !== undefined ? { turnIndex: safe.turnIndex } : {}) }; adapter?.onLifecycle(lifecycle); });
}
