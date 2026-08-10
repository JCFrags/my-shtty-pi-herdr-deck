import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { normalizeEvent, normalizeSnapshot } from "./normalizers.js";
import type { HerdrEvent, HerdrSnapshot } from "./types.js";
export interface HerdrSocketClientOptions {
  socketPath: string;
  timeoutMs?: number;
  maxFrameBytes?: number;
  protocol?: number;
  sessionKey?: string;
  clientId?: string;
}
const id = () => randomUUID();
export class HerdrSocketClient {
  readonly #options: HerdrSocketClientOptions;
  #socket?: Socket;
  constructor(options: HerdrSocketClientOptions) {
    this.#options = options;
  }
  async #connectFresh(): Promise<Socket> {
    const socket = connect(this.#options.socketPath);
    const timeout = this.#options.timeoutMs ?? 5_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("HERDR_TIMEOUT"));
      }, timeout);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", reject);
    });
    this.#socket = socket;
    return socket;
  }
  async #lines(
    socket: Socket,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<Record<string, unknown>>> {
    const max = this.#options.maxFrameBytes ?? 1_048_576;
    const queue: Record<string, unknown>[] = [];
    let pending: (() => void)[] = [];
    let buffer = Buffer.alloc(0),
      closed = false;
    const push = (value: Record<string, unknown>) => {
      queue.push(value);
      pending.shift()?.();
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > max && !buffer.includes(10)) {
        socket.destroy();
        return;
      }
      let i;
      while ((i = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, i);
        buffer = buffer.subarray(i + 1);
        if (line.length > max) {
          socket.destroy();
          return;
        }
        try {
          const value = JSON.parse(line.toString("utf8"));
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error();
          push(value as Record<string, unknown>);
        } catch {
          socket.destroy();
        }
      }
    });
    socket.once("close", () => {
      closed = true;
      pending.splice(0).forEach((wake) => wake());
    });
    signal?.addEventListener("abort", () => socket.destroy(), { once: true });
    return (async function* () {
      while (!closed || queue.length) {
        if (!queue.length)
          await new Promise<void>((resolve) => pending.push(resolve));
        const value = queue.shift();
        if (value) yield value;
      }
    })();
  }
  async #handshake(
    socket: Socket,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<Record<string, unknown>>> {
    const lines = await this.#lines(socket, signal);
    const hello = {
      type: "hello",
      id: id(),
      protocol: this.#options.protocol ?? 17,
      client: this.#options.clientId ?? "pi-herdr-orchestrator",
      ...(this.#options.sessionKey
        ? { sessionKey: this.#options.sessionKey }
        : {}),
    };
    socket.write(JSON.stringify(hello) + "\n");
    const first = await lines.next();
    if (!first.value || first.value.ok === false)
      throw new Error("HERDR_AUTH_FAILED");
    return lines;
  }
  async request<T = unknown>(frame: Record<string, unknown>): Promise<T> {
    const socket = await this.#connectFresh();
    const lines = await this.#handshake(socket);
    const requestId = typeof frame.id === "string" ? frame.id : id();
    socket.write(
      JSON.stringify({
        ...frame,
        type: frame.type ?? "request",
        id: requestId,
      }) + "\n",
    );
    try {
      for await (const value of lines) {
        if (value.id !== requestId) continue;
        if (value.ok === false) throw new Error("HERDR_REQUEST_FAILED");
        return value as T;
      }
      throw new Error("HERDR_DISCONNECTED");
    } finally {
      socket.destroy();
    }
  }
  async snapshot(): Promise<HerdrSnapshot> {
    const value = await this.request({
      type: "request",
      method: "session.snapshot",
    });
    return normalizeSnapshot(
      (value as Record<string, unknown>).result ?? value,
    );
  }
  async subscribe(
    onEvent: (event: HerdrEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const socket = await this.#connectFresh();
    const lines = await this.#handshake(socket, signal);
    const requestId = id();
    socket.write(
      JSON.stringify({
        type: "request",
        id: requestId,
        method: "session.snapshot",
      }) + "\n",
    );
    let snapshotSeen = false;
    try {
      for await (const value of lines) {
        if (value.id === requestId) {
          snapshotSeen = true;
          continue;
        }
        if (!snapshotSeen) continue;
        const event = normalizeEvent(value);
        if (event) onEvent(event);
      }
    } finally {
      socket.destroy();
    }
  }
  async close(): Promise<void> {
    this.#socket?.destroy();
    this.#socket?.unref?.();
  }
}
