import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeckController } from "./pi-controller.js";
import { CommandExecutionError } from "./pi-controller.js";
import {
  encodeFrame,
  errorResult,
  NdjsonDecoder,
  PROTOCOL_VERSION,
  type HelloFrame,
  type ResultFrame,
  type StateFrame,
  validateCommandFrame,
} from "./protocol.js";

const SOCKET_MODE = 0o600;
const RUNTIME_MODE = 0o700;
const STATE_PUSH_INTERVAL_MS = 50;
const SOCKET_PROBE_TIMEOUT_MS = 250;
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

export interface RuntimeSocketLocation {
  runtimeDirectory: string;
  socketPath: string;
  sanitizedPaneId: string;
}

export interface BridgeServerOptions {
  controller: DeckController;
  runtimeDirectory?: string;
  statePushIntervalMs?: number;
  log?: (message: string) => void;
}

interface ConnectionState {
  socket: Socket;
  seq: number;
  decoder: NdjsonDecoder<ReturnType<typeof validateCommandFrame>>;
  closed: boolean;
  commandTail: Promise<void>;
}

function sanitizePaneId(paneId: string): string {
  const sanitized = paneId
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return sanitized || "pane";
}

export function runtimeDirectoryFor(
  uid = process.getuid?.() ?? 0,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const base =
    environment.XDG_RUNTIME_DIR && environment.XDG_RUNTIME_DIR.length > 0
      ? environment.XDG_RUNTIME_DIR
      : tmpdir();
  return join(base, `pi-herdr-deck-${uid}`);
}

