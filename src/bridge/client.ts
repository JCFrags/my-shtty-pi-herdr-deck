import { randomUUID } from "node:crypto";
import { PI_COMPATIBILITY_MESSAGE } from "./capabilities.js";
import { createConnection, type Socket } from "node:net";
import {
  encodeFrame,
  NdjsonDecoder,
  type CommandArgsMap,
  type CommandFrame,
  type CommandName,
  type DeckState,
  type HelloFrame,
  type ResultFrame,
  type ServerFrame,
  type StateFrame,
  validateServerFrame,
} from "./protocol.js";

const DEFAULT_RECONNECT_DELAYS_MS = [
  100, 200, 400, 800, 1600, 3200, 5000, 5000,
] as const;
const COMMAND_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 3_000;

export type ClientConnectionStatus =
  | { kind: "disconnected"; reason: string }
  | { kind: "connecting"; attempt: number }
  | { kind: "connected"; paneId: string };

export class BridgeDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeDisconnectedError";
  }
}

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface BridgeClientOptions {
  socketPath: string;
  reconnectDelaysMs?: readonly number[];
  commandTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  socketFactory?: (path: string) => Socket;
  log?: (message: string) => void;
}

export class BridgeClient {
  readonly socketPath: string;
  readonly #reconnectDelaysMs: readonly number[];
  readonly #commandTimeoutMs: number;
  readonly #handshakeTimeoutMs: number;
  readonly #socketFactory: (path: string) => Socket;
  readonly #log: (message: string) => void;
  #socket: Socket | undefined;
  #decoder = new NdjsonDecoder(validateServerFrame);
  #pending = new Map<string, PendingCommand>();
  #statusListeners = new Set<(status: ClientConnectionStatus) => void>();
  #stateListeners = new Set<(state: DeckState) => void>();
  #helloListeners = new Set<(hello: HelloFrame) => void>();
  #reconnectTimer: NodeJS.Timeout | undefined;
  #handshakeTimer: NodeJS.Timeout | undefined;
  #attempt = 0;
  #manualStop = true;
  #helloReceived = false;
  #lastStateSeq = 0;
  #status: ClientConnectionStatus = {
    kind: "disconnected",
    reason: "Not connected.",
  };
  #state: DeckState | undefined;

  constructor(options: BridgeClientOptions) {
    this.socketPath = options.socketPath;
    this.#reconnectDelaysMs =
      options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.#handshakeTimeoutMs =
      options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.#socketFactory =
      options.socketFactory ?? ((path) => createConnection(path));
    this.#log = options.log ?? (() => undefined);
  }

  get status(): ClientConnectionStatus {
    return this.#status;
  }

  get state(): DeckState | undefined {
    return this.#state;
  }

  get connected(): boolean {
    return (
      this.#status.kind === "connected" &&
      this.#helloReceived &&
      Boolean(this.#socket && !this.#socket.destroyed)
    );
  }

  start(): void {
    if (!this.#manualStop) return;
    this.#manualStop = false;
    this.#attempt = 0;
    this.#connectNow();
  }

  stop(reason = "Disconnected."): void {
    this.#manualStop = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    this.#reconnectTimer = undefined;
    this.#handshakeTimer = undefined;
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#helloReceived = false;
    this.#rejectPending(reason);
    this.#setStatus({ kind: "disconnected", reason });
  }

  onStatus(listener: (status: ClientConnectionStatus) => void): () => void {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => this.#statusListeners.delete(listener);
  }

  onState(listener: (state: DeckState) => void): () => void {
    this.#stateListeners.add(listener);
    if (this.#state) listener(this.#state);
    return () => this.#stateListeners.delete(listener);
  }

  onHello(listener: (hello: HelloFrame) => void): () => void {
    this.#helloListeners.add(listener);
    return () => this.#helloListeners.delete(listener);
  }

  send<N extends CommandName>(
    name: N,
    args: CommandArgsMap[N],
  ): Promise<unknown> {
    if (!this.connected || !this.#socket) {
      return Promise.reject(
        new BridgeDisconnectedError(
          "Pi Deck is disconnected; the command was not queued.",
        ),
      );
    }
    const id = randomUUID();
    const frame = { type: "command", id, name, args } as CommandFrame<N>;
    let encoded: Buffer;
    try {
      encoded = encodeFrame(frame);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("Command encoding failed."),
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Command ${name} timed out.`));
      }, this.#commandTimeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket!.write(encoded, (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(error);
      });
    });
  }

  #connectNow(): void {
    if (this.#manualStop) return;
    if (this.#attempt >= this.#reconnectDelaysMs.length + 1) {
      this.#setStatus({
        kind: "disconnected",
        reason: "Reconnect limit reached.",
      });
      return;
    }
    this.#attempt += 1;
    this.#setStatus({ kind: "connecting", attempt: this.#attempt });
    this.#decoder.reset();
    this.#helloReceived = false;
    this.#lastStateSeq = 0;
    const socket = this.#socketFactory(this.socketPath);
    this.#socket = socket;
    socket.setNoDelay?.(true);
    this.#handshakeTimer = setTimeout(() => {
      this.#handshakeTimer = undefined;
      if (!this.#helloReceived)
        socket.destroy(new Error("Bridge hello timed out."));
    }, this.#handshakeTimeoutMs);
    this.#handshakeTimer.unref?.();
    socket.on("data", (chunk) =>
      this.#handleData(
        socket,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ),
    );
    socket.once("error", (error) =>
      this.#log(`bridge connection error: ${error.message}`),
    );
    socket.once("close", () => this.#handleClose(socket));
  }

  #handleData(socket: Socket, chunk: Buffer): void {
    if (socket !== this.#socket) return;
    for (const decoded of this.#decoder.push(chunk)) {
      if (!decoded.ok) {
        this.#log(`discarded bridge frame: ${decoded.error.message}`);
        continue;
      }
      this.#handleFrame(decoded.value);
    }
  }

  #handleFrame(frame: ServerFrame): void {
    if (frame.type === "hello") {
      this.#handleHello(frame);
      return;
    }
    if (frame.type === "state") {
      this.#handleState(frame);
      return;
    }
    this.#handleResult(frame);
  }

  #handleHello(frame: HelloFrame): void {
    if (this.#helloReceived) {
      this.#socket?.destroy(new Error("Duplicate bridge hello."));
      return;
    }
    this.#helloReceived = true;
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
    this.#lastStateSeq = frame.seq;
    for (const listener of this.#helloListeners) listener(frame);
    const capabilities = frame.payload.capabilities;
    if (
      frame.payload.accepted &&
      (!capabilities.mouse ||
        !capabilities.perToolExpansion ||
        !capabilities.bulkToolExpansion ||
        !capabilities.expansionSubscription)
    ) {
      this.#manualStop = true;
      this.#setStatus({
        kind: "disconnected",
        reason: PI_COMPATIBILITY_MESSAGE,
      });
      this.#socket?.end();
      return;
    }
    if (
      !frame.payload.accepted ||
      frame.payload.readOnly ||
      !frame.payload.controller
    ) {
      const reason =
        frame.payload.reason ?? "Bridge rejected the controller connection.";
      this.#manualStop = true;
      this.#setStatus({ kind: "disconnected", reason });
      this.#socket?.end();
      return;
    }
    this.#attempt = 0;
    this.#setStatus({ kind: "connected", paneId: frame.payload.paneId });
  }

  #handleState(frame: StateFrame): void {
    if (!this.#helloReceived || !this.connected) return;
    if (frame.seq <= this.#lastStateSeq) return;
    this.#lastStateSeq = frame.seq;
    this.#state = frame.payload;
    for (const listener of this.#stateListeners) listener(frame.payload);
  }

  #handleResult(frame: ResultFrame): void {
    const pending = this.#pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.value);
    else
      pending.reject(
        Object.assign(new Error(frame.error.message), {
          code: frame.error.code,
        }),
      );
  }

  #handleClose(socket: Socket): void {
    if (socket !== this.#socket) return;
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
    this.#socket = undefined;
    this.#helloReceived = false;
    this.#rejectPending(
      "Bridge disconnected; in-flight commands were not queued for retry.",
    );
    if (this.#manualStop) return;
    const delayIndex = Math.min(
      Math.max(0, this.#attempt - 1),
      this.#reconnectDelaysMs.length - 1,
    );
    const delay = this.#reconnectDelaysMs[delayIndex];
    if (delay === undefined || this.#attempt > this.#reconnectDelaysMs.length) {
      this.#manualStop = true;
      this.#setStatus({
        kind: "disconnected",
        reason: "Reconnect limit reached.",
      });
      return;
    }
    this.#setStatus({
      kind: "disconnected",
      reason: `Connection lost; retrying (${this.#attempt}/${this.#reconnectDelaysMs.length}).`,
    });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connectNow();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #rejectPending(reason: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeDisconnectedError(reason));
    }
    this.#pending.clear();
  }

  #setStatus(status: ClientConnectionStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }
}
