import {
  createServer,
  createConnection,
  type Server,
  type Socket,
} from "node:net";
import { chmod, lstat, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
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
import type { HerdrService } from "../herdr/service.js";
interface SubscriptionFilter {
  events?: string[];
  agentIds?: string[];
  taskIds?: string[];
}
interface Client {
  socket: Socket;
  principal?: Principal;
  subscribed: boolean;
  subscriptionId?: string;
  eventFilter?: SubscriptionFilter;
  slowClosed?: boolean;
  processing: Promise<void>;
  requestWindowStarted: number;
  requestCount: number;
}
function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function safeText(value: unknown, max = 4096): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function subscriptionId(): string {
  return `sub_${createId("evt").slice(4)}`;
}
interface SocketIdentity {
  dev: number;
  ino: number;
  uid: number;
}
function socketQuarantine(path: string, label: string): string {
  return join(
    dirname(path),
    `.q-${label}-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
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
  let observed;
  try {
    observed = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!observed.isSocket())
    throw new Error("Refusing to remove non-socket broker path.");
  if (
    observed.nlink !== 1 ||
    (process.getuid?.() !== undefined && observed.uid !== process.getuid()) ||
    (observed.mode & 0o077) !== 0
  )
    throw new Error("Broker socket ownership or mode is unsafe.");
  if (await listening(path)) throw new Error("Broker socket is already live.");

  const quarantine = socketQuarantine(path, "stale");
  await rename(path, quarantine);
  const restore = async (): Promise<void> => {
    try {
      await lstat(path);
      throw new Error(
        `Broker socket was preserved at ${quarantine}; its path was replaced.`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(quarantine, path);
  };

  const quarantined = await lstat(quarantine);
  const sameObserved =
    quarantined.isSocket() &&
    quarantined.nlink === 1 &&
    (quarantined.mode & 0o077) === 0 &&
    quarantined.dev === observed.dev &&
    quarantined.ino === observed.ino &&
    quarantined.uid === observed.uid;
  const sameExpected =
    !expected ||
    (expected.dev === quarantined.dev &&
      expected.ino === quarantined.ino &&
      expected.uid === quarantined.uid);
  if (!sameObserved || !sameExpected) {
    await restore();
    throw new Error("Broker socket identity changed during quarantine.");
  }
  if (await listening(quarantine)) {
    await restore();
    throw new Error("Broker socket became live during quarantine.");
  }
  await unlink(quarantine);
}
interface CloseQuarantine {
  path: string;
  owned: boolean;
}
async function quarantineForClose(
  path: string,
  expected: SocketIdentity,
): Promise<CloseQuarantine | undefined> {
  const quarantine = socketQuarantine(path, "close");
  try {
    await rename(path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const stat = await lstat(quarantine);
  return {
    path: quarantine,
    owned:
      stat.isSocket() &&
      stat.dev === expected.dev &&
      stat.ino === expected.ino &&
      stat.uid === expected.uid,
  };
}
async function restoreReplacement(
  original: string,
  quarantine: string,
): Promise<void> {
  try {
    await lstat(original);
    throw new Error(
      `Replacement socket was preserved at ${quarantine}; the original path is occupied.`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(quarantine, original);
}
export function sessionKeyMatches(
  expectedSocket: string,
  received: string,
): boolean {
  return sessionKey(expectedSocket) === received;
}
export interface BrokerOptions {
  herdr?: HerdrService;
  herdrFactory?: (
    store: EventStore,
    paths: ResolvedPaths,
  ) => Promise<HerdrService>;
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
  #herdr?: HerdrService;
  readonly #herdrFactory:
    | ((store: EventStore, paths: ResolvedPaths) => Promise<HerdrService>)
    | undefined;
  constructor(paths: ResolvedPaths, options: BrokerOptions = {}) {
    this.paths = paths;
    this.#lock = new BrokerLock(paths.lock, paths.socket);
    this.#secret = "";
    this.store = new EventStore(paths.events);
    this.snapshotStore = new SnapshotStore(paths.snapshot);
    if (options.herdr) {
      if (options.herdr.store !== this.store)
        throw new Error("Herdr service must use the broker-owned event store.");
      this.#herdr = options.herdr;
    }
    this.#herdrFactory = options.herdrFactory;
  }
  async readSnapshot(): Promise<
    import("../state/snapshot-store.js").Snapshot | undefined
  > {
    const key = this.#secret || (await this.#loadSecret());
    return this.snapshotStore.read(key);
  }
  async start(): Promise<void> {
    await ensurePrivateDirectory(this.paths.root);
    await ensurePrivateDirectory(this.paths.runtime);
    await this.#lock.acquire();
    try {
      await safeStaleSocket(this.paths.socket);
      this.#secret = await this.#loadSecret();
      const snapshot = await this.snapshotStore
        .read(this.#secret)
        .catch((error: unknown) => {
          this.store.readOnly = true;
          this.store.corruption =
            error instanceof Error
              ? error.message
              : "Snapshot verification failed.";
          return undefined;
        });
      await this.store.open(snapshot);
      if (this.#herdrFactory)
        this.#herdr = await this.#herdrFactory(this.store, this.paths);
      if (this.#herdr) await this.#herdr.startupReconcile();
      this.#server = createServer((socket) => this.#connect(socket));
      await new Promise<void>((resolve, reject) =>
        this.#server
          ?.once("listening", resolve)
          .once("error", reject)
          .listen(this.paths.socket),
      );
      const created = await lstat(this.paths.socket);
      this.#socketIdentity = {
        dev: created.dev,
        ino: created.ino,
        uid: created.uid,
      };
      await chmod(this.paths.socket, 0o600);
      const secured = await lstat(this.paths.socket);
      if (
        !secured.isSocket() ||
        secured.dev !== created.dev ||
        secured.ino !== created.ino ||
        secured.uid !== created.uid ||
        (secured.mode & 0o077) !== 0
      )
        throw new Error("Broker socket changed while securing its mode.");
    } catch (error) {
      if (this.#server) await this.stop().catch(() => undefined);
      else await this.#lock.release();
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
    let quarantined: CloseQuarantine | undefined;
    const identity = this.#socketIdentity;
    try {
      for (const client of this.#clients) client.socket.destroy();
      while (true) {
        const pending = this.#mutationTail;
        await pending;
        if (pending === this.#mutationTail) break;
      }
      if (this.#server && identity)
        quarantined = await quarantineForClose(this.paths.socket, identity);
      await new Promise<void>(
        (resolve) => this.#server?.close(() => resolve()) ?? resolve(),
      );
      this.#server = undefined;
      if (quarantined?.owned) await safeStaleSocket(quarantined.path, identity);
      else if (quarantined) {
        const replacement = quarantined.path;
        await restoreReplacement(this.paths.socket, replacement);
        quarantined = undefined;
        throw new Error("Broker socket identity changed before shutdown.");
      }
    } catch (error) {
      failure = error;
      if (quarantined && !quarantined.owned)
        await restoreReplacement(this.paths.socket, quarantined.path).catch(
          (restoreError) => {
            failure = restoreError;
          },
        );
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
    if (this.#clients.size >= 16) {
      socket.destroy();
      return;
    }
    const client: Client = {
      socket,
      subscribed: false,
      processing: Promise.resolve(),
      requestWindowStarted: Date.now(),
      requestCount: 0,
    };
    this.#clients.add(client);
    const authenticationTimer = setTimeout(() => socket.destroy(), 2_000);
    authenticationTimer.unref();
    const decoder = new NdjsonDecoder<HelloRequest | RequestFrame>((value) => {
      if (
        typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>).type === "hello"
      )
        return validateHello(value);
      return validateRequest(value);
    });
    socket.on("data", (data) => {
      client.processing = client.processing
        .then(async () => {
          for (const item of decoder.push(data)) {
            if (!item.ok) {
              this.#writeFrame(client, {
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
              });
              continue;
            }
            if (!client.principal) {
              if (item.value.type !== "hello") {
                socket.destroy();
                return;
              }
              try {
                if (
                  !sessionKeyMatches(this.paths.socket, item.value.sessionKey)
                )
                  throw new OrchestratorError(
                    "AUTH_FAILED",
                    "Session key does not match the broker socket.",
                  );
                if (item.value.client.kind === "pi_child") {
                  if (
                    item.value.auth.kind !== "agent_token" ||
                    !item.value.auth.agentId ||
                    !item.value.auth.generation ||
                    !item.value.auth.piSessionId
                  )
                    throw new OrchestratorError(
                      "AUTH_FAILED",
                      "Managed agent authentication is invalid.",
                    );
                  const resource =
                    this.store.state.herdrResources?.[item.value.auth.agentId];
                  const credential =
                    resource?.tokenDigest && resource.sessionId
                      ? {
                          agentId: item.value.auth.agentId,
                          generation: resource.generation ?? 0,
                          tokenHash: resource.tokenDigest,
                          piSessionId: resource.sessionId,
                          ...(resource.parentAgentId
                            ? { parentAgentId: resource.parentAgentId }
                            : {}),
                        }
                      : undefined;
                  client.principal = authenticate(
                    this.#secret,
                    "",
                    item.value.client.kind,
                    credential,
                    item.value.auth.token,
                    item.value.auth.generation,
                    item.value.auth.piSessionId,
                  );
                } else {
                  if (item.value.auth.kind !== "client_secret")
                    throw new OrchestratorError(
                      "AUTH_FAILED",
                      "Authentication kind does not match client kind.",
                    );
                  client.principal = authenticate(
                    this.#secret,
                    item.value.auth.secret ?? "",
                    item.value.client.kind,
                  );
                }
                clearTimeout(authenticationTimer);
                this.#writeFrame(client, {
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
                });
              } catch (error) {
                await this.#recordAudit(
                  `authentication_failed_${item.value.client.kind}`,
                ).catch(() => undefined);
                this.#writeFrame(client, {
                  v: 1,
                  type: "hello_result",
                  id: item.value.id,
                  ok: false,
                  error: {
                    code: "AUTH_FAILED",
                    message: "Authentication failed.",
                    retryable: false,
                  },
                });
                socket.destroy();
              }
              continue;
            }
            if (item.value.type !== "request") {
              socket.destroy();
              return;
            }
            await this.#request(client, item.value);
          }
        })
        .catch(() => {
          socket.destroy();
        });
    });
    socket.once("close", () => {
      clearTimeout(authenticationTimer);
      this.#clients.delete(client);
    });
  }
  async #request(client: Client, request: RequestFrame): Promise<void> {
    const now = Date.now();
    if (now - client.requestWindowStarted >= 1_000) {
      client.requestWindowStarted = now;
      client.requestCount = 0;
    }
    client.requestCount++;
    if (client.requestCount > 200) {
      this.#writeFrame(client, {
        v: 1,
        type: "response",
        id: request.id,
        method: request.method,
        ok: false,
        error: {
          code: "LIMIT_EXCEEDED",
          message: "Client request rate exceeded the local limit.",
          retryable: true,
        },
      });
      this.#queueAudit("client_rate_limited");
      client.socket.destroy();
      return;
    }
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
      ) {
        if (
          !exactKeys(request.params, []) ||
          Object.keys(request.params).length
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "System method parameters must be empty.",
          );
        result = {
          status: this.store.readOnly ? "read_only_recovery" : "healthy",
          lastEventSeq: this.store.state.lastEventSeq,
          corruption: this.store.corruption,
        };
      } else if (request.method === "herdr.status") {
        requirePermission(principal, "read:state");
        if (Object.keys(request.params).length || !this.#herdr)
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Herdr status parameters are invalid.",
          );
        result = { resources: this.#herdr.resources };
      } else if (request.method === "herdr.reconcile") {
        requirePermission(principal, "repair");
        if (Object.keys(request.params).length || !this.#herdr)
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Herdr reconcile parameters are invalid.",
          );
        result = await this.#herdr.startupReconcile();
      } else if (request.method === "herdr.provision") {
        requirePermission(principal, "delegate");
        if (
          !this.#herdr ||
          !exactKeys(request.params, [
            "agentId",
            "parentAgentId",
            "role",
            "workspaceId",
            "cwd",
            "profileId",
            "isolation",
            "prompt",
            "projectBase",
            "branch",
            "env",
          ])
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Herdr provisioning parameters are invalid.",
          );
        const p = request.params;
        const required = [
          "agentId",
          "parentAgentId",
          "role",
          "workspaceId",
          "cwd",
          "profileId",
          "isolation",
          "prompt",
        ];
        if (
          !required.every((key) => safeText(p[key])) ||
          (p.isolation !== "shared-readonly" && p.isolation !== "worktree") ||
          (p.env !== undefined &&
            (!p.env ||
              typeof p.env !== "object" ||
              Array.isArray(p.env) ||
              !Object.entries(p.env).every(
                ([key, value]) => safeText(key, 128) && safeText(value, 4096),
              ))) ||
          (p.projectBase !== undefined && !safeText(p.projectBase)) ||
          (p.branch !== undefined && !safeText(p.branch))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Herdr provisioning parameters are invalid.",
          );
        const provisioned = await this.#herdr.provision(p as never);
        result = {
          name: provisioned.name,
          generation: provisioned.token.generation,
          tokenDigest: provisioned.token.digest,
          ...(provisioned.tabId ? { tabId: provisioned.tabId } : {}),
          ...(provisioned.paneId ? { paneId: provisioned.paneId } : {}),
          ...(provisioned.worktreeId
            ? { worktreeId: provisioned.worktreeId }
            : {}),
          ...(provisioned.worktreePath
            ? { worktreePath: provisioned.worktreePath }
            : {}),
        };
      } else if (request.method === "herdr.register") {
        requirePermission(principal, "delegate");
        if (
          !this.#herdr ||
          !exactKeys(request.params, [
            "agentId",
            "paneId",
            "terminalId",
            "sessionId",
            "generation",
            "tokenProof",
          ]) ||
          !safeText(request.params.agentId) ||
          !safeText(request.params.paneId) ||
          (request.params.tokenProof !== undefined &&
            !safeText(request.params.tokenProof, 128))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Registration parameters are invalid.",
          );
        const registrationIdentity = {
          paneId: request.params.paneId,
          ...(safeText(request.params.terminalId)
            ? { terminalId: request.params.terminalId }
            : {}),
          ...(safeText(request.params.sessionId)
            ? { sessionId: request.params.sessionId }
            : {}),
          ...(Number.isSafeInteger(request.params.generation)
            ? { generation: request.params.generation as number }
            : {}),
        };
        await this.#herdr.register(
          request.params.agentId,
          registrationIdentity,
          undefined,
          safeText(request.params.tokenProof, 128)
            ? request.params.tokenProof
            : undefined,
        );
        result = { registered: true };
      } else if (request.method === "herdr.adopt") {
        requirePermission(principal, "delegate");
        if (
          !this.#herdr ||
          !exactKeys(request.params, [
            "agentId",
            "paneId",
            "terminalId",
            "sessionId",
            "generation",
          ]) ||
          !safeText(request.params.agentId) ||
          !safeText(request.params.paneId)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Adoption parameters are invalid.",
          );
        const agent = this.store.state.agents[request.params.agentId];
        if (!agent)
          throw new OrchestratorError("NOT_FOUND", "Agent was not found.");
        await this.#herdr.adoptRoot(agent, request.params as never);
        result = { adopted: true };
      } else if (
        request.method === "herdr.focus" ||
        request.method === "herdr.interrupt" ||
        request.method === "herdr.stop" ||
        request.method === "herdr.close"
      ) {
        requirePermission(principal, "manage:all");
        if (
          !this.#herdr ||
          !exactKeys(request.params, [
            "paneId",
            "terminalId",
            "sessionId",
            "generation",
          ]) ||
          !safeText(request.params.paneId, 256) ||
          (request.params.terminalId !== undefined &&
            !safeText(request.params.terminalId, 256)) ||
          (request.params.sessionId !== undefined &&
            !safeText(request.params.sessionId, 256)) ||
          (request.params.generation !== undefined &&
            !Number.isSafeInteger(request.params.generation))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Herdr occupant guard is invalid.",
          );
        const guard = request.params as never;
        if (request.method === "herdr.focus") await this.#herdr.focus(guard);
        else if (request.method === "herdr.interrupt")
          await this.#herdr.interrupt(guard);
        else if (request.method === "herdr.stop") await this.#herdr.stop(guard);
        else await this.#herdr.close(guard);
        result = { ok: true };
      } else if (request.method === "events.verify") {
        requirePermission(principal, "read:audit");
        if (Object.keys(request.params).length)
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Verification parameters must be empty.",
          );
        result = await this.store.verifyDisk();
      } else if (request.method === "events.subscribe") {
        requirePermission(principal, "read:state");
        if (
          !exactKeys(request.params, ["fromSeq", "filters", "includeSnapshot"])
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Subscription parameters contain unknown fields.",
          );
        const from = request.params.fromSeq ?? 0;
        const includeSnapshot = request.params.includeSnapshot ?? true;
        if (
          !Number.isSafeInteger(from) ||
          Number(from) < 0 ||
          Number(from) > this.store.state.lastEventSeq
        )
          throw new OrchestratorError(
            "CURSOR_INVALID",
            "Event cursor is outside the active event generation.",
          );
        if (typeof includeSnapshot !== "boolean")
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "includeSnapshot must be a boolean.",
          );
        const rawFilters = request.params.filters;
        if (
          rawFilters !== undefined &&
          (!rawFilters ||
            typeof rawFilters !== "object" ||
            Array.isArray(rawFilters))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Subscription filters are invalid.",
          );
        const filterRecord = (rawFilters ?? {}) as Record<string, unknown>;
        if (!exactKeys(filterRecord, ["events", "agentIds", "taskIds"]))
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Subscription filters contain unknown fields.",
          );
        const validStrings = (value: unknown): boolean =>
          value === undefined ||
          (Array.isArray(value) &&
            value.length <= 1_000 &&
            value.every(
              (item) =>
                typeof item === "string" &&
                item.length > 0 &&
                item.length <= 128,
            ));
        if (
          !validStrings(filterRecord.events) ||
          !validStrings(filterRecord.agentIds) ||
          !validStrings(filterRecord.taskIds)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Subscription filters are invalid.",
          );
        const filter: SubscriptionFilter = {
          ...(filterRecord.events
            ? { events: filterRecord.events as string[] }
            : {}),
          ...(filterRecord.agentIds
            ? { agentIds: filterRecord.agentIds as string[] }
            : {}),
          ...(filterRecord.taskIds
            ? { taskIds: filterRecord.taskIds as string[] }
            : {}),
        };
        const currentSeq = this.store.state.lastEventSeq;
        const replayStart = includeSnapshot ? currentSeq : Number(from);
        replayEvents = (await this.store.readEventsFrom(replayStart)).filter(
          (event) => this.#matchesFilter(filter, event),
        );
        client.subscribed = true;
        client.subscriptionId = subscriptionId();
        client.eventFilter = filter;
        result = {
          subscriptionId: client.subscriptionId,
          ...(includeSnapshot
            ? {
                snapshot: {
                  seq: currentSeq,
                  agents: Object.values(this.store.state.agents),
                  tasks: Object.values(this.store.state.tasks),
                  workflows: Object.values(this.store.state.workflows),
                  questions: [],
                  results: [],
                },
              }
            : {}),
          replayFromSeq: replayStart + 1,
        };
      } else if (request.method === "events.unsubscribe") {
        requirePermission(principal, "read:state");
        if (
          !exactKeys(request.params, ["subscriptionId"]) ||
          typeof request.params.subscriptionId !== "string" ||
          request.params.subscriptionId !== client.subscriptionId
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Subscription ID is invalid.",
          );
        client.subscribed = false;
        delete client.subscriptionId;
        delete client.eventFilter;
        result = { unsubscribed: true };
      } else if (
        request.method === "agent.register_adopted" ||
        request.method === "agent.register_managed"
      ) {
        if (request.method === "agent.register_managed")
          requirePermission(principal, "manage:self");
        else if (principal.kind !== "pi_parent")
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Only a Pi adapter may register.",
          );
        const p = request.params;
        if (
          !safeText(p.adapterVersion, 64) ||
          !p.herdr ||
          typeof p.herdr !== "object" ||
          !p.pi ||
          typeof p.pi !== "object"
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Pi registration payload is invalid.",
          );
        const herdr = p.herdr as Record<string, unknown>,
          pi = p.pi as Record<string, unknown>;
        const agentId =
          request.method === "agent.register_managed"
            ? (principal.agentId ?? p.agentId)
            : createId("agt");
        if (
          !safeText(agentId) ||
          !safeText(herdr.paneId) ||
          !safeText(pi.sessionId)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Pi identity is invalid.",
          );
        const existing = this.store.state.agents[agentId];
        if (existing && existing.piSessionId !== pi.sessionId)
          throw new OrchestratorError(
            "AGENT_REPLACED",
            "Pi session does not match the current agent generation.",
          );
        if (!existing) {
          const event = await this.store.append({
            type: "agent.registered",
            actor: { principalId: principal.id, kind: principal.kind },
            entityRefs: { agentId },
            payload: {
              agentId,
              managed: request.method === "agent.register_managed",
              generation: Number(p.generation ?? 1),
              paneId: herdr.paneId,
              ...(safeText(herdr.terminalId)
                ? { terminalId: herdr.terminalId }
                : {}),
              piSessionId: pi.sessionId,
              ...(safeText(p.profileId) ? { profileId: p.profileId } : {}),
              ...(safeText(p.parentAgentId)
                ? { parentAgentId: p.parentAgentId }
                : {}),
            },
          });
          committedEvent = event;
        }
        result = {
          agentId,
          generation: this.store.state.agents[agentId]?.generation ?? 1,
          connectionGeneration:
            (this.store.state.agents[agentId]?.connectionGeneration ?? 0) + 1,
          heartbeatMs: 5_000,
          permissions: principal.permissions,
        };
      } else if (request.method === "agent.heartbeat") {
        requirePermission(principal, "manage:self");
        const agentId = principal.agentId;
        if (!agentId || !this.store.state.agents[agentId])
          throw new OrchestratorError(
            "AGENT_NOT_FOUND",
            "Agent was not found.",
          );
        const p = request.params,
          state =
            p.state && typeof p.state === "object"
              ? (p.state as Record<string, unknown>)
              : {};
        committedEvent = await this.store.append({
          type: "agent.heartbeat",
          actor: { principalId: principal.id, kind: principal.kind },
          entityRefs: { agentId },
          payload: {
            agentId,
            ...(safeText(state.sessionId)
              ? { piSessionId: state.sessionId }
              : {}),
            ...(safeText(state.activity) ? { state: state.activity } : {}),
            connectionGeneration:
              this.store.state.agents[agentId]!.connectionGeneration ?? 1,
          },
        });
        result = { accepted: true };
      } else if (request.method === "agent.list") {
        requirePermission(principal, "read:state");
        const items = Object.values(this.store.state.agents).map((agent) => ({
          ...agent,
          tokenDigest: undefined,
        }));
        result = {
          items,
          nextCursor: null,
          snapshotSeq: this.store.state.lastEventSeq,
        };
      } else if (request.method === "agent.get") {
        requirePermission(principal, "read:state");
        if (!safeText(request.params.agentId))
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Agent ID is invalid.",
          );
        const agent = this.store.state.agents[request.params.agentId];
        if (!agent)
          throw new OrchestratorError(
            "AGENT_NOT_FOUND",
            "Agent was not found.",
          );
        result = { ...agent, tokenDigest: undefined };
      } else if (
        request.method === "agent.prompt" ||
        request.method === "agent.steer" ||
        request.method === "agent.follow_up" ||
        request.method === "agent.abort" ||
        request.method === "agent.compact" ||
        request.method === "agent.set_model" ||
        request.method === "agent.set_thinking" ||
        request.method === "agent.set_tools"
      ) {
        requirePermission(principal, "manage:all");
        throw new OrchestratorError(
          "AGENT_DISCONNECTED",
          "Pi control is available only through a connected adapter.",
          { retryable: true },
        );
      } else if (request.method === "task.create_m3") {
        requirePermission(principal, "delegate");
        const p = request.params;
        if (!safeText(p.title, 256) || !safeText(p.objective, 65_536))
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Task fields are invalid.",
          );
        const taskId = createId("tsk");
        committedEvent = await this.store.append({
          type: "task.created_m3",
          actor: { principalId: principal.id, kind: principal.kind },
          entityRefs: { taskId },
          payload: {
            taskId,
            title: p.title,
            objective: p.objective,
            createdAt: new Date().toISOString(),
            ...(safeText(p.parentAgentId)
              ? { parentAgentId: p.parentAgentId }
              : {}),
            ...(safeText(p.profileId) ? { profileId: p.profileId } : {}),
            ...(Array.isArray(p.dependencies)
              ? { dependencies: p.dependencies }
              : {}),
            ...(safeText(p.timeoutAt) ? { timeoutAt: p.timeoutAt } : {}),
          },
        });
        result = { taskId, state: "queued" };
      } else if (request.method === "task.list") {
        requirePermission(principal, "read:state");
        if (Object.keys(request.params).length)
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "M1 task list parameters must be empty.",
          );
        result = {
          items: Object.values(this.store.state.tasks),
          nextCursor: null,
          snapshotSeq: this.store.state.lastEventSeq,
        };
      } else if (request.method === "task.get") {
        requirePermission(principal, "read:state");
        if (
          !exactKeys(request.params, ["taskId"]) ||
          Object.keys(request.params).length !== 1 ||
          typeof request.params.taskId !== "string" ||
          !/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/.test(request.params.taskId)
        )
          throw new OrchestratorError("INVALID_REQUEST", "Task ID is invalid.");
        result = this.store.state.tasks[request.params.taskId] ?? null;
      } else if (request.method === "task.create") {
        requirePermission(principal, "delegate");
        if (
          !exactKeys(request.params, ["title", "objective"]) ||
          Object.keys(request.params).length !== 2
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "M1 task parameters must contain only title and objective.",
          );
        if (!["human", "cli", "deck"].includes(principal.kind))
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Only an operator client may create M1 synthetic tasks.",
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
          title.length > 256 ||
          objective.length === 0 ||
          objective.length > 65_536
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
          if (Object.keys(this.store.state.tasks).length >= 1_000)
            throw new OrchestratorError(
              "LIMIT_EXCEEDED",
              "The M1 retained-task limit is 1,000.",
            );
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
        await this.snapshotStore
          .write(this.store.state, this.#secret)
          .catch(() => undefined);
      const response = {
        v: 1,
        type: "response",
        id: request.id,
        method: request.method,
        ok: true,
        result,
      };
      this.#writeFrame(client, response);
      for (const event of replayEvents) this.#sendEvent(client, event);
      if (committedEvent)
        for (const subscriber of this.#clients)
          if (
            subscriber.subscribed &&
            this.#matchesFilter(subscriber.eventFilter, committedEvent)
          )
            this.#sendEvent(subscriber, committedEvent);
    } catch (error) {
      const typed =
        error instanceof OrchestratorError
          ? error
          : new OrchestratorError("INVALID_REQUEST", "Request failed.");
      if (typed.code === "PERMISSION_DENIED" && !this.store.readOnly) {
        const denied = await this.store
          .append({
            type: "audit.authorization_denied",
            actor: {
              principalId: principal.id,
              kind: principal.kind,
            },
            entityRefs: {},
            payload: { action: request.method },
          })
          .catch(() => undefined);
        if (denied) {
          await this.snapshotStore
            .write(this.store.state, this.#secret)
            .catch(() => undefined);
          for (const subscriber of this.#clients)
            if (
              subscriber.subscribed &&
              this.#matchesFilter(subscriber.eventFilter, denied)
            )
              this.#sendEvent(subscriber, denied);
        }
      }
      this.#writeFrame(client, {
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
      });
    }
  }
  #matchesFilter(
    filter: SubscriptionFilter | undefined,
    event: import("../state/types.js").StoredEvent,
  ): boolean {
    if (!filter) return true;
    const names = filter.events;
    const agents = filter.agentIds;
    const tasks = filter.taskIds;
    return (
      (!names ||
        names.length === 0 ||
        names.some((name) =>
          name.endsWith(".*")
            ? event.type.startsWith(name.slice(0, -1))
            : event.type === name,
        )) &&
      (!agents ||
        agents.length === 0 ||
        (event.entityRefs.agentId !== undefined &&
          agents.includes(event.entityRefs.agentId))) &&
      (!tasks ||
        tasks.length === 0 ||
        (event.entityRefs.taskId !== undefined &&
          tasks.includes(event.entityRefs.taskId)))
    );
  }
  async #recordAudit(action: string): Promise<void> {
    const previous = this.#mutationTail;
    let release!: () => void;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.store.readOnly) return;
      const event = await this.store.append({
        type: "audit.action",
        actor: {
          principalId: "prn_00000000000000000000000000",
          kind: "system",
        },
        entityRefs: {},
        payload: { action },
      });
      await this.snapshotStore
        .write(this.store.state, this.#secret)
        .catch(() => undefined);
      for (const subscriber of this.#clients)
        if (
          subscriber.subscribed &&
          this.#matchesFilter(subscriber.eventFilter, event)
        )
          this.#sendEvent(subscriber, event);
    } finally {
      release();
    }
  }
  #queueAudit(action: string): void {
    void this.#recordAudit(action).catch(() => undefined);
  }
  #writeFrame(client: Client, frame: unknown): void {
    if (client.slowClosed || client.socket.destroyed) return;
    let encoded: Buffer;
    try {
      encoded = encodeFrame(frame);
    } catch {
      client.slowClosed = true;
      client.socket.destroy();
      this.#queueAudit("oversized_outbound_frame_disconnected");
      return;
    }
    if (client.socket.writableLength + encoded.byteLength > 4 * 1024 * 1024) {
      client.slowClosed = true;
      client.socket.destroy();
      this.#queueAudit("slow_client_disconnected");
      return;
    }
    client.socket.write(encoded);
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
    this.#writeFrame(client, event);
  }
}
