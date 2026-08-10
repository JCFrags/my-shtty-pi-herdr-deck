import { connect, type Socket } from "node:net";
import { createId } from "../shared/ids.js";
import { encodeFrame, NdjsonDecoder } from "../shared/protocol/codec.js";
import type { PiSafeState } from "./types.js";
export interface PiBrokerPrincipal { id: string; kind: "human" | "pi_parent" | "pi_child"; permissions: string[]; }
export interface PiServerRequest { id: string; method: string; params: Record<string, unknown>; }
export interface PiBrokerClientOptions { socketPath: string; sessionKey: string; agentId?: string; generation?: number; piSessionId: string; token?: string; secret?: string; onServerRequest?: (request: PiServerRequest) => Promise<unknown>; }
export class PiBrokerClient {
  #socket: Socket | undefined;
  #options: PiBrokerClientOptions;
  #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #connected = false;
  #principal: PiBrokerPrincipal | undefined;
  constructor(options: PiBrokerClientOptions) { this.#options = options; }
  get principal(): PiBrokerPrincipal | undefined { return this.#principal; }
  get connected(): boolean { return this.#connected; }
  async connect(): Promise<unknown> {
    if (this.#connected) return { connected: true };
    const socket = await new Promise<Socket>((resolve, reject) => { const s = connect(this.#options.socketPath); s.once("connect", () => resolve(s)); s.once("error", reject); });
    this.#socket = socket; const decoder = new NdjsonDecoder<unknown>((value) => value);
    socket.on("data", (data) => { for (const item of decoder.push(data)) { if (!item.ok || typeof item.value !== "object" || item.value === null) continue; const frame = item.value as Record<string, unknown>; if (typeof frame.id !== "string") continue;
        if (frame.type === "server_request") { void this.handleServerRequest(frame); continue; }
        if (frame.type !== "response") continue; const waiter = this.#pending.get(frame.id); if (!waiter) continue; this.#pending.delete(frame.id); if (frame.ok === true) waiter.resolve(frame.result); else waiter.reject(new Error("BROKER_REQUEST_FAILED")); } });
    socket.once("close", () => { this.#connected = false; for (const waiter of this.#pending.values()) waiter.reject(new Error("AGENT_DISCONNECTED")); this.#pending.clear(); });
    const auth = this.#options.token && this.#options.agentId !== undefined && this.#options.generation !== undefined ? { kind: "agent_token" as const, token: this.#options.token, agentId: this.#options.agentId, generation: this.#options.generation, piSessionId: this.#options.piSessionId } : { kind: "client_secret" as const, ...(this.#options.secret !== undefined ? { secret: this.#options.secret } : {}) };
    const hello = await this.raw({ v: 1, type: "hello", id: createId("evt"), client: { kind: this.#options.token && this.#options.agentId !== undefined ? "pi_child" : "pi_parent", name: "pi-herdr-orchestrator", version: "0.1.0", capabilities: ["pi.lifecycle", "pi.controls"] }, sessionKey: this.#options.sessionKey, auth });
    this.#connected = true;
    if (hello && typeof hello === "object" && "principal" in hello) {
      const principal = (hello as { principal?: unknown }).principal;
      if (principal && typeof principal === "object") {
        const p = principal as Record<string, unknown>;
        if (typeof p.id === "string" && (p.kind === "human" || p.kind === "pi_parent" || p.kind === "pi_child") && Array.isArray(p.permissions) && p.permissions.every((v) => typeof v === "string")) this.#principal = { id: p.id, kind: p.kind, permissions: [...p.permissions] };
      }
    }
    return hello;
  }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> { if (!this.#connected || !this.#socket) throw new Error("AGENT_DISCONNECTED"); return await this.raw({ v: 1, type: "request", id: createId("evt"), method, params }); }
  async register(state: PiSafeState): Promise<unknown> { return await this.request(this.#options.token ? "agent.register_managed" : "agent.register_adopted", { adapterVersion: "0.1.0", ...(this.#options.agentId ? { agentId: this.#options.agentId, generation: this.#options.generation } : {}), herdr: { paneId: process.env.HERDR_PANE_ID, terminalId: process.env.HERDR_TERMINAL_ID, detectedKind: "pi", name: process.env.HERDR_AGENT_NAME }, pi: { sessionId: state.sessionId, activity: state.activity, capabilities: state.capabilities } }); }
  async heartbeat(state: PiSafeState): Promise<unknown> { return await this.request("agent.heartbeat", { adapterSeq: Date.now(), state: { sessionId: state.sessionId, activity: state.activity, turnIndex: state.turnIndex, contextPercent: state.contextPercent, currentTool: state.currentTool } }); }
  close(): void { this.#socket?.destroy(); this.#socket = undefined; this.#connected = false; }
  private async handleServerRequest(frame: Record<string, unknown>): Promise<void> {
    if (!this.#socket || typeof frame.method !== "string" || !frame.params || typeof frame.params !== "object") return;
    try {
      const result = await this.#options.onServerRequest?.({ id: frame.id as string, method: frame.method, params: frame.params as Record<string, unknown> });
      this.#socket.write(encodeFrame({ v: 1, type: "response", id: frame.id, ok: true, result }));
    } catch (error) {
      const code = error instanceof Error && error.message.length <= 128 ? error.message : "REQUEST_FAILED";
      this.#socket.write(encodeFrame({ v: 1, type: "response", id: frame.id, ok: false, error: { code, message: "The Pi adapter rejected the request." } }));
    }
  }
  private async raw(frame: unknown): Promise<unknown> { if (!this.#socket) throw new Error("AGENT_DISCONNECTED"); const id = (frame as Record<string, unknown>).id as string; return await new Promise((resolve, reject) => { this.#pending.set(id, { resolve, reject }); this.#socket!.write(encodeFrame(frame)); }); }

}
