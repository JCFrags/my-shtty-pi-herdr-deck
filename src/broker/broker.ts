import {
  createServer,
  createConnection,
  type Server,
  type Socket,
} from "node:net";
import { chmod, lstat, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  createPrivateExclusive,
  readPrivateRegular,
} from "../shared/private-fs.js";
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
export async function safeStaleSocket(
  path: string,
  expected?: SocketIdentity,
): Promise<void> {
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
  const quarantine = `${path}.quarantine.${process.pid}.${randomBytes(8).toString("hex")}`;
  await rename(path, quarantine);
  const quarantined = await lstat(quarantine);
  if (
    quarantined.dev !== stat.dev ||
    quarantined.ino !== stat.ino ||
    quarantined.uid !== stat.uid ||
    (expected &&
      (expected.dev !== quarantined.dev ||
        expected.ino !== quarantined.ino ||
        expected.uid !== quarantined.uid))
  )
    throw new Error("Broker socket identity changed during quarantine.");
  if (await listening(quarantine))
    throw new Error("Broker socket became live during quarantine.");
  await unlink(quarantine);
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
    this.#lock = new BrokerLock(paths.lock, paths.socket);
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
      const snapshot = await this.snapshotStore
        .read()
        .catch((error: unknown) => {
          this.store.readOnly = true;
          this.store.corruption =
            error instanceof Error
              ? error.message
              : "Snapshot verification failed.";
          return undefined;
        });
      await this.store.open(snapshot);
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
      const value = await readPrivateRegular(this.paths.secret);
      if (!/^[^\r\n]+\n$/.test(value))
        throw new Error("Invalid broker secret.");
      return value.slice(0, -1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const value = randomBytes(32).toString("base64url");
      await createPrivateExclusive(this.paths.secret, `${value}\n`);
      return value;
    }
  }
  async stop(): Promise<void> {
    let failure: unknown;
    try {
      for (const client of this.#clients) client.socket.destroy();
      await new Promise<void>(
        (resolve) => this.#server?.close(() => resolve()) ?? resolve(),
      );
      this.#server = undefined;
      await safeStaleSocket(this.paths.socket, this.#socketIdentity);
    } catch (error) {
      failure = error;
    } finally {
      try {
        await this.#lock.release();
      } catch (error) {
        if (!failure) failure = error;
      }
      this.#socketIdentity = undefined;
    }
    if (failure && (failure as NodeJS.ErrnoException).code !== "ENOENT")
      throw failure;
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
            if (
              (item.value.client.kind === "pi_child" &&
                item.value.auth.kind !== "agent_token") ||
              (item.value.client.kind !== "pi_child" &&
                item.value.auth.kind !== "client_secret")
            )
              throw new OrchestratorError(
                "AUTH_FAILED",
                "Authentication kind does not match client kind.",
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
      let replayEvents: import("../state/types.js").StoredEvent[] = [];
      let committedEvent: import("../state/types.js").StoredEvent | undefined;
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
        const from = Number(request.params.fromSeq ?? 0);
        const includeSnapshot =
          request.params.includeSnapshot === undefined
            ? true
            : request.params.includeSnapshot;
        if (
          !Number.isSafeInteger(from) ||
          from < 0 ||
          from > this.store.state.lastEventSeq ||
          typeof includeSnapshot !== "boolean"
        )
          throw new OrchestratorError(
            "EVENT_CURSOR_EXPIRED",
            "Event cursor is invalid or expired.",
          );
        const filters = request.params.filters;
        if (
          filters !== undefined &&
          (!filters || typeof filters !== "object" || Array.isArray(filters))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Subscription filters are invalid.",
          );
        const filterRecord = (filters ?? {}) as Record<string, unknown>;
        if (
          filterRecord.events !== undefined &&
          (!Array.isArray(filterRecord.events) ||
            filterRecord.events.some((item) => typeof item !== "string"))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Event filters are invalid.",
          );
        if (
          filterRecord.taskIds !== undefined &&
          (!Array.isArray(filterRecord.taskIds) ||
            filterRecord.taskIds.some((item) => typeof item !== "string"))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Task filters are invalid.",
          );
        const matches = (
          event: import("../state/types.js").StoredEvent,
        ): boolean => {
          const names = filterRecord.events as string[] | undefined;
          const tasks = filterRecord.taskIds as string[] | undefined;
          return (
            (!names ||
              names.length === 0 ||
              names.some((name) =>
                name.endsWith(".*")
                  ? event.type.startsWith(name.slice(0, -1))
                  : event.type === name,
              )) &&
            (!tasks ||
              tasks.length === 0 ||
              (event.entityRefs.taskId !== undefined &&
                tasks.includes(event.entityRefs.taskId)))
          );
        };
        const currentSeq = this.store.state.lastEventSeq;
        if (!includeSnapshot)
          replayEvents = (await this.store.readEventsFrom(from)).filter(
            matches,
          );
        client.subscribed = true;
        result = {
          subscriptionId: createId("evt"),
          ...(includeSnapshot
            ? {
                snapshot: {
                  seq: currentSeq,
                  tasks: Object.values(this.store.state.tasks),
                  runs: Object.values(this.store.state.runs),
                },
              }
            : {}),
          replayFromSeq: includeSnapshot ? currentSeq + 1 : from + 1,
        };
        if (includeSnapshot)
          replayEvents = (await this.store.readEventsFrom(currentSeq)).filter(
            matches,
          );
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
        if (!["human", "cli", "deck"].includes(principal.kind))
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Only an operator client may create M1 synthetic tasks.",
          );
        if (request.params.parentAgentId !== undefined)
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Parent agent binding is deferred until M3.",
          );
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
          committedEvent = await this.store.append({
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
      if (committedEvent)
        await this.snapshotStore.write(this.store.state).catch(() => undefined);
      const response = {
        v: 1,
        type: "response",
        id: request.id,
        method: request.method,
        ok: true,
        result,
      };
      client.socket.write(encodeFrame(response));
      for (const event of replayEvents) this.#sendEvent(client, event);
      if (committedEvent)
        for (const subscriber of this.#clients)
          if (subscriber.subscribed)
            this.#sendEvent(subscriber, committedEvent);
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
  #sendEvent(
    client: Client,
    stored: import("../state/types.js").StoredEvent,
  ): void {
    const event = {
      v: 1,
      type: "event",
      seq: stored.seq,
      id: stored.id,
      event: stored.type,
      timestamp: stored.timestamp,
      refs: stored.entityRefs,
      data: stored.payload,
    };
    const encoded = encodeFrame(event);
    if (client.socket.writableLength + encoded.byteLength > 4 * 1024 * 1024) {
      client.socket.destroy();
      return;
    }
    client.socket.write(encoded);
  }
}
