import { connect, type Socket } from "node:net";
import { createId } from "../shared/ids.js";
import { encodeFrame, NdjsonDecoder } from "../shared/protocol/codec.js";
import type { PiSafeState } from "./types.js";
export interface PiBrokerPrincipal { id: string; kind: "human" | "pi_parent" | "pi_child"; permissions: string[]; agentId?: string; generation?: number; }
interface HelloResult { v: 1; type: "hello_result"; id: string; ok: true; broker: { version: string; status: string; lastEventSeq: number }; principal: PiBrokerPrincipal; limits: { maxLineBytes: number }; }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BROKER_HELLO_INVALID");
  return value as Record<string, unknown>;
}
function safeString(value: unknown, max = 256): string { if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("BROKER_HELLO_INVALID"); return value; }
function validateHelloResult(value: unknown, expectedId: string): HelloResult {
  const frame = record(value);
  const keys = ["v", "type", "id", "ok", "broker", "principal", "limits", "error"];
  if (Object.keys(frame).some((key) => !keys.includes(key)) || frame.v !== 1 || frame.type !== "hello_result" || frame.id !== expectedId || frame.ok !== true) throw new Error("BROKER_HELLO_INVALID");
  const broker = record(frame.broker); if (safeString(broker.version) === "" || safeString(broker.status) === "" || !Number.isSafeInteger(broker.lastEventSeq) || (broker.lastEventSeq as number) < 0) throw new Error("BROKER_HELLO_INVALID");
  const principal = record(frame.principal); const principalKeys = ["id", "kind", "permissions", "agentId", "generation", "piSessionId"];
  if (Object.keys(principal).some((key) => !principalKeys.includes(key))) throw new Error("BROKER_HELLO_INVALID");
  const kind = principal.kind; if (kind !== "human" && kind !== "pi_parent" && kind !== "pi_child") throw new Error("BROKER_HELLO_INVALID");
  if (!Array.isArray(principal.permissions) || principal.permissions.length > 4096 || principal.permissions.some((permission) => typeof permission !== "string" || permission.length === 0 || permission.length > 256)) throw new Error("BROKER_HELLO_INVALID");
  const limits = record(frame.limits); if (!Number.isSafeInteger(limits.maxLineBytes) || (limits.maxLineBytes as number) < 1) throw new Error("BROKER_HELLO_INVALID");
  return { v: 1, type: "hello_result", id: expectedId, ok: true, broker: { version: safeString(broker.version), status: safeString(broker.status), lastEventSeq: broker.lastEventSeq as number }, principal: { id: safeString(principal.id), kind, permissions: [...principal.permissions] as string[] }, limits: { maxLineBytes: limits.maxLineBytes as number } };
}
export interface PiServerRequest { id: string; method: string; params: Record<string, unknown>; }
export interface PiBrokerClientOptions { socketPath: string; sessionKey: string; agentId?: string; generation?: number; piSessionId: string; token?: string; secret?: string; onServerRequest?: (request: PiServerRequest) => Promise<unknown>; onControlRequest?: (request: PiServerRequest) => Promise<unknown>; }
export class PiBrokerClient {
  #socket: Socket | undefined;
  #options: PiBrokerClientOptions;
  #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #connected = false;
  #helloId: string | undefined;
  #principal: PiBrokerPrincipal | undefined;
  #serverRequestIds = new Set<string>();
  constructor(options: PiBrokerClientOptions) { this.#options = options; }
  get principal(): PiBrokerPrincipal | undefined { return this.#principal; }
  bindIdentity(agentId: string, generation: number): void { if (!/^[\x21-\x7e]{1,256}$/u.test(agentId) || !Number.isSafeInteger(generation) || generation < 1) throw new Error("PI_REGISTRATION_IDENTITY_INVALID"); if (this.#principal) this.#principal = { ...this.#principal, agentId, generation }; }
  get connected(): boolean { return this.#connected; }
  async connect(): Promise<unknown> {
    if (this.#connected) return { connected: true };
    const socket = await new Promise<Socket>((resolve, reject) => { const s = connect(this.#options.socketPath); s.once("connect", () => resolve(s)); s.once("error", reject); });
    this.#socket = socket; const decoder = new NdjsonDecoder<unknown>((value) => value);
    socket.on("data", (data) => { for (const item of decoder.push(data)) { if (!item.ok || typeof item.value !== "object" || item.value === null) continue; const frame = item.value as Record<string, unknown>; if (typeof frame.id !== "string") continue;
        if (frame.type === "server_request") { void this.handleServerRequest(frame); continue; }
        if (frame.type === "hello_result") { if (frame.id !== this.#helloId) continue; const waiter = this.#pending.get(frame.id); if (!waiter) continue; this.#pending.delete(frame.id); try { waiter.resolve(validateHelloResult(frame, frame.id)); } catch { waiter.reject(new Error("BROKER_HELLO_INVALID")); } continue; }
        if (frame.type !== "response") continue; const waiter = this.#pending.get(frame.id); if (!waiter) continue; this.#pending.delete(frame.id); if (frame.ok === true) waiter.resolve(frame.result); else waiter.reject(new Error("BROKER_REQUEST_FAILED")); } });
    socket.once("close", () => { this.#connected = false; for (const waiter of this.#pending.values()) waiter.reject(new Error("AGENT_DISCONNECTED")); this.#pending.clear(); });
    const auth = this.#options.token && this.#options.agentId !== undefined && this.#options.generation !== undefined ? { kind: "agent_token" as const, token: this.#options.token, agentId: this.#options.agentId, generation: this.#options.generation, piSessionId: this.#options.piSessionId } : { kind: "client_secret" as const, ...(this.#options.secret !== undefined ? { secret: this.#options.secret } : {}) };
    const helloId = createId("evt"); this.#helloId = helloId;
    const hello = await this.raw({ v: 1, type: "hello", id: helloId, client: { kind: this.#options.token && this.#options.agentId !== undefined ? "pi_child" : "pi_parent", name: "pi-herdr-orchestrator", version: "0.1.0", capabilities: ["pi.lifecycle", "pi.controls"] }, sessionKey: this.#options.sessionKey, auth });
    const accepted = hello as HelloResult; this.#connected = true; this.#principal = accepted.principal; return accepted;
  }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> { if (!this.#connected || !this.#socket) throw new Error("AGENT_DISCONNECTED"); return await this.raw({ v: 1, type: "request", id: createId("evt"), method, params }); }
  async register(state: PiSafeState): Promise<{ agentId: string; generation: number; connectionGeneration: number; heartbeatMs: number; permissions: string[] }> { const result = await this.request(this.#options.token ? "agent.register_managed" : "agent.register_adopted", {  adapterVersion: "0.1.0", ...(this.#options.agentId ? { agentId: this.#options.agentId, generation: this.#options.generation } : {}), herdr: { paneId: process.env.HERDR_PANE_ID, terminalId: process.env.HERDR_TERMINAL_ID, detectedKind: "pi", name: process.env.HERDR_AGENT_NAME }, pi: { sessionId: state.sessionId, activity: state.activity, capabilities: state.capabilities } }); const value = record(result); const generationValue = value.generation; const connectionGenerationValue = value.connectionGeneration; const heartbeatMsValue = value.heartbeatMs; if (typeof value.agentId !== "string" || !Number.isSafeInteger(generationValue) || (generationValue as number) < 1 || !Number.isSafeInteger(connectionGenerationValue) || (connectionGenerationValue as number) < 1 || !Number.isSafeInteger(heartbeatMsValue) || (heartbeatMsValue as number) < 1 || !Array.isArray(value.permissions) || value.permissions.some((item) => typeof item !== "string")) throw new Error("PI_REGISTRATION_IDENTITY_INVALID"); const generation = generationValue as number; const connectionGeneration = connectionGenerationValue as number; const heartbeatMs = heartbeatMsValue as number; if (this.#options.token && (value.agentId !== this.#options.agentId || generation !== this.#options.generation)) throw new Error("PI_REGISTRATION_IDENTITY_MISMATCH"); this.bindIdentity(value.agentId, generation); return { agentId: value.agentId, generation, connectionGeneration, heartbeatMs, permissions: [...value.permissions] as string[] }; }
  async heartbeat(state: PiSafeState): Promise<unknown> { return await this.request("agent.heartbeat", { adapterSeq: Date.now(), state: { sessionId: state.sessionId, activity: state.activity, turnIndex: state.turnIndex, contextPercent: state.contextPercent, currentTool: state.currentTool } }); }
  close(): void { this.#socket?.destroy(); this.#socket = undefined; this.#connected = false; }
  private async handleServerRequest(frame: Record<string, unknown>): Promise<void> {
    const socket = this.#socket; if (!socket || typeof frame.method !== "string" || !frame.params || typeof frame.params !== "object") return;
    const id = frame.id as string;
    if (this.#serverRequestIds.has(id)) { socket.write(encodeFrame({ v: 1, type: "server_response", id, ok: false, error: { code: "DUPLICATE_REQUEST", message: "The server request was already handled." } })); return; }
    this.#serverRequestIds.add(id); if (this.#serverRequestIds.size > 256) this.#serverRequestIds.delete(this.#serverRequestIds.values().next().value as string);
    try {
      const request = { id, method: frame.method, params: frame.params as Record<string, unknown> };
      const control = frame.method.startsWith("control.") ? this.#options.onControlRequest : this.#options.onServerRequest;
      if (!control) throw new Error("PI_METHOD_UNAVAILABLE");
      const result = await control(request);
      if (this.#socket === socket) socket.write(encodeFrame({ v: 1, type: "server_response", id, ok: true, result }));
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]{1,64}$/u.test(error.message) ? error.message : "REQUEST_FAILED";
      if (this.#socket === socket) socket.write(encodeFrame({ v: 1, type: "server_response", id, ok: false, error: { code, message: "The Pi adapter rejected the request." } }));
    }
  }
  private async raw(frame: unknown): Promise<unknown> { if (!this.#socket) throw new Error("AGENT_DISCONNECTED"); const id = (frame as Record<string, unknown>).id as string; return await new Promise((resolve, reject) => { this.#pending.set(id, { resolve, reject }); this.#socket!.write(encodeFrame(frame)); }); }

}
