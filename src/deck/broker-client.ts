import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { readPrivateRegular } from "../shared/private-fs.js";
import { sessionKey, siblingPath } from "../shared/paths.js";
import { encodeFrame, NdjsonDecoder } from "../shared/protocol/codec.js";
import type { DeckEvent } from "./types.js";
import type { QuestionAnswer } from "./actions.js";
import { DeckStore, snapshotFromBroker } from "./store.js";

export type BrokerStatus =
  "disconnected" | "connecting" | "connected" | "reconnecting";
export interface BrokerClientOptions {
  socketPath: string;
  secret?: string;
  secretPath?: string;
  sessionKey?: string;
  clientName?: string;
  reconnectDelaysMs?: readonly number[];
  socketFactory?: (path: string) => Socket;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}
const delays = [100, 200, 400, 800, 1600, 3200, 5000] as const;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export class BrokerClient {
  readonly store: DeckStore;
  readonly socketPath: string;
  #secret: string | undefined;
  #secretPath: string;
  #sessionKey: string;
  #name: string;
  #delays: readonly number[];
  #factory: (path: string) => Socket;
  #socket: Socket | undefined;
  #decoder = new NdjsonDecoder<unknown>((value) => value);
  #pending = new Map<string, Pending>();
  #status: BrokerStatus = "disconnected";
  #listeners = new Set<(status: BrokerStatus) => void>();
  #timer: NodeJS.Timeout | undefined;
  #attempt = 0;
  #helloId: string | undefined;
  #authenticated = false;
  #stopped = true;

  constructor(options: BrokerClientOptions, store = new DeckStore()) {
    this.socketPath = options.socketPath;
    this.#secret = options.secret;
    this.#secretPath =
      options.secretPath ?? siblingPath(options.socketPath, "client.secret");
    this.#sessionKey = options.sessionKey ?? sessionKey(options.socketPath);
    this.#name = options.clientName ?? "pi-herdr-deck";
    this.#delays = options.reconnectDelaysMs ?? delays;
    this.#factory = options.socketFactory ?? ((path) => createConnection(path));
    this.store = store;
  }
  get status(): BrokerStatus {
    return this.#status;
  }
  onStatus(listener: (status: BrokerStatus) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#status);
    return () => this.#listeners.delete(listener);
  }
  waitForReady(timeoutMs = 10_000): Promise<void> {
    if (this.#status === "connected") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            "Broker authentication or snapshot subscription timed out.",
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      const listener = (status: BrokerStatus): void => {
        if (status === "connected") {
          cleanup();
          resolve();
        } else if (status === "disconnected" && this.#stopped) {
          cleanup();
          reject(
            new Error(
              "Broker connection closed before authenticated startup completed.",
            ),
          );
        }
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.#listeners.delete(listener);
      };
      this.#listeners.add(listener);
    });
  }
  async start(): Promise<void> {
    if (!this.#secret)
      this.#secret = (await readPrivateRegular(this.#secretPath)).trimEnd();
    this.#stopped = false;
    this.#attempt = 0;
    this.#connect();
  }
  stop(reason = "Client stopped."): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#helloId = undefined;
    this.#authenticated = false;
    this.#reject(new Error(reason));
    this.#setStatus("disconnected");
  }
  async request(
    method: string,
    params: Record<string, unknown> = {},
    idempotencyKey?: string,
  ): Promise<unknown> {
    if (this.#status !== "connected")
      throw new Error("Broker is disconnected; request was not queued.");
    return await this.#requestAuthenticated(method, params, idempotencyKey);
  }
  async subscribe(): Promise<unknown> {
    const result = record(
      await this.#requestAuthenticated("events.subscribe", {
        fromSeq: this.store.state.seq,
        includeSnapshot: true,
      }),
    );
    this.#applySnapshot(result.snapshot);
    return result;
  }
  async refresh(): Promise<unknown> {
    const result = record(
      await this.request("events.subscribe", {
        fromSeq: this.store.state.seq,
        includeSnapshot: true,
      }),
    );
    this.#applySnapshot(result.snapshot);
    return result;
  }
  async answer(questionId: string, answer: QuestionAnswer): Promise<unknown> {
    return await this.request("question.answer", { questionId, answer });
  }
  #connect(): void {
    if (this.#stopped) return;
    this.#setStatus(this.#attempt ? "reconnecting" : "connecting");
    const socket = this.#factory(this.socketPath);
    this.#socket = socket;
    this.#decoder = new NdjsonDecoder((value) => value);
    this.#helloId = randomUUID();
    this.#authenticated = false;
    socket.on("data", (chunk) => this.#data(socket, chunk));
    socket.once("error", () => undefined);
    socket.once("close", () => this.#close(socket));
    socket.write(
      encodeFrame({
        v: 1,
        type: "hello",
        id: this.#helloId,
        client: {
          kind: "deck",
          name: this.#name,
          version: "0.1.0",
          capabilities: ["snapshot", "replay", "actions"],
        },
        sessionKey: this.#sessionKey,
        auth: { kind: "client_secret", secret: this.#secret },
      }),
    );
  }
  #data(socket: Socket, chunk: Buffer): void {
    if (socket !== this.#socket) return;
    for (const item of this.#decoder.push(chunk))
      if (item.ok) this.#frame(item.value);
  }
  #frame(value: unknown): void {
    const frame = record(value);
    if (frame.type === "hello_result") {
      if (frame.id !== this.#helloId) return;
      this.#helloId = undefined;
      if (frame.ok !== true) {
        this.#closeSocket(new Error("Broker authentication failed."));
        return;
      }
      this.#authenticated = true;
      void this.subscribe()
        .then(() => {
          this.#attempt = 0;
          this.#setStatus("connected");
        })
        .catch(() =>
          this.#closeSocket(new Error("Broker subscription failed.")),
        );
      return;
    }
    if (frame.type === "event") {
      if (!this.#authenticated) return;
      const event = frame as unknown as DeckEvent;
      this.store.apply(event);
      return;
    }
    if (typeof frame.id === "string") {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(frame.id);
      if (frame.ok === true) pending.resolve(frame.result);
      else
        pending.reject(
          new Error(
            (record(frame.error).message as string) ?? "Broker request failed.",
          ),
        );
    }
  }
  async #requestAuthenticated(
    method: string,
    params: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const socket = this.#socket;
    if (!this.#authenticated || !socket)
      throw new Error("Broker is disconnected; request was not queued.");
    const id = randomUUID();
    const frame = {
      v: 1,
      type: "request",
      id,
      method,
      params,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    const encoded = encodeFrame(frame);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Broker request timed out: ${method}`));
      }, 10000);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      socket.write(encoded, (error) => {
        if (error) {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(error);
        }
      });
    });
  }
  #closeSocket(error: Error): void {
    this.#socket?.destroy(error);
  }
  #close(socket: Socket): void {
    if (socket !== this.#socket) return;
    this.#socket = undefined;
    this.#helloId = undefined;
    this.#authenticated = false;
    this.#reject(
      new Error("Broker disconnected; in-flight request was not queued."),
    );
    if (this.#stopped) return;
    if (this.#attempt >= this.#delays.length) {
      this.#stopped = true;
      this.#setStatus("disconnected");
      return;
    }
    const delay = this.#delays[this.#attempt++] ?? 0;
    this.#setStatus("disconnected");
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#connect();
    }, delay);
    this.#timer.unref?.();
  }
  #applySnapshot(value: unknown): void {
    if (!value) return;
    const snapshot = snapshotFromBroker(value);
    if (
      Number.isSafeInteger(snapshot.seq) &&
      snapshot.seq >= this.store.state.seq
    )
      this.store.replace(snapshot);
  }
  #reject(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
  #setStatus(status: BrokerStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }
}
