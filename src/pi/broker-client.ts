import { connect, type Socket } from "node:net";
import { createId } from "../shared/ids.js";
import { encodeFrame, NdjsonDecoder } from "../shared/protocol/codec.js";
import type { PiSafeState } from "./types.js";
export interface PiBrokerClientOptions {
  socketPath: string;
  sessionKey: string;
  agentId?: string;
  generation?: number;
  piSessionId: string;
  token?: string;
  secret?: string;
}
export class PiBrokerClient {
  #socket: Socket | undefined;
  #options: PiBrokerClientOptions;
  #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #questionWaiters = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #connected = false;
  #adapterSeq = 0;
  constructor(options: PiBrokerClientOptions) {
    this.#options = options;
  }
  get connected(): boolean {
    return this.#connected;
  }
  async connect(): Promise<unknown> {
    if (this.#connected) return { connected: true };
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(this.#options.socketPath);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
    this.#socket = socket;
    const decoder = new NdjsonDecoder<unknown>((value) => value);
    socket.on("data", (data) => {
      for (const item of decoder.push(data)) {
        if (!item.ok || typeof item.value !== "object" || item.value === null)
          continue;
        const frame = item.value as Record<string, unknown>;
        if (
          frame.type === "server_request" &&
          frame.method === "question.deliver_answer" &&
          frame.params &&
          typeof frame.params === "object"
        ) {
          const params = frame.params as Record<string, unknown>;
          const toolCallId =
            typeof params.toolCallId === "string"
              ? params.toolCallId
              : undefined;
          const waiter = toolCallId
            ? this.#questionWaiters.get(toolCallId)
            : undefined;
          if (
            waiter &&
            (params.state === "answered" ||
              params.state === "cancelled" ||
              params.state === "timed_out")
          ) {
            if (toolCallId) this.#questionWaiters.delete(toolCallId);
            waiter.resolve(params);
          }
          if (typeof frame.id === "string")
            this.#socket?.write(
              encodeFrame({
                v: 1,
                type: "server_response",
                id: frame.id,
                ok: true,
                result: { accepted: true },
              }),
            );
          continue;
        }
        if (typeof frame.id !== "string" || frame.type !== "response") continue;
        const waiter = this.#pending.get(frame.id);
        if (!waiter) continue;
        this.#pending.delete(frame.id);
        if (frame.ok === true) waiter.resolve(frame.result);
        else waiter.reject(new Error("BROKER_REQUEST_FAILED"));
      }
    });
    socket.once("close", () => {
      this.#connected = false;
      for (const waiter of this.#pending.values())
        waiter.reject(new Error("AGENT_DISCONNECTED"));
      this.#pending.clear();
      for (const waiter of this.#questionWaiters.values())
        waiter.reject(new Error("AGENT_DISCONNECTED"));
      this.#questionWaiters.clear();
    });
    const auth =
      this.#options.token &&
      this.#options.agentId !== undefined &&
      this.#options.generation !== undefined
        ? {
            kind: "agent_token" as const,
            token: this.#options.token,
            agentId: this.#options.agentId,
            generation: this.#options.generation,
            piSessionId: this.#options.piSessionId,
          }
        : {
            kind: "client_secret" as const,
            ...(this.#options.secret !== undefined
              ? { secret: this.#options.secret }
              : {}),
          };
    const hello = await this.raw({
      v: 1,
      type: "hello",
      id: createId("evt"),
      client: {
        kind:
          this.#options.token && this.#options.agentId !== undefined
            ? "pi_child"
            : "pi_parent",
        name: "pi-herdr-orchestrator",
        version: "0.1.0",
        capabilities: ["pi.lifecycle", "pi.controls"],
      },
      sessionKey: this.#options.sessionKey,
      auth,
    });
    this.#connected = true;
    return hello;
  }
  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.#connected || !this.#socket)
      throw new Error("AGENT_DISCONNECTED");
    return await this.raw({
      v: 1,
      type: "request",
      id: createId("evt"),
      method,
      params,
    });
  }
  async register(state: PiSafeState): Promise<unknown> {
    return await this.request(
      this.#options.token ? "agent.register_managed" : "agent.register_adopted",
      {
        adapterVersion: "0.1.0",
        ...(this.#options.agentId
          ? {
              agentId: this.#options.agentId,
              generation: this.#options.generation,
            }
          : {}),
        herdr: {
          paneId: process.env.HERDR_PANE_ID,
          terminalId: process.env.HERDR_TERMINAL_ID,
          detectedKind: "pi",
          name: process.env.HERDR_AGENT_NAME,
        },
        pi: {
          sessionId: state.sessionId,
          activity: state.activity,
          capabilities: state.capabilities,
        },
      },
    );
  }
  async heartbeat(state: PiSafeState): Promise<unknown> {
    return await this.request("agent.heartbeat", {
      agentId: this.#options.agentId,
      adapterSeq: (this.#adapterSeq = Math.max(this.#adapterSeq + 1, Date.now())),
      state: {
        sessionId: state.sessionId,
        activity: state.activity,
        turnIndex: state.turnIndex,
        contextPercent: state.contextPercent,
        currentTool: state.currentTool,
      },
    });
  }
  async questionOpen(input: {
    taskId: string;
    runId: string;
    assignmentGeneration: number;
    toolCallId: string;
    question: unknown;
  }): Promise<unknown> {
    if (!this.#options.agentId) throw new Error("AGENT_ID_REQUIRED");
    const waiter = new Promise<unknown>((resolve, reject) =>
      this.#questionWaiters.set(input.toolCallId, { resolve, reject }),
    );
    try {
      await this.request("question.open", {
        agentId: this.#options.agentId,
        taskId: input.taskId,
        runId: input.runId,
        assignmentGeneration: input.assignmentGeneration,
        toolCallId: input.toolCallId,
        question: input.question,
      });
      return await waiter;
    } finally {
      this.#questionWaiters.delete(input.toolCallId);
    }
  }
  close(): void {
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#connected = false;
  }
  private async raw(frame: unknown): Promise<unknown> {
    if (!this.#socket) throw new Error("AGENT_DISCONNECTED");
    const id = (frame as Record<string, unknown>).id as string;
    return await new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket!.write(encodeFrame(frame));
    });
  }
}
