import {
  createServer,
  createConnection,
  type Server,
  type Socket,
} from "node:net";
import { chmod, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { EventStore } from "../state/event-store.js";
import { createId } from "../shared/ids.js";
import { canonicalJson, sha256 } from "../shared/canonical-json.js";
import { NdjsonDecoder, encodeFrame } from "../shared/protocol/codec.js";
import {
  validateHello,
  validateRequest,
  type HelloRequest,
  type RequestFrame,
} from "../shared/protocol/frames.js";
import {
  authenticate,
  requirePermission,
  type Principal,
} from "./authentication.js";
import { BrokerLock } from "./lock.js";
import {
  ensurePrivateDirectory,
  sessionKey,
  type ResolvedPaths,
} from "../shared/paths.js";
import { OrchestratorError } from "../shared/errors.js";
import { assertInvariants } from "../state/invariants.js";
import { SnapshotStore } from "../state/snapshot-store.js";
interface Client {
  socket: Socket;
  principal?: Principal;
  subscribed: boolean;
}
interface SocketIdentity {
  dev: number;
  ino: number;
  uid: number;
}
async function listening(path: string): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 200);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error.code ?? ""))
        resolve(false);
      else reject(error);
    });
  });
}
export async function safeStaleSocket(path: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isSocket())
    throw new Error("Refusing to remove non-socket broker path.");
  if (process.getuid?.() !== undefined && stat.uid !== process.getuid())
    throw new Error("Broker socket has the wrong owner.");
  if (await listening(path)) throw new Error("Broker socket is already live.");
  await unlink(path);
}
export function sessionKeyMatches(
  expectedSocket: string,
  received: string,
): boolean {
  return sessionKey(expectedSocket) === received;
}
export class Broker {
  readonly store: EventStore;
  readonly snapshotStore: SnapshotStore;
  readonly paths: ResolvedPaths;
  #server: Server | undefined;
  #socketIdentity: SocketIdentity | undefined;
  #mutationTail: Promise<void> = Promise.resolve();
  #lock: BrokerLock;
  #secret: string;
  #clients = new Set<Client>();
  constructor(paths: ResolvedPaths) {
    this.paths = paths;
    this.#lock = new BrokerLock(paths.lock);
    this.#secret = "";
    this.store = new EventStore(paths.events);
    this.snapshotStore = new SnapshotStore(paths.snapshot);
  }
  async start(): Promise<void> {
    await ensurePrivateDirectory(this.paths.root);
    await ensurePrivateDirectory(this.paths.runtime);
    await this.#lock.acquire();
    try {
      await safeStaleSocket(this.paths.socket);
      this.#secret = await this.#loadSecret();
      await this.store.open();
      try {
        const snapshot = await this.snapshotStore.read();
        if (
          snapshot &&
          (snapshot.lastEventSeq > this.store.state.lastEventSeq ||
            (snapshot.lastEventSeq === this.store.state.lastEventSeq &&
              snapshot.lastEventHash !== this.store.state.lastEventHash))
        )
          throw new Error("Snapshot is ahead of the verified event log.");
      } catch (error) {
        this.store.readOnly = true;
        this.store.corruption =
          error instanceof Error
            ? error.message
            : "Snapshot verification failed.";
      }
      this.#server = createServer((socket) => this.#connect(socket));
      await new Promise<void>((resolve, reject) =>
        this.#server
          ?.once("listening", resolve)
          .once("error", reject)
          .listen(this.paths.socket),
      );
      await chmod(this.paths.socket, 0o600);
      const stat = await lstat(this.paths.socket);
      this.#socketIdentity = { dev: stat.dev, ino: stat.ino, uid: stat.uid };
    } catch (error) {
      await this.#lock.release();
      throw error;
    }
  }
  async #loadSecret(): Promise<string> {
    try {
      const value = await readFile(this.paths.secret, "utf8");
      if (!value.trim() || value.includes("\n"))
        throw new Error("Invalid broker secret.");
      await chmod(this.paths.secret, 0o600);
      return value.trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const value = randomBytes(32).toString("base64url");
      await writeFile(this.paths.secret, `${value}\n`, { mode: 0o600 });
      await chmod(this.paths.secret, 0o600);
      return value;
    }
  }
  async stop(): Promise<void> {
    for (const client of this.#clients) client.socket.destroy();
    await new Promise<void>(
      (resolve) => this.#server?.close(() => resolve()) ?? resolve(),
    );
    this.#server = undefined;
    const current = await lstat(this.paths.socket).catch(() => undefined);
    if (
      current &&
      this.#socketIdentity &&
      (current.dev !== this.#socketIdentity.dev ||
        current.ino !== this.#socketIdentity.ino ||
        current.uid !== this.#socketIdentity.uid)
    )
      throw new Error("Broker socket identity changed.");
    try {
      await safeStaleSocket(this.paths.socket);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.#lock.release();
  }
  get secret(): string {
    return this.#secret;
  }
  #connect(socket: Socket): void {
    if (this.#clients.size >= 64) {
      socket.destroy();
      return;
    }
    const client: Client = { socket, subscribed: false };
    this.#clients.add(client);
    const decoder = new NdjsonDecoder<HelloRequest | RequestFrame>((value) => {
      if (
        typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>).type === "hello"
      )
        return validateHello(value);
      return validateRequest(value);
    });
    socket.on("data", async (data) => {
      for (const item of decoder.push(data)) {
        if (!item.ok) {
          socket.write(
            encodeFrame({
              v: 1,
              type: "response",
              id: createId("evt"),
              method: "unknown",
              ok: false,
              error: {
                code: item.error.code,
                message: item.error.message,
                retryable: false,
              },
            }),
          );
          continue;
        }
        if (!client.principal) {
          if (item.value.type !== "hello") {
            socket.destroy();
            return;
          }
          try {
            if (!sessionKeyMatches(this.paths.socket, item.value.sessionKey))
              throw new OrchestratorError(
                "AUTH_FAILED",
                "Session key does not match the broker socket.",
              );
            client.principal = authenticate(
              this.#secret,
              item.value.auth.secret ?? "",
              item.value.client.kind,
              undefined,
              item.value.auth.token,
              item.value.auth.generation,
              item.value.auth.piSessionId,
            );
            socket.write(
              encodeFrame({
                v: 1,
                type: "hello_result",
                id: item.value.id,
                ok: true,
                broker: {
                  version: "0.1.0",
                  status: this.store.readOnly
                    ? "read_only_recovery"
                    : "healthy",
                  lastEventSeq: this.store.state.lastEventSeq,
                },
                principal: client.principal,
                limits: { maxLineBytes: 1_048_576 },
              }),
            );
          } catch (error) {
            socket.write(
              encodeFrame({
                v: 1,
                type: "hello_result",
                id: item.value.id,
                ok: false,
                error: {
                  code: "AUTH_FAILED",
                  message: "Authentication failed.",
                  retryable: false,
                },
              }),
            );
            socket.destroy();
          }
          continue;
        }
        if (item.value.type === "request")
          await this.#request(client, item.value);
      }
    });
    socket.once("close", () => this.#clients.delete(client));
  }
  async #request(client: Client, request: RequestFrame): Promise<void> {
    const previous = this.#mutationTail;
    let release!: () => void;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.#requestUnlocked(client, request);
    } finally {
      release();
    }
  }
  async #requestUnlocked(client: Client, request: RequestFrame): Promise<void> {
    const principal = client.principal!;
    try {
      let result: unknown;
      if (
        request.method === "system.ping" ||
        request.method === "system.status"
      )
        result = {
          status: this.store.readOnly ? "read_only_recovery" : "healthy",
          lastEventSeq: this.store.state.lastEventSeq,
          corruption: this.store.corruption,
        };
      else if (request.method === "events.verify") {
        requirePermission(principal, "read:audit");
        result = this.store.verify();
      } else if (request.method === "events.subscribe") {
        requirePermission(principal, "read:state");
        client.subscribed = true;
        const from = Number(request.params.fromSeq ?? 0);
        if (
          !Number.isSafeInteger(from) ||
          from < 0 ||
          from > this.store.state.lastEventSeq ||
          (this.store.events[0] !== undefined &&
            from < this.store.events[0].seq - 1)
        )
          throw new OrchestratorError(
            "EVENT_CURSOR_EXPIRED",
            "Event cursor is invalid or expired.",
          );
        result = {
          subscriptionId: createId("evt"),
          snapshot: {
            seq: this.store.state.lastEventSeq,
            tasks: Object.values(this.store.state.tasks),
            runs: Object.values(this.store.state.runs),
          },
          replay: this.store.events.filter((event) => event.seq > from),
          replayFromSeq: from + 1,
        };
      } else if (request.method === "events.unsubscribe") {
        requirePermission(principal, "read:state");
        client.subscribed = false;
        result = { unsubscribed: true };
      } else if (request.method === "task.list") {
        requirePermission(principal, "read:state");
        result = {
          items: Object.values(this.store.state.tasks),
          nextCursor: null,
          snapshotSeq: this.store.state.lastEventSeq,
        };
      } else if (request.method === "task.get") {
        requirePermission(principal, "read:state");
        result = this.store.state.tasks[String(request.params.taskId)] ?? null;
      } else if (request.method === "task.create") {
        requirePermission(principal, "delegate");
        if (this.store.readOnly)
          throw new OrchestratorError(
            "BROKER_READ_ONLY",
            "Broker is read-only.",
          );
        const title = request.params.title;
        const objective = request.params.objective;
        if (
          typeof title !== "string" ||
          typeof objective !== "string" ||
          title.length === 0 ||
          title.length > 1024 ||
          objective.length === 0 ||
          objective.length > 262144
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Task title and objective are invalid.",
          );
        const paramsHash = sha256(canonicalJson(request.params));
        const prior = request.idempotencyKey
          ? this.store.state.idempotency[request.idempotencyKey]
          : undefined;
        if (prior) {
          if (
            prior.principalId !== principal.id ||
            prior.method !== request.method ||
            prior.paramsHash !== paramsHash
          )
            throw new OrchestratorError(
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key is already bound.",
            );
          result = prior.response;
        } else {
          const id = createId("tsk");
          result = { taskId: id, state: "queued" };
          await this.store.append({
            type: "task.created",
            actor: { principalId: principal.id, kind: principal.kind },
            entityRefs: { taskId: id },
            payload: {
              id,
              title,
              objective,
              createdAt: new Date().toISOString(),
              ...(typeof request.params.parentAgentId === "string"
                ? { parentAgentId: request.params.parentAgentId }
                : {}),
              ...(request.idempotencyKey
                ? {
                    idempotencyKey: request.idempotencyKey,
                    paramsHash,
                    response: result,
                  }
                : {}),
            },
          });
        }
      } else throw new OrchestratorError("NOT_FOUND", "Method was not found.");
      assertInvariants(this.store.state);
      await this.snapshotStore.write(this.store.state);
      const response = {
        v: 1,
        type: "response",
        id: request.id,
        method: request.method,
        ok: true,
        result,
      };
      client.socket.write(encodeFrame(response));
      this.#publish(request.method, response);
    } catch (error) {
      const typed =
        error instanceof OrchestratorError
          ? error
          : new OrchestratorError(
              "INVALID_REQUEST",
              error instanceof Error ? error.message : "Request failed.",
            );
      client.socket.write(
        encodeFrame({
          v: 1,
          type: "response",
          id: request.id,
          method: request.method,
          ok: false,
          error: {
            code: typed.code,
            message: typed.message,
            retryable: typed.retryable,
          },
        }),
      );
    }
  }
  #publish(method: string, response: unknown): void {
    const event = {
      v: 1,
      type: "event",
      seq: this.store.state.lastEventSeq,
      id: createId("evt"),
      event: method,
      timestamp: new Date().toISOString(),
      refs: {},
      data: response,
    };
    const encoded = encodeFrame(event);
    for (const client of this.#clients) {
      if (!client.subscribed || client.socket.destroyed) continue;
      if (client.socket.writableLength + encoded.byteLength > 4 * 1024 * 1024) {
        client.socket.destroy();
        continue;
      }
      client.socket.write(encoded);
    }
  }
}