export function socketLocationForPane(
  paneId: string,
  options: {
    uid?: number;
    environment?: NodeJS.ProcessEnv;
    runtimeDirectory?: string;
  } = {},
): RuntimeSocketLocation {
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const runtimeDirectory =
    options.runtimeDirectory ??
    runtimeDirectoryFor(uid, options.environment ?? process.env);
  const sanitizedBase = sanitizePaneId(paneId);
  const hashSuffix = `-${createHash("sha256").update(paneId).digest("hex").slice(0, 12)}`;
  let sanitizedPaneId = `${sanitizedBase}${hashSuffix}`;
  let socketPath = join(runtimeDirectory, `${sanitizedPaneId}.sock`);
  if (Buffer.byteLength(socketPath, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES) {
    const fixedPath = join(runtimeDirectory, `${hashSuffix}.sock`);
    const budget =
      MAX_UNIX_SOCKET_PATH_BYTES - Buffer.byteLength(fixedPath, "utf8");
    if (budget < 1)
      throw new Error(
        `Unix socket runtime directory is too long: ${runtimeDirectory}`,
      );
    sanitizedPaneId = `${sanitizedBase.slice(0, budget)}${hashSuffix}`;
    socketPath = join(runtimeDirectory, `${sanitizedPaneId}.sock`);
  }
  if (Buffer.byteLength(socketPath, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(`Unix socket path is too long: ${socketPath}`);
  }
  return { runtimeDirectory, socketPath, sanitizedPaneId };
}

async function ensureRuntimeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: RUNTIME_MODE });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Unsafe runtime directory: ${path}`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid)
    throw new Error(`Runtime directory is not owned by uid ${uid}: ${path}`);
  await chmod(path, RUNTIME_MODE);
}

async function unlinkSocketIfPresent(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSocket()) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function closeServerQuietly(server: Server): Promise<void> {
  if (!server.listening) {
    try {
      server.close();
    } catch {
      // A failed listen can leave the server unopened, in which case close() throws ERR_SERVER_NOT_RUNNING.
    }
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function unlinkSocketIfPresentSync(
  path: string,
  log: (message: string) => void,
): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSocket()) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      log(`socket cleanup failed: ${(error as Error).message}`);
  }
}

export async function isSocketListening(
  path: string,
  timeoutMs = SOCKET_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (value: boolean, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(false, new Error(`Timed out probing Unix socket ${path}.`)),
      timeoutMs,
    );
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (
        error.code === "ENOENT" ||
        error.code === "ECONNREFUSED" ||
        error.code === "ECONNRESET"
      )
        finish(false);
      else finish(false, error);
    });
  });
}

export async function recoverStaleSocket(
  path: string,
): Promise<"absent" | "removed"> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (!stat.isSocket())
    throw new Error(`Refusing to remove non-socket path: ${path}`);
  if (await isSocketListening(path))
    throw new Error(`A Pi Deck bridge is already listening at ${path}.`);
  await unlink(path);
  return "removed";
}

export class CompatibilityRejectionServer {
  readonly location: RuntimeSocketLocation;
  readonly reason: string;
  readonly paneId: string;
  readonly #log: (message: string) => void;
  #server: Server | undefined;
  #started = false;

  constructor(options: {
    paneId: string;
    reason: string;
    runtimeDirectory?: string;
    log?: (message: string) => void;
  }) {
    this.paneId = options.paneId;
    this.reason = options.reason;
    this.location = socketLocationForPane(
      options.paneId,
      options.runtimeDirectory === undefined
        ? {}
        : { runtimeDirectory: options.runtimeDirectory },
    );
    this.#log = options.log ?? (() => undefined);
  }

  get socketPath(): string {
    return this.location.socketPath;
  }

  get started(): boolean {
    return this.#started;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await ensureRuntimeDirectory(this.location.runtimeDirectory);
    await recoverStaleSocket(this.location.socketPath);
    const server = createServer((socket) => {
      const hello: HelloFrame = {
        v: PROTOCOL_VERSION,
        type: "hello",
        seq: 1,
        payload: {
          accepted: false,
          controller: false,
          readOnly: true,
          paneId: this.paneId,
          reason: this.reason,
          capabilities: {
            mouse: false,
            perToolExpansion: false,
            bulkToolExpansion: false,
            expansionSubscription: false,
          },
        },
      };
      socket.end(encodeFrame(hello));
    });
    this.#server = server;
    server.on("error", (error) =>
      this.#log(`compatibility endpoint error: ${error.message}`),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({ path: this.location.socketPath, exclusive: true });
      });
      await chmod(this.location.socketPath, SOCKET_MODE);
      this.#started = true;
    } catch (error) {
      await closeServerQuietly(server);
      this.#server = undefined;
      await unlinkSocketIfPresent(this.location.socketPath);
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    this.#started = false;
    await unlinkSocketIfPresent(this.location.socketPath);
  }

  disposeSync(): void {
    this.#server?.close();
    this.#server = undefined;
    this.#started = false;
    unlinkSocketIfPresentSync(this.location.socketPath, (message) =>
      this.#log(`compatibility endpoint ${message}`),
    );
  }
}

export class BridgeServer {
  readonly controller: DeckController;
  readonly location: RuntimeSocketLocation;
  readonly #statePushIntervalMs: number;
  readonly #log: (message: string) => void;
  #server: Server | undefined;
  #controllerConnection: ConnectionState | undefined;
  #unsubscribeState: (() => void) | undefined;
  #stateTimer: NodeJS.Timeout | undefined;
  #started = false;
  #malformedCounter = 0;

  constructor(options: BridgeServerOptions) {
    this.controller = options.controller;
    this.location = socketLocationForPane(
      options.controller.paneId,
      options.runtimeDirectory === undefined
        ? {}
        : { runtimeDirectory: options.runtimeDirectory },
    );
    this.#statePushIntervalMs =
      options.statePushIntervalMs ?? STATE_PUSH_INTERVAL_MS;
    this.#log = options.log ?? (() => undefined);
  }

  get socketPath(): string {
    return this.location.socketPath;
  }

  get started(): boolean {
    return this.#started;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await ensureRuntimeDirectory(this.location.runtimeDirectory);
    await recoverStaleSocket(this.location.socketPath);
    const server = createServer((socket) => this.#handleConnection(socket));
    this.#server = server;
    server.on("error", (error) =>
      this.#log(`bridge server error: ${error.message}`),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({ path: this.location.socketPath, exclusive: true });
      });
      await chmod(this.location.socketPath, SOCKET_MODE);
      this.#started = true;
      this.#unsubscribeState = this.controller.subscribe(() =>
        this.#scheduleStatePush(),
      );
    } catch (error) {
      await closeServerQuietly(server);
      this.#server = undefined;
      await unlinkSocketIfPresent(this.location.socketPath);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#stateTimer) {
      clearTimeout(this.#stateTimer);
      this.#stateTimer = undefined;
    }
    this.#unsubscribeState?.();
    this.#unsubscribeState = undefined;
    this.#controllerConnection?.socket.destroy();
    this.#controllerConnection = undefined;
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.#started = false;
    await this.#unlinkOwnedSocket();
  }

  disposeSync(): void {
    this.#controllerConnection?.socket.destroy();
    this.#server?.close();
    this.#server = undefined;
    this.#started = false;
    unlinkSocketIfPresentSync(this.location.socketPath, this.#log);
  }

  #handleConnection(socket: Socket): void {
    socket.setNoDelay(true);
    if (this.#controllerConnection && !this.#controllerConnection.closed) {
      const rejected: HelloFrame = {
        v: PROTOCOL_VERSION,
        type: "hello",
        seq: 1,
        payload: {
          accepted: false,
          controller: false,
          readOnly: true,
          paneId: this.controller.paneId,
          reason: "A controller is already attached to this Pi pane.",
          capabilities: {
            mouse: true,
            perToolExpansion: true,
            bulkToolExpansion: true,
            expansionSubscription: true,
          },
        },
      };
      socket.end(encodeFrame(rejected));
      return;
    }
    const connection: ConnectionState = {
      socket,
      seq: 0,
      decoder: new NdjsonDecoder(validateCommandFrame),
      closed: false,
      commandTail: Promise.resolve(),
    };
    this.#controllerConnection = connection;
    socket.on("data", (chunk) =>
      this.#handleData(
        connection,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ),
    );
    socket.on("error", (error) =>
      this.#log(`bridge client error: ${error.message}`),
    );
    socket.on("close", () => {
      connection.closed = true;
      if (this.#controllerConnection === connection)
        this.#controllerConnection = undefined;
    });
    let snapshot;
    try {
      snapshot = this.controller.snapshot();
    } catch (error) {
      this.#log(
        `initial Pi state snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      connection.closed = true;
      socket.destroy();
      if (this.#controllerConnection === connection)
        this.#controllerConnection = undefined;
      return;
    }
    const hello: HelloFrame = {
      v: PROTOCOL_VERSION,
      type: "hello",
      seq: ++connection.seq,
      payload: {
        accepted: true,
        controller: true,
        readOnly: false,
        paneId: this.controller.paneId,
        ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
        capabilities: {
          mouse: true,
          perToolExpansion: true,
          bulkToolExpansion: true,
          expansionSubscription: true,
        },
      },
    };
    this.#write(connection, hello);
    this.#pushState(connection);
  }

  #handleData(connection: ConnectionState, chunk: Buffer): void {
    for (const decoded of connection.decoder.push(chunk)) {
      if (!decoded.ok) {
        const id = decoded.requestId ?? `malformed-${++this.#malformedCounter}`;
        this.#write(
          connection,
          errorResult(id, decoded.error.code, decoded.error.message),
        );
        continue;
      }
      connection.commandTail = connection.commandTail
        .then(async () => this.#handleCommand(connection, decoded.value))
        .catch((error) => {
          this.#log(
            `bridge command dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          connection.socket.destroy();
        });
    }
  }

  async #handleCommand(
    connection: ConnectionState,
    command: ReturnType<typeof validateCommandFrame>,
  ): Promise<void> {
    try {
      const value = await this.controller.execute(command);
      const result: ResultFrame = {
        type: "result",
        id: command.id,
        ok: true,
        value: value ?? null,
      };
      this.#write(connection, result);
      if (command.name === "refreshState") this.#pushState(connection);
    } catch (error) {
      const code =
        error instanceof CommandExecutionError
          ? error.code
          : "operation_failed";
      const message =
        error instanceof Error ? error.message : "Command failed.";
      this.#write(connection, errorResult(command.id, code, message));
    }
  }

  #scheduleStatePush(): void {
    if (
      this.#stateTimer ||
      !this.#controllerConnection ||
      this.#controllerConnection.closed
    )
      return;
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = undefined;
      const connection = this.#controllerConnection;
      if (connection && !connection.closed) this.#pushState(connection);
    }, this.#statePushIntervalMs);
    this.#stateTimer.unref?.();
  }

  #pushState(connection: ConnectionState): void {
    try {
      const frame: StateFrame = {
        v: PROTOCOL_VERSION,
        type: "state",
        seq: ++connection.seq,
        payload: this.controller.snapshot(),
      };
      this.#write(connection, frame);
    } catch (error) {
      this.#log(
        `Pi state snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      connection.socket.destroy();
    }
  }

  #write(
    connection: ConnectionState,
    frame: HelloFrame | StateFrame | ResultFrame,
  ): void {
    if (connection.closed || connection.socket.destroyed) return;
    try {
      connection.socket.write(encodeFrame(frame));
    } catch (error) {
      this.#log(
        `bridge frame write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      connection.socket.destroy();
    }
  }

  async #unlinkOwnedSocket(): Promise<void> {
    await unlinkSocketIfPresent(this.location.socketPath);
  }
}

export function enforceSocketPermissionsSync(path: string): void {
  chmodSync(path, SOCKET_MODE);
}
