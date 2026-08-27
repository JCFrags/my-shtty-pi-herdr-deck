import { connect, type Socket } from "node:net";
import { createId } from "../shared/ids.js";
import { encodeFrame, NdjsonDecoder } from "../shared/protocol/codec.js";
import type { PiSafeState } from "./types.js";

const MAX_RECENT_RESPONSE_IDS = 4096;

export interface PiBrokerPrincipal {
  id: string;
  kind: "human" | "pi_parent" | "pi_child";
  permissions: string[];
  agentId?: string;
  generation?: number;
  piSessionId?: string;
}
interface HelloResult {
  v: 1;
  type: "hello_result";
  id: string;
  ok: true;
  broker: { version: string; status: string; lastEventSeq: number };
  principal: PiBrokerPrincipal;
  limits: { maxLineBytes: number };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("BROKER_HELLO_INVALID");
  return value as Record<string, unknown>;
}
function safeString(value: unknown, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error("BROKER_HELLO_INVALID");
  return value;
}
function validateHelloResult(value: unknown, expectedId: string): HelloResult {
  const frame = record(value);
  const keys = [
    "v",
    "type",
    "id",
    "ok",
    "broker",
    "principal",
    "limits",
    "error",
  ];
  if (
    Object.keys(frame).some((key) => !keys.includes(key)) ||
    frame.v !== 1 ||
    frame.type !== "hello_result" ||
    frame.id !== expectedId ||
    frame.ok !== true ||
    Object.hasOwn(frame, "error") ||
    !Object.hasOwn(frame, "broker") ||
    !Object.hasOwn(frame, "principal") ||
    !Object.hasOwn(frame, "limits")
  )
    throw new Error("BROKER_HELLO_INVALID");
  const broker = record(frame.broker);
  if (
    !exactKeys(broker, ["version", "status", "lastEventSeq"]) ||
    !Object.hasOwn(broker, "version") ||
    !Object.hasOwn(broker, "status") ||
    !Object.hasOwn(broker, "lastEventSeq")
  )
    throw new Error("BROKER_HELLO_INVALID");
  const version = safeString(broker.version);
  const status = safeString(broker.status);
  if (
    !Number.isSafeInteger(broker.lastEventSeq) ||
    (broker.lastEventSeq as number) < 0
  )
    throw new Error("BROKER_HELLO_INVALID");
  const principal = record(frame.principal);
  const principalKeys = [
    "id",
    "kind",
    "permissions",
    "agentId",
    "generation",
    "piSessionId",
  ];
  if (Object.keys(principal).some((key) => !principalKeys.includes(key)))
    throw new Error("BROKER_HELLO_INVALID");
  const kind = principal.kind;
  if (kind !== "human" && kind !== "pi_parent" && kind !== "pi_child")
    throw new Error("BROKER_HELLO_INVALID");
  if (
    !Array.isArray(principal.permissions) ||
    principal.permissions.length > 4096 ||
    principal.permissions.some(
      (permission) =>
        typeof permission !== "string" ||
        permission.length === 0 ||
        Buffer.byteLength(permission, "utf8") > 256,
    )
  )
    throw new Error("BROKER_HELLO_INVALID");
  const limits = record(frame.limits);
  if (
    !exactKeys(limits, ["maxLineBytes"]) ||
    !Number.isSafeInteger(limits.maxLineBytes) ||
    (limits.maxLineBytes as number) < 1 ||
    (limits.maxLineBytes as number) > 16_777_216
  )
    throw new Error("BROKER_HELLO_INVALID");
  const agentId =
    principal.agentId === undefined ? undefined : safeString(principal.agentId);
  const piSessionId =
    principal.piSessionId === undefined
      ? undefined
      : safeString(principal.piSessionId);
  const generation = principal.generation;
  if (
    generation !== undefined &&
    (!Number.isSafeInteger(generation) || (generation as number) < 1)
  )
    throw new Error("BROKER_HELLO_INVALID");
  return {
    v: 1,
    type: "hello_result",
    id: expectedId,
    ok: true,
    broker: { version, status, lastEventSeq: broker.lastEventSeq as number },
    principal: {
      id: safeString(principal.id),
      kind,
      permissions: [...principal.permissions] as string[],
      ...(agentId !== undefined ? { agentId } : {}),
      ...(generation !== undefined ? { generation: generation as number } : {}),
      ...(piSessionId !== undefined ? { piSessionId } : {}),
    },
    limits: { maxLineBytes: limits.maxLineBytes as number },
  };
}
export interface PiServerRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}
export interface PiBrokerEvent {
  seq: number;
  id: string;
  event: string;
  timestamp: string;
  refs: Record<string, string>;
  data: Record<string, unknown>;
}
export interface PiBrokerClientOptions {
  socketPath: string;
  sessionKey: string;
  agentId?: string;
  generation?: number;
  piSessionId: string;
  token?: string;
  secret?: string;
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
  onServerRequest?: (request: PiServerRequest) => Promise<unknown>;
  onControlRequest?: (request: PiServerRequest) => Promise<unknown>;
  onEvent?: (event: PiBrokerEvent) => void;
}
export interface PiHerdrSessionReference {
  source: "herdr:pi";
  agent: "pi";
  kind: "path" | "id";
  value: string;
}
export interface PiRequestOptions {
  timeoutMs?: number;
  idempotencyKey?: string;
}
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function safeErrorDetails(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  )
    return true;
  if (typeof value === "string")
    return (
      Buffer.byteLength(value, "utf8") <= 4096 &&
      !/[\u0000-\u001f\u007f]/u.test(value)
    );
  if (Array.isArray(value))
    return (
      value.length <= 64 &&
      value.every((item) => safeErrorDetails(item, depth + 1))
    );
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      entries.length <= 64 &&
      entries.every(
        ([key, item]) =>
          Buffer.byteLength(key, "utf8") <= 256 &&
          !/(?:token|secret|password|cookie|credential|private.?key|api.?key|socket.?path)/iu.test(
            key,
          ) &&
          safeErrorDetails(item, depth + 1),
      )
    );
  }
  return false;
}
function validResponse(value: Record<string, unknown>): boolean {
  if (
    value.v !== 1 ||
    value.type !== "response" ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    Buffer.byteLength(value.id, "utf8") > 256 ||
    typeof value.method !== "string" ||
    value.method.length === 0 ||
    Buffer.byteLength(value.method, "utf8") > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value.method) ||
    typeof value.ok !== "boolean" ||
    !exactKeys(
      value,
      value.ok
        ? ["v", "type", "id", "method", "ok", "result"]
        : ["v", "type", "id", "method", "ok", "error"],
    )
  )
    return false;
  if (value.ok)
    return Object.hasOwn(value, "result") && !Object.hasOwn(value, "error");
  const error = value.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const e = error as Record<string, unknown>;
  return (
    exactKeys(e, ["code", "message", "retryable", "details", "remediation"]) &&
    typeof e.code === "string" &&
    e.code.length > 0 &&
    e.code.length <= 64 &&
    /^[A-Z0-9_]+$/u.test(e.code) &&
    typeof e.message === "string" &&
    e.message.length > 0 &&
    Buffer.byteLength(e.message, "utf8") <= 4096 &&
    !/[\u0000-\u001f\u007f]/u.test(e.message) &&
    typeof e.retryable === "boolean" &&
    (e.details === undefined || safeErrorDetails(e.details)) &&
    (e.remediation === undefined ||
      (typeof e.remediation === "string" &&
        Buffer.byteLength(e.remediation, "utf8") <= 4096 &&
        !/[\u0000-\u001f\u007f]/u.test(e.remediation)))
  );
}
export class PiBrokerClient {
  #socket: Socket | undefined;
  #options: PiBrokerClientOptions;
  #questionBindings = new Map<string, string>();
  #questionWaiters = new Map<
    string,
    {
      toolCallId: string;
      runId: string;
      questionId?: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  #registrationReady = false;
  #queuedServerRequests: Record<string, unknown>[] = [];
  #pending = new Map<
    string,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  #connected = false;
  #adapterSeq = 0;
  #helloId: string | undefined;
  #principal: PiBrokerPrincipal | undefined;
  #responseIds = new Set<string>();
  #serverRequestIds = new Set<string>();
  constructor(options: PiBrokerClientOptions) {
    this.#options = options;
  }
  get principal(): PiBrokerPrincipal | undefined {
    return this.#principal;
  }
  bindIdentity(agentId: string, generation: number): void {
    if (
      !/^[\x21-\x7e]{1,256}$/u.test(agentId) ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      throw new Error("PI_REGISTRATION_IDENTITY_INVALID");
    if (this.#principal)
      this.#principal = { ...this.#principal, agentId, generation };
  }
  get connected(): boolean {
    return this.#connected;
  }
  async connect(): Promise<unknown> {
    if (this.#connected) return { connected: true };
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(this.#options.socketPath);
      const timer = setTimeout(
        () => {
          s.destroy();
          reject(new Error("BROKER_TIMEOUT"));
        },
        this.timeout(this.#options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS),
      );
      timer.unref?.();
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    this.#socket = socket;
    socket.on("error", () => {
      if (this.#socket === socket)
        this.failClosed(new Error("BROKER_SOCKET_ERROR"));
    });
    this.#registrationReady = false;
    this.#queuedServerRequests = [];
    this.#questionBindings.clear();
    this.#responseIds.clear();
    this.#serverRequestIds.clear();
    const decoder = new NdjsonDecoder<unknown>((value) => value);
    socket.on("data", (data) => {
      if (this.#socket !== socket) return;
      for (const item of decoder.push(data)) {
        if (!item.ok) {
          this.failClosed(item.error);
          return;
        }
        if (
          typeof item.value !== "object" ||
          item.value === null ||
          Array.isArray(item.value)
        ) {
          this.failClosed();
          continue;
        }
        const frame = item.value as Record<string, unknown>;
        if (typeof frame.id !== "string") {
          this.failClosed();
          return;
        }
        if (frame.type === "server_request") {
          void this.handleServerRequest(frame);
          continue;
        }
        if (frame.type === "event") {
          try {
            if (
              !exactKeys(frame, [
                "v",
                "type",
                "seq",
                "id",
                "event",
                "timestamp",
                "refs",
                "data",
              ]) ||
              frame.v !== 1 ||
              !Number.isSafeInteger(frame.seq) ||
              (frame.seq as number) < 1 ||
              typeof frame.event !== "string" ||
              !/^[a-z][a-z0-9_.-]{0,127}$/u.test(frame.event) ||
              typeof frame.timestamp !== "string" ||
              Buffer.byteLength(frame.timestamp, "utf8") > 64 ||
              !frame.refs ||
              typeof frame.refs !== "object" ||
              Array.isArray(frame.refs) ||
              Object.values(frame.refs as Record<string, unknown>).some(
                (value) =>
                  typeof value !== "string" ||
                  Buffer.byteLength(value, "utf8") > 256,
              ) ||
              !frame.data ||
              typeof frame.data !== "object" ||
              Array.isArray(frame.data) ||
              !safeErrorDetails(frame.data)
            )
              throw new Error("BROKER_EVENT_INVALID");
            this.#options.onEvent?.({
              seq: frame.seq as number,
              id: frame.id,
              event: frame.event,
              timestamp: frame.timestamp,
              refs: frame.refs as Record<string, string>,
              data: frame.data as Record<string, unknown>,
            });
          } catch (error) {
            this.failClosed(
              error instanceof Error
                ? error
                : new Error("BROKER_EVENT_INVALID"),
            );
          }
          continue;
        }
        if (frame.type === "hello_result") {
          if (frame.id !== this.#helloId) {
            const waiter = this.#helloId
              ? this.#pending.get(this.#helloId)
              : undefined;
            if (waiter) {
              this.#pending.delete(this.#helloId!);
              waiter.reject(new Error("BROKER_HELLO_INVALID"));
            }
            socket.destroy();
            continue;
          }
          const waiter = this.#pending.get(frame.id);
          if (!waiter) {
            this.failClosed();
            continue;
          }
          this.#pending.delete(frame.id);
          try {
            waiter.resolve(validateHelloResult(frame, frame.id));
          } catch {
            waiter.reject(new Error("BROKER_HELLO_INVALID"));
            socket.destroy();
          }
          continue;
        }
        if (frame.type !== "response") {
          this.failClosed();
          continue;
        }
        if (!validResponse(frame) || this.#responseIds.has(frame.id)) {
          this.failClosed();
          return;
        }
        const waiter = this.#pending.get(frame.id);
        if (!waiter) {
          this.failClosed();
          continue;
        }
        if (waiter.method !== frame.method) {
          this.failClosed(new Error("BROKER_PROTOCOL_INVALID"));
          return;
        }
        if (this.#responseIds.size >= MAX_RECENT_RESPONSE_IDS) {
          const oldestResponseId = this.#responseIds.values().next().value;
          if (oldestResponseId !== undefined)
            this.#responseIds.delete(oldestResponseId);
        }
        this.#responseIds.add(frame.id);
        this.#pending.delete(frame.id);
        if (frame.ok === true) waiter.resolve(frame.result);
        else {
          const error = frame.error as Record<string, unknown>;
          const failure = new Error(String(error.message));
          Object.assign(failure, {
            code: error.code,
            retryable: error.retryable,
            details: error.details,
            remediation: error.remediation,
          });
          waiter.reject(failure);
        }
      }
    });
    socket.once("close", () => {
      if (this.#socket !== socket) return;
      this.#connected = false;
      this.#registrationReady = false;
      this.#queuedServerRequests = [];
      this.#questionBindings.clear();
      this.#socket = undefined;
      for (const waiter of this.#pending.values())
        waiter.reject(new Error("AGENT_DISCONNECTED"));
      this.#pending.clear();
      for (const waiter of this.#questionWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("AGENT_DISCONNECTED"));
      }
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
    const helloId = createId("evt");
    this.#helloId = helloId;
    const hello = await this.raw(
      {
        v: 1,
        type: "hello",
        id: helloId,
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
      },
      this.#options.helloTimeoutMs,
    );
    const accepted = hello as HelloResult;
    this.#connected = true;
    this.#principal = accepted.principal;
    return accepted;
  }
  async request(
    method: string,
    params: Record<string, unknown>,
    options: PiRequestOptions = {},
  ): Promise<unknown> {
    if (!this.#connected || !this.#socket)
      throw new Error("AGENT_DISCONNECTED");
    const frame = {
      v: 1,
      type: "request" as const,
      id: createId("evt"),
      method,
      params,
      ...(options.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
    };
    return await this.raw(frame, options.timeoutMs);
  }
  markRegistrationReady(): void {
    if (!this.#connected) throw new Error("AGENT_DISCONNECTED");
    this.#registrationReady = true;
    const queued = this.#queuedServerRequests.splice(0);
    for (const frame of queued) {
      if (typeof frame.id === "string") this.#serverRequestIds.delete(frame.id);
      void this.handleServerRequest(frame);
    }
  }
  async register(
    state: PiSafeState,
    sessionReference: PiHerdrSessionReference = {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: state.sessionId,
    },
  ): Promise<{
    agentId: string;
    generation: number;
    connectionGeneration: number;
    heartbeatMs: number;
    permissions: string[];
    assignment?: unknown;
  }> {
    const safeName = process.env.HERDR_AGENT_NAME;
    const safeState = {
      activity: state.activity,
      idle: state.idle,
      pendingMessages: state.pendingMessages,
      ...(state.turnIndex !== undefined ? { turnIndex: state.turnIndex } : {}),
      ...(state.contextPercent !== undefined
        ? { contextPercent: state.contextPercent }
        : {}),
      ...(state.currentTool !== undefined
        ? { currentTool: state.currentTool }
        : {}),
      ...(state.model
        ? {
            model: {
              provider: state.model.provider,
              modelId: state.model.id,
            },
          }
        : {}),
      ...(state.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {}),
    };
    const result = await this.request(
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
          ...(process.env.HERDR_TERMINAL_ID
            ? { terminalId: process.env.HERDR_TERMINAL_ID }
            : {}),
          detectedKind: "pi",
          sessionReference,
          ...(safeName &&
          safeName.length <= 256 &&
          !/[\u0000-\u001f\u007f]/u.test(safeName)
            ? { name: safeName }
            : {}),
        },
        pi: {
          sessionId: state.sessionId,
          capabilities: state.capabilities,
          state: safeState,
        },
      },
    );
    const value = record(result);
    if (
      !exactKeys(value, [
        "agentId",
        "generation",
        "connectionGeneration",
        "heartbeatMs",
        "permissions",
        "assignment",
      ])
    )
      throw new Error("PI_REGISTRATION_IDENTITY_INVALID");
    const generationValue = value.generation;
    const connectionGenerationValue = value.connectionGeneration;
    const heartbeatMsValue = value.heartbeatMs;
    if (
      typeof value.agentId !== "string" ||
      Buffer.byteLength(value.agentId, "utf8") === 0 ||
      Buffer.byteLength(value.agentId, "utf8") > 256 ||
      !Number.isSafeInteger(generationValue) ||
      (generationValue as number) < 1 ||
      !Number.isSafeInteger(connectionGenerationValue) ||
      (connectionGenerationValue as number) < 1 ||
      !Number.isSafeInteger(heartbeatMsValue) ||
      (heartbeatMsValue as number) < 100 ||
      (heartbeatMsValue as number) > 60_000 ||
      !Array.isArray(value.permissions) ||
      value.permissions.length > 4096 ||
      value.permissions.some(
        (item) =>
          typeof item !== "string" ||
          Buffer.byteLength(item, "utf8") === 0 ||
          Buffer.byteLength(item, "utf8") > 256 ||
          /[\u0000-\u001f\u007f]/u.test(item),
      )
    )
      throw new Error("PI_REGISTRATION_IDENTITY_INVALID");
    const generation = generationValue as number;
    const connectionGeneration = connectionGenerationValue as number;
    const heartbeatMs = heartbeatMsValue as number;
    if (
      this.#options.token &&
      (value.agentId !== this.#options.agentId ||
        generation !== this.#options.generation)
    )
      throw new Error("PI_REGISTRATION_IDENTITY_MISMATCH");
    this.bindIdentity(value.agentId, generation);
    if (this.#principal)
      this.#principal = {
        ...this.#principal,
        agentId: value.agentId,
        generation,
        permissions: [...value.permissions],
      };
    return {
      agentId: value.agentId,
      generation,
      connectionGeneration,
      heartbeatMs,
      permissions: [...value.permissions] as string[],
      ...(value.assignment !== undefined
        ? { assignment: value.assignment }
        : {}),
    };
  }
  nextAdapterSeq(): number {
    return ++this.#adapterSeq;
  }
  async heartbeat(state: PiSafeState): Promise<unknown> {
    return await this.request("agent.heartbeat", {
      agentId: state.agentId,
      adapterSeq: this.nextAdapterSeq(),
      state: {
        sessionId: state.sessionId,
        activity: state.activity,
        turnIndex: state.turnIndex,
        contextPercent: state.contextPercent,
        currentTool: state.currentTool,
      },
    });
  }
  registerQuestionWaiter(
    toolCallId: string,
    runId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (
      !/^[\x21-\x7e]{1,256}$/u.test(toolCallId) ||
      !/^[\x21-\x7e]{1,256}$/u.test(runId)
    )
      return Promise.reject(new Error("INVALID_REQUEST"));
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 10_000 ||
      timeoutMs > 86_400_000
    )
      return Promise.reject(new Error("INVALID_REQUEST"));
    if (!this.#connected)
      return Promise.reject(new Error("AGENT_DISCONNECTED"));
    if (
      this.#questionWaiters.size >= 16 ||
      this.#questionBindings.has(toolCallId) ||
      [...this.#questionWaiters.values()].some(
        (waiter) => waiter.toolCallId === toolCallId || waiter.runId === runId,
      )
    )
      return Promise.reject(new Error("LIMIT_EXCEEDED"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        for (const [key, waiter] of this.#questionWaiters)
          if (waiter.toolCallId === toolCallId)
            this.#questionWaiters.delete(key);
        this.#questionBindings.delete(toolCallId);
        reject(new Error("TIMEOUT"));
      }, timeoutMs);
      timer.unref?.();
      const abort = () => {
        for (const [key, waiter] of this.#questionWaiters)
          if (waiter.toolCallId === toolCallId)
            this.#questionWaiters.delete(key);
        this.#questionBindings.delete(toolCallId);
        reject(new Error("CANCELLED"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#questionWaiters.set(`tool:${toolCallId}`, {
        toolCallId,
        runId,
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
        timer,
      });
    });
  }
  discardQuestionWaiter(toolCallId: string): void {
    const entry = [...this.#questionWaiters.entries()].find(
      ([, waiter]) => waiter.toolCallId === toolCallId,
    );
    this.#questionBindings.delete(toolCallId);
    if (!entry) return;
    this.#questionWaiters.delete(entry[0]);
    entry[1].resolve({ state: "cancelled" });
  }
  cancelQuestionWaiter(
    toolCallId: string,
    error = new Error("CANCELLED"),
  ): void {
    const entry = [...this.#questionWaiters.entries()].find(
      ([, waiter]) => waiter.toolCallId === toolCallId,
    );
    this.#questionBindings.delete(toolCallId);
    if (!entry) return;
    this.#questionWaiters.delete(entry[0]);
    entry[1].reject(error);
  }
  questionIdForToolCall(toolCallId: string): string | undefined {
    return this.#questionBindings.get(toolCallId);
  }
  bindQuestionWaiter(toolCallId: string, questionId: string): void {
    const existing = this.#questionBindings.get(toolCallId);
    if (existing !== undefined) {
      if (existing !== questionId) throw new Error("QUESTION_DELIVERY_INVALID");
      return;
    }
    const waiter = [...this.#questionWaiters.entries()].find(
      ([, item]) => item.toolCallId === toolCallId,
    )?.[1];
    if (!waiter) throw new Error("QUESTION_WAITER_MISSING");
    waiter.questionId = questionId;
    this.#questionBindings.set(toolCallId, questionId);
  }
  resolveQuestionDelivery(
    questionId: string,
    runId: string,
    toolCallId: string,
    value: unknown,
  ): boolean {
    const entry = [...this.#questionWaiters.entries()].find(
      ([, waiter]) =>
        waiter.toolCallId === toolCallId &&
        waiter.runId === runId &&
        (waiter.questionId === undefined || waiter.questionId === questionId),
    );
    if (!entry) return false;
    entry[1].questionId = questionId;
    this.#questionBindings.set(toolCallId, questionId);
    this.#questionWaiters.delete(entry[0]);
    entry[1].resolve(value);
    return true;
  }
  close(): void {
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#connected = false;
    this.#registrationReady = false;
    this.#queuedServerRequests = [];
    this.#questionBindings.clear();
    for (const waiter of this.#pending.values())
      waiter.reject(new Error("AGENT_DISCONNECTED"));
    this.#pending.clear();
    for (const waiter of this.#questionWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("AGENT_DISCONNECTED"));
    }
    this.#questionWaiters.clear();
  }
  private failClosed(error = new Error("BROKER_PROTOCOL_INVALID")): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#connected = false;
    this.#registrationReady = false;
    this.#queuedServerRequests = [];
    this.#questionBindings.clear();
    socket?.destroy();
    for (const waiter of this.#pending.values()) waiter.reject(error);
    this.#pending.clear();
    for (const waiter of this.#questionWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#questionWaiters.clear();
  }
  private timeout(value: number): number {
    if (!Number.isSafeInteger(value) || value < 100 || value > MAX_TIMEOUT_MS)
      throw new Error("INVALID_REQUEST");
    return value;
  }
  private async handleServerRequest(
    frame: Record<string, unknown>,
  ): Promise<void> {
    const socket = this.#socket;
    if (!socket) return;
    let id: string;
    try {
      if (
        !exactKeys(frame, ["v", "type", "id", "method", "params"]) ||
        frame.v !== 1 ||
        frame.type !== "server_request" ||
        typeof frame.id !== "string" ||
        frame.id.length === 0 ||
        Buffer.byteLength(frame.id, "utf8") > 256 ||
        /[\u0000-\u001f\u007f]/u.test(frame.id) ||
        typeof frame.method !== "string" ||
        frame.method.length === 0 ||
        Buffer.byteLength(frame.method, "utf8") > 128 ||
        /[\u0000-\u001f\u007f]/u.test(frame.method) ||
        !frame.params ||
        typeof frame.params !== "object" ||
        Array.isArray(frame.params) ||
        Object.keys(frame.params).length > 64 ||
        Buffer.byteLength(JSON.stringify(frame.params), "utf8") > 262_144
      )
        throw new Error("INVALID_REQUEST");
      id = frame.id;
    } catch {
      this.failClosed(new Error("BROKER_PROTOCOL_INVALID"));
      return;
    }
    if (this.#serverRequestIds.has(id)) {
      this.failClosed(new Error("BROKER_PROTOCOL_INVALID"));
      return;
    }
    if (this.#serverRequestIds.size >= 256) {
      this.failClosed();
      return;
    }
    this.#serverRequestIds.add(id);
    if (!this.#registrationReady) {
      if (this.#queuedServerRequests.length >= 8) {
        this.failClosed();
        return;
      }
      this.#queuedServerRequests.push(frame);
      return;
    }
    try {
      const request = {
        id,
        method: frame.method as string,
        params: frame.params as Record<string, unknown>,
      };
      const control = request.method.startsWith("control.")
        ? this.#options.onControlRequest
        : this.#options.onServerRequest;
      if (!control) throw new Error("PI_METHOD_UNAVAILABLE");
      const result = await control(request);
      if (this.#socket === socket)
        socket.write(
          encodeFrame({ v: 1, type: "server_response", id, ok: true, result }),
        );
    } catch (error) {
      const failure = error as Error & {
        code?: unknown;
        remediation?: unknown;
      };
      const code =
        typeof failure.code === "string" &&
        /^[A-Z0-9_]{1,64}$/u.test(failure.code)
          ? failure.code
          : error instanceof Error && /^[A-Z0-9_]{1,64}$/u.test(error.message)
            ? error.message
            : "REQUEST_FAILED";
      const message =
        error instanceof Error &&
        Buffer.byteLength(error.message, "utf8") <= 4096 &&
        !/[\u0000-\u001f\u007f]/u.test(error.message)
          ? error.message
          : "The Pi adapter rejected the request.";
      if (this.#socket === socket)
        socket.write(
          encodeFrame({
            v: 1,
            type: "server_response",
            id,
            ok: false,
            error: {
              code,
              message,
              retryable: false,
              ...(typeof failure.remediation === "string" &&
              Buffer.byteLength(failure.remediation, "utf8") <= 4096
                ? { remediation: failure.remediation }
                : {}),
            },
          }),
        );
    }
  }
  private async raw(frame: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.#socket) throw new Error("AGENT_DISCONNECTED");
    const id = (frame as Record<string, unknown>).id as string;
    const timeout = this.timeout(
      timeoutMs ??
        ((frame as Record<string, unknown>).type === "hello"
          ? (this.#options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS)
          : (this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)),
    );
    return await new Promise((resolve, reject) => {
      const socket = this.#socket;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        socket?.destroy();
        reject(new Error("BROKER_TIMEOUT"));
      }, timeout);
      timer.unref?.();
      this.#pending.set(id, {
        method: String((frame as Record<string, unknown>).method ?? "hello"),
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        socket!.write(encodeFrame(frame));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(
          error instanceof Error ? error : new Error("BROKER_REQUEST_FAILED"),
        );
      }
    });
  }
}
