import { connect, type Socket } from "node:net";
import { TextDecoder } from "node:util";
import { randomUUID } from "node:crypto";
import { normalizeEvent, normalizeSnapshot } from "./normalizers.js";
import type { HerdrEvent, HerdrSnapshot } from "./types.js";
import { LIMITS } from "../shared/limits.js";

export interface HerdrSocketClientOptions {
  socketPath: string;
  timeoutMs?: number;
  maxFrameBytes?: number;
  protocol?: number;
  sessionKey?: string;
  clientId?: string;
  reconnectDelaysMs?: readonly number[];
  /** Maximum fresh connections, including the initial attempt. */
  maxReconnectAttempts?: number;
  connectSocket?: (path: string) => Socket;
}
const id = () => randomUUID();

/** Strict protocol-17 client. It never trusts a resumed stream without a fresh snapshot. */
export class HerdrSocketClient {
  readonly #options: HerdrSocketClientOptions;
  #socket?: Socket;
  constructor(options: HerdrSocketClientOptions) {
    this.#options = options;
  }

  async #connectFresh(signal?: AbortSignal): Promise<Socket> {
    if (signal?.aborted) throw new Error("HERDR_ABORTED");
    const socket = (this.#options.connectSocket ?? connect)(
      this.#options.socketPath,
    );
    const timeout = this.#options.timeoutMs ?? 5_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("HERDR_TIMEOUT"));
      }, timeout);
      const abort = () => {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error("HERDR_ABORTED"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
    });
    this.#socket = socket;
    return socket;
  }

  async #frames(
    socket: Socket,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<Record<string, unknown>>> {
    const max = Math.min(
      this.#options.maxFrameBytes ?? LIMITS.maxLineBytes,
      LIMITS.maxLineBytes,
    );
    const queue: Record<string, unknown>[] = [];
    const wake: (() => void)[] = [];
    let buffer = Buffer.alloc(0),
      closed = false,
      invalid: Error | undefined;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    socket.on("data", (chunk: Buffer) => {
      if (closed) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > max && !buffer.includes(10)) {
        invalid = new Error("FRAME_TOO_LARGE");
        socket.destroy();
        return;
      }
      while (true) {
        const end = buffer.indexOf(10);
        if (end < 0) break;
        const line = buffer.subarray(0, end);
        buffer = buffer.subarray(end + 1);
        if (line.length > max) {
          invalid = new Error("FRAME_TOO_LARGE");
          socket.destroy();
          return;
        }
        try {
          const parsed = JSON.parse(decoder.decode(line));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("MALFORMED_FRAME");
          queue.push(parsed as Record<string, unknown>);
          wake.shift()?.();
        } catch (error) {
          invalid = new Error(
            error instanceof Error && error.message === "FRAME_TOO_LARGE"
              ? error.message
              : "MALFORMED_FRAME",
          );
          socket.destroy();
          return;
        }
      }
    });
    socket.once("close", () => {
      closed = true;
      wake.splice(0).forEach((f) => f());
    });
    signal?.addEventListener(
      "abort",
      () => {
        invalid = new Error("HERDR_ABORTED");
        socket.destroy();
      },
      { once: true },
    );
    return (async function* () {
      while (!closed || queue.length) {
        if (!queue.length)
          await new Promise<void>((resolve) => wake.push(resolve));
        const value = queue.shift();
        if (value) yield value;
      }
      if (invalid) throw invalid;
    })();
  }

  async #handshake(
    socket: Socket,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<Record<string, unknown>>> {
    const frames = await this.#frames(socket, signal);
    const helloId = id();
    socket.write(
      JSON.stringify({
        type: "hello",
        id: helloId,
        protocol: this.#options.protocol ?? 17,
        client: this.#options.clientId ?? "pi-herdr-orchestrator",
        ...(this.#options.sessionKey
          ? { sessionKey: this.#options.sessionKey }
          : {}),
      }) + "\n",
    );
    while (true) {
      const next = await frames.next();
      if (next.done) throw new Error("HERDR_DISCONNECTED");
      const frame = next.value;
      if (frame.id !== helloId) continue;
      if (frame.ok === false) throw new Error("HERDR_AUTH_FAILED");
      return frames;
    }
  }

  async request<T = unknown>(
    frame: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const socket = await this.#connectFresh(signal);
    const frames = await this.#handshake(socket, signal);
    const requestId = typeof frame.id === "string" ? frame.id : id();
    socket.write(
      JSON.stringify({
        ...frame,
        type: frame.type ?? "request",
        id: requestId,
      }) + "\n",
    );
    try {
      for await (const value of frames) {
        if (value.id !== requestId) continue;
        if (value.ok === false) throw new Error("HERDR_REQUEST_FAILED");
        return value as T;
      }
      throw new Error("HERDR_DISCONNECTED");
    } finally {
      socket.destroy();
    }
  }
  async snapshot(signal?: AbortSignal): Promise<HerdrSnapshot> {
    const value = await this.request(
      { type: "request", method: "session.snapshot", params: {} },
      signal,
    );
    return normalizeSnapshot(
      (value as Record<string, unknown>).result ?? value,
    );
  }
  async subscribe(
    onEvent: (event: HerdrEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let cursor = 0;
    let first = true;
    let attempts = 0;
    const delays = this.#options.reconnectDelaysMs ?? [50, 100, 250];
    const maxAttempts = Math.max(
      1,
      this.#options.maxReconnectAttempts ?? delays.length + 1,
    );
    while (!signal?.aborted && attempts < maxAttempts) {
      attempts++;
      let socket: Socket | undefined;
      try {
        socket = await this.#connectFresh(signal);
        const frames = await this.#handshake(socket, signal);
        const snapshotId = id();
        socket.write(
          JSON.stringify({
            type: "request",
            id: snapshotId,
            method: "session.snapshot",
            params: {},
          }) + "\n",
        );
        let snapshot: HerdrSnapshot | undefined;
        while (!snapshot) {
          const next = await frames.next();
          if (next.done) throw new Error("HERDR_DISCONNECTED");
          const frame = next.value;
          if (frame.id !== snapshotId) continue;
          if (frame.ok === false) throw new Error("HERDR_REQUEST_FAILED");
          snapshot = normalizeSnapshot(frame.result ?? frame);
          cursor = snapshot.sequence ?? cursor;
        }
        const subscribeId = id();
        socket.write(
          JSON.stringify({
            type: "request",
            id: subscribeId,
            method: "events.subscribe",
            params: {
              fromSeq: cursor,
              cursor,
              filters: {},
              includeSnapshot: false,
            },
          }) + "\n",
        );
        let acknowledged = false;
        for await (const frame of frames) {
          if (frame.id === subscribeId) {
            if (frame.ok === false) throw new Error("HERDR_REQUEST_FAILED");
            acknowledged = true;
            continue;
          }
          if (!acknowledged) continue;
          const event = normalizeEvent(frame);
          if (event) {
            if (event.sequence !== undefined) cursor = event.sequence;
            onEvent(event);
          }
        }
        if (signal?.aborted) break;
        throw new Error("HERDR_DISCONNECTED");
      } catch (error) {
        socket?.destroy();
        if (signal?.aborted) break;
        const delay =
          delays[
            Math.min(
              delays.length - 1,
              first ? 0 : Math.max(0, delays.length - 1),
            )
          ] ?? 250;
        first = false;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (error instanceof Error && error.message === "HERDR_ABORTED") break;
      } finally {
        socket?.destroy();
      }
    }
    if (!signal?.aborted && attempts >= maxAttempts)
      throw new Error("HERDR_RECONNECT_EXHAUSTED");
  }
  async close(): Promise<void> {
    this.#socket?.destroy();
    this.#socket?.unref?.();
  }
}
