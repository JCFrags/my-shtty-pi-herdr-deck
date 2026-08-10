import { connect, type Socket } from "node:net";
import { normalizeEvent, normalizeSnapshot } from "./normalizers.js";
import type { HerdrEvent, HerdrSnapshot } from "./types.js";
export interface HerdrSocketClientOptions {
  socketPath: string;
  timeoutMs?: number;
}
export class HerdrSocketClient {
  readonly #options: HerdrSocketClientOptions;
  #socket?: Socket;
  #buffer = Buffer.alloc(0);
  constructor(options: HerdrSocketClientOptions) {
    this.#options = options;
  }
  async request<T = unknown>(frame: Record<string, unknown>): Promise<T> {
    const socket = await this.connect();
    return await new Promise<T>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        const i = this.#buffer.indexOf(10);
        if (i < 0) return;
        const line = this.#buffer.subarray(0, i);
        this.#buffer = this.#buffer.subarray(i + 1);
        try {
          const value = JSON.parse(line.toString("utf8")) as Record<
            string,
            unknown
          >;
          socket.off("error", reject);
          resolve(value as T);
        } catch {
          reject(new Error("HERDR_INVALID_OUTPUT"));
        }
      };
      socket.once("error", reject);
      socket.on("data", onData);
      socket.write(JSON.stringify(frame) + "\n");
    });
  }
  async snapshot(): Promise<HerdrSnapshot> {
    const value = await this.request({
      type: "request",
      method: "session.snapshot",
    });
    return normalizeSnapshot(value);
  }
  async subscribe(
    onEvent: (event: HerdrEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const socket = await this.connect();
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        let i = this.#buffer.indexOf(10);
        while (i >= 0) {
          const line = this.#buffer.subarray(0, i);
          this.#buffer = this.#buffer.subarray(i + 1);
          i = this.#buffer.indexOf(10);
          try {
            const event = normalizeEvent(JSON.parse(line.toString("utf8")));
            if (event) onEvent(event);
          } catch {
            reject(new Error("HERDR_INVALID_OUTPUT"));
            return;
          }
        }
      };
      socket.on("data", onData);
      socket.once("error", reject);
      signal?.addEventListener(
        "abort",
        () => {
          socket.destroy();
          resolve();
        },
        { once: true },
      );
    });
  }
  async close(): Promise<void> {
    this.#socket?.destroy();
  }
  private connect(): Promise<Socket> {
    if (this.#socket && !this.#socket.destroyed) {
      const socket = this.#socket;
      return Promise.resolve(socket);
    }
    return new Promise((resolve, reject) => {
      const socket = connect(this.#options.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("HERDR_TIMEOUT"));
      }, this.#options.timeoutMs ?? 5000);
      socket.once("connect", () => {
        clearTimeout(timer);
        this.#socket = socket;
        resolve(socket);
      });
      socket.once("error", reject);
    });
  }
}
