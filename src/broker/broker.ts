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
import {
  validateQuestion,
  validateResult,
  payloadHash,
} from "../results/validation.js";
import type { ResultBody, QuestionBody } from "../results/types.js";
import {
  planWorkflow,
  validateWorkflow,
  type WorkflowDefinition,
} from "../scheduler/workflows.js";
interface SubscriptionFilter {
  events?: string[];
  agentIds?: string[];
  taskIds?: string[];
}
interface ServerResponse {
  v: 1;
  type: "server_response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}
interface PendingServerRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
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
  serverRequests: Map<string, PendingServerRequest>;
  adoptedRegistration: boolean;
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
function isTerminal(value: unknown): boolean {
  return ["succeeded", "failed", "cancelled", "timed_out", "lost"].includes(
    String(value),
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
      serverRequests: new Map(),
      adoptedRegistration: false,
    };
    this.#clients.add(client);
    const authenticationTimer = setTimeout(() => socket.destroy(), 2_000);
    authenticationTimer.unref();
    const decoder = new NdjsonDecoder<
      HelloRequest | RequestFrame | ServerResponse
    >((value) => {
      const type =
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>).type
          : undefined;
      if (type === "hello") return validateHello(value);
      if (type === "server_response") {
        const frame = value as Record<string, unknown>;
        if (
          frame.v !== 1 ||
          typeof frame.id !== "string" ||
          typeof frame.ok !== "boolean"
        )
          throw new Error("Invalid server response.");
        return frame as unknown as ServerResponse;
      }
      return validateRequest(value);
    });
    socket.on("data", (data) => {
      const decoded = decoder.push(data);
      const queued = [] as typeof decoded;
      for (const item of decoded) {
        if (
          item.ok &&
          client.principal &&
          item.value.type === "server_response"
        ) {
          const pending = client.serverRequests.get(item.value.id);
          if (pending) {
            client.serverRequests.delete(item.value.id);
            clearTimeout(pending.timer);
            if (item.value.ok) pending.resolve(item.value.result);
            else
              pending.reject(
                new OrchestratorError(
                  "PI_COMMAND_REJECTED",
                  item.value.error?.message ?? "Child rejected the request.",
                ),
              );
          }
        } else queued.push(item);
      }
      client.processing = client.processing
        .then(async () => {
          for (const item of queued) {
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
                  const credential = resource?.tokenDigest
                    ? {
                        agentId: item.value.auth.agentId,
                        generation: resource.generation ?? 0,
                        tokenHash: resource.tokenDigest,
                        piSessionId:
                          resource.sessionId ?? item.value.auth.piSessionId,
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
      for (const pending of client.serverRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new OrchestratorError(
            "AGENT_DISCONNECTED",
            "Managed adapter disconnected.",
          ),
        );
      }
      client.serverRequests.clear();
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
      const deferred: Array<() => Promise<void>> = [];
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
                  questions: Object.values(this.store.state.questions ?? {}),
                  results: Object.values(this.store.state.results ?? {}),
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
          request.method === "agent.register_adopted" &&
          (principal.kind !== "pi_parent" ||
            client.adoptedRegistration ||
            principal.agentId)
        )
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "This parent connection cannot register another adopted agent.",
          );
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
        const agentId: string = (
          request.method === "agent.register_managed"
            ? (principal.agentId ?? p.agentId)
            : createId("agt")
        ) as string;
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
        if (
          existing &&
          existing.piSessionId !== undefined &&
          existing.piSessionId !== pi.sessionId
        )
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
        if (request.method === "agent.register_adopted") {
          principal.agentId = agentId;
          principal.generation =
            this.store.state.agents[agentId]?.generation ?? 1;
          principal.piSessionId = pi.sessionId as string;
          client.adoptedRegistration = true;
        }
        if (request.method === "agent.register_managed") {
          if (
            this.#herdr &&
            this.store.state.herdrResources?.[agentId]?.state === "pending"
          )
            await this.#herdr.register(
              agentId,
              {
                paneId: herdr.paneId,
                ...(safeText(herdr.terminalId)
                  ? { terminalId: herdr.terminalId }
                  : {}),
                sessionId: pi.sessionId,
                generation: Number(p.generation ?? 1),
              },
              undefined,
            );
          const current = this.store.state.agents[agentId];
          if (current)
            await this.store.append({
              type: "agent.state_changed",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { agentId },
              payload: {
                agentId,
                state: "idle",
                paneId: herdr.paneId,
                piSessionId: pi.sessionId,
                connectionGeneration: (current.connectionGeneration ?? 0) + 1,
              },
            });
          const runId = this.store.state.agents[agentId]?.currentRunId;
          const run = runId ? this.store.state.runs[runId] : undefined;
          if (run) {
            const connectionGeneration =
              this.store.state.agents[agentId]?.connectionGeneration ?? 1;
            const agentGeneration =
              this.store.state.agents[agentId]?.generation ?? 1;
            const assignmentId = run.assignmentId ?? createId("asg");
            await this.store.append({
              type: "assignment.delivered",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { agentId, taskId: run.taskId, runId: run.id },
              payload: {
                assignmentId,
                runId: run.id,
                taskId: run.taskId,
                agentId,
                generation: agentGeneration,
                assignmentGeneration: run.assignmentGeneration,
                piSessionId: pi.sessionId,
                connectionGeneration,
                deliveryState: "pending",
              },
            });
            deferred.push(async () => {
              try {
                const accepted = await this.#sendAdapterRequest(
                  agentId,
                  "assignment.deliver",
                  {
                    assignment: {
                      id: assignmentId,
                      taskId: run.taskId,
                      runId: run.id,
                      agentId,
                      generation: agentGeneration,
                      assignmentGeneration: run.assignmentGeneration,
                      objective:
                        this.store.state.tasks[run.taskId]?.objective ?? "",
                      constraints:
                        this.store.state.tasks[run.taskId]?.constraints ?? [],
                      deadline:
                        this.store.state.tasks[run.taskId]?.timeoutAt ??
                        new Date(Date.now() + 900_000).toISOString(),
                      resultContract: { schemaVersion: 1, required: true },
                    },
                  },
                  {
                    generation: agentGeneration,
                    connectionGeneration,
                    assignmentGeneration: run.assignmentGeneration,
                    piSessionId: pi.sessionId as string,
                    runId: run.id,
                  },
                );
                if (
                  accepted &&
                  typeof accepted === "object" &&
                  ["accepted", "already_accepted"].includes(
                    String((accepted as Record<string, unknown>).status),
                  )
                )
                  await this.store.append({
                    type: "assignment.accepted",
                    actor: { principalId: principal.id, kind: principal.kind },
                    entityRefs: { agentId, taskId: run.taskId, runId: run.id },
                    payload: {
                      assignmentId,
                      runId: run.id,
                      taskId: run.taskId,
                      agentId,
                      generation: agentGeneration,
                      assignmentGeneration: run.assignmentGeneration,
                      piSessionId: pi.sessionId,
                      connectionGeneration,
                      deliveryState: "accepted",
                    },
                  });
              } catch (error) {
                await this.store
                  .append({
                    type: "assignment.delivery_failed",
                    actor: { principalId: principal.id, kind: principal.kind },
                    entityRefs: { agentId, taskId: run.taskId, runId: run.id },
                    payload: {
                      assignmentId,
                      runId: run.id,
                      taskId: run.taskId,
                      agentId,
                      generation: agentGeneration,
                      assignmentGeneration: run.assignmentGeneration,
                      reason:
                        error instanceof Error
                          ? error.message
                          : "delivery_failed",
                      retryable: true,
                    },
                  })
                  .catch(() => undefined);
              }
            });
          }
        }
        result = {
          agentId,
          generation: this.store.state.agents[agentId]?.generation ?? 1,
          connectionGeneration:
            this.store.state.agents[agentId]?.connectionGeneration ?? 1,
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
      } else if (request.method === "agent.lifecycle_event") {
        requirePermission(principal, "manage:self");
        const p = request.params;
        if (
          !exactKeys(p, [
            "agentId",
            "connectionGeneration",
            "adapterSeq",
            "event",
            "piSessionId",
            "turnIndex",
            "agentCycleId",
            "assignment",
            "safeData",
          ]) ||
          principal.kind !== "pi_child" ||
          principal.agentId !== p.agentId ||
          !Number.isSafeInteger(p.connectionGeneration) ||
          !Number.isSafeInteger(p.adapterSeq) ||
          !safeText(p.event, 64) ||
          !safeText(p.piSessionId, 256)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Lifecycle event is invalid.",
          );
        const lifecycleAgentId = p.agentId as string;
        const agent = this.store.state.agents[lifecycleAgentId];
        if (
          !agent ||
          agent.generation !== principal.generation ||
          agent.connectionGeneration !== p.connectionGeneration ||
          agent.piSessionId !== p.piSessionId
        )
          throw new OrchestratorError(
            "AGENT_REPLACED",
            "Lifecycle identity is stale.",
          );
        const assignment =
          p.assignment &&
          typeof p.assignment === "object" &&
          !Array.isArray(p.assignment)
            ? (p.assignment as Record<string, unknown>)
            : undefined;
        const progressEvent = [
          "before_agent_start",
          "agent_start",
          "turn_start",
          "agent_settled",
        ].includes(p.event as string);
        if (
          !assignment ||
          Object.keys(assignment).some(
            (key) =>
              ![
                "assignmentId",
                "taskId",
                "runId",
                "generation",
                "assignmentGeneration",
              ].includes(key),
          )
        ) {
          committedEvent = await this.store.append({
            type: "agent.state_changed",
            actor: { principalId: principal.id, kind: principal.kind },
            entityRefs: { agentId: agent.id },
            payload: {
              agentId: agent.id,
              state: p.event === "blocked" ? "blocked" : "idle",
            },
          });
          result = { accepted: false, manual: true, state: "idle" };
        } else {
          const assignmentId = assignment.assignmentId;
          const runId = assignment.runId;
          if (
            !safeText(assignmentId) ||
            !safeText(assignment.taskId) ||
            !safeText(runId) ||
            !Number.isSafeInteger(assignment.generation) ||
            !Number.isSafeInteger(assignment.assignmentGeneration)
          )
            throw new OrchestratorError(
              "RUN_MISMATCH",
              "Lifecycle assignment correlation is invalid.",
            );
          const run = this.store.state.runs[runId];
          if (
            !run ||
            run.agentId !== agent.id ||
            run.taskId !== assignment.taskId ||
            run.assignmentId !== assignmentId ||
            assignment.generation !== agent.generation ||
            assignment.assignmentGeneration !== run.assignmentGeneration
          )
            throw new OrchestratorError(
              "RUN_MISMATCH",
              "Lifecycle assignment identity is stale.",
            );
          const exactTurn =
            Number.isSafeInteger(p.turnIndex) &&
            Number(p.turnIndex) >= 0 &&
            safeText(p.agentCycleId, 256);
          if (progressEvent && !exactTurn) {
            committedEvent = await this.store.append({
              type: "agent.state_changed",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { agentId: agent.id },
              payload: { agentId: agent.id, state: "idle" },
            });
            result = {
              accepted: false,
              manual: true,
              runId: run.id,
              state: run.state,
            };
          } else if (p.event === "agent_settled") {
            committedEvent = await this.store.append({
              type: "run.pi_settled",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: {
                agentId: agent.id,
                runId: run.id,
                taskId: run.taskId,
              },
              payload: {
                agentId: agent.id,
                runId: run.id,
                piSessionId: p.piSessionId,
                state: "settled",
                turnIndex: p.turnIndex,
                agentCycleId: p.agentCycleId,
                terminalError: false,
              },
            });
            result = {
              accepted: true,
              runId: run.id,
              state: this.store.state.runs[run.id]?.state,
            };
          } else if (
            ["before_agent_start", "agent_start", "turn_start"].includes(
              p.event as string,
            )
          ) {
            committedEvent = await this.store.append({
              type: "run.pi_started",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: {
                agentId: agent.id,
                runId: run.id,
                taskId: run.taskId,
              },
              payload: {
                agentId: agent.id,
                runId: run.id,
                piSessionId: p.piSessionId,
                state: "working",
                turnIndex: p.turnIndex,
                agentCycleId: p.agentCycleId,
              },
            });
            result = {
              accepted: true,
              runId: run.id,
              state: this.store.state.runs[run.id]?.state,
            };
          } else {
            committedEvent = await this.store.append({
              type: "agent.state_changed",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { agentId: agent.id },
              payload: {
                agentId: agent.id,
                state: p.event === "blocked" ? "blocked" : "idle",
              },
            });
            result = {
              accepted: false,
              manual: true,
              runId: run.id,
              state: run.state,
            };
          }
        }
      } else if (request.method === "agent.list") {
        requirePermission(principal, "read:state");
        const items = (
          await Promise.all(
            Object.values(this.store.state.agents).map(async (agent) =>
              (await this.#canAccessAgent(principal, agent.id))
                ? { ...agent, tokenDigest: undefined }
                : undefined,
            ),
          )
        ).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
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
        if (!(await this.#canAccessAgent(principal, agent.id)))
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Agent is outside the descendant scope.",
          );
        result = { ...agent, tokenDigest: undefined };
      } else if (
        request.method === "agent.prompt" ||
        request.method === "agent.steer" ||
        request.method === "agent.follow_up" ||
        request.method === "agent.abort" ||
        request.method === "agent.interrupt" ||
        request.method === "agent.compact" ||
        request.method === "agent.set_model" ||
        request.method === "agent.set_thinking" ||
        request.method === "agent.set_tools" ||
        request.method === "agent.set_tool_expansion" ||
        request.method === "agent.wait" ||
        request.method === "agent.stop" ||
        request.method === "agent.close"
      ) {
        requirePermission(principal, "manage:self");
        const p = request.params;
        if (
          !safeText(p.agentId) ||
          (p.generation !== undefined &&
            (!Number.isSafeInteger(p.generation) ||
              Number(p.generation) < 1)) ||
          (p.runId !== undefined && !safeText(p.runId))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Agent control identity is invalid.",
          );
        const agent = this.store.state.agents[p.agentId];
        if (!agent)
          throw new OrchestratorError(
            "AGENT_NOT_FOUND",
            "Agent was not found.",
          );
        const target = p.agentId as string;
        if (
          principal.kind === "pi_parent" &&
          !(await this.#isDescendant(principal.agentId, target))
        )
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Agent is outside the descendant scope.",
          );
        if (
          request.method === "agent.stop" ||
          request.method === "agent.close"
        ) {
          if (!this.#herdr)
            throw new OrchestratorError(
              "AGENT_DISCONNECTED",
              "Herdr is unavailable.",
              { retryable: true },
            );
          const resource = this.store.state.herdrResources?.[target];
          if (!resource?.paneId)
            throw new OrchestratorError(
              "AGENT_DISCONNECTED",
              "Managed pane identity is unavailable.",
            );
          const guard = {
            paneId: resource.paneId,
            ...(resource.terminalId ? { terminalId: resource.terminalId } : {}),
            ...(resource.sessionId ? { sessionId: resource.sessionId } : {}),
            ...(resource.generation ? { generation: resource.generation } : {}),
          } as never;
          if (request.method === "agent.stop") await this.#herdr.stop(guard);
          else await this.#herdr.close(guard);
          result = {
            agentId: target,
            state: request.method === "agent.stop" ? "stopped" : "closed",
          };
        } else if (request.method === "agent.wait") {
          if (
            !p.taskId ||
            !p.runId ||
            !safeText(p.taskId) ||
            !safeText(p.runId) ||
            (p.timeoutMs !== undefined &&
              (!Number.isSafeInteger(p.timeoutMs) ||
                Number(p.timeoutMs) < 1 ||
                Number(p.timeoutMs) > 30_000))
          )
            throw new OrchestratorError(
              "INVALID_REQUEST",
              "Managed wait identity is invalid.",
            );
          const run = this.store.state.runs[p.runId as string];
          if (!run || run.agentId !== target || run.taskId !== p.taskId)
            throw new OrchestratorError(
              "RUN_MISMATCH",
              "Wait run identity does not match.",
            );
          result = {
            agentId: target,
            taskId: run.taskId,
            runId: run.id,
            state: run.state,
            settled: run.settled,
          };
        } else {
          const method =
            request.method === "agent.prompt"
              ? "control.prompt"
              : request.method === "agent.steer" ||
                  request.method === "agent.follow_up"
                ? "control.steer"
                : request.method === "agent.abort" ||
                    request.method === "agent.interrupt"
                  ? "control.abort"
                  : request.method === "agent.compact"
                    ? "control.compact"
                    : request.method === "agent.set_model"
                      ? "control.set_model"
                      : request.method === "agent.set_thinking"
                        ? "control.set_thinking"
                        : request.method === "agent.set_tool_expansion"
                          ? "control.set_tool_expansion"
                          : "control.set_tools";
          const runId =
            typeof p.runId === "string" ? p.runId : agent.currentRunId;
          const run = runId ? this.store.state.runs[runId] : undefined;
          if (p.generation !== undefined && p.generation !== agent.generation)
            throw new OrchestratorError(
              "AGENT_REPLACED",
              "Agent generation is stale.",
            );
          const params = { ...p };
          delete params.agentId;
          delete params.generation;
          delete params.runId;
          result = await this.#sendAdapterRequest(
            target,
            method,
            params,
            {
              generation: agent.generation,
              ...(agent.piSessionId ? { piSessionId: agent.piSessionId } : {}),
              ...(run ? { runId: run.id } : {}),
            },
            typeof p.timeoutMs === "number" ? p.timeoutMs : 10_000,
          );
        }
      } else if (request.method === "result.publish") {
        requirePermission(principal, "manage:self");
        const p = request.params;
        if (
          !exactKeys(p, [
            "agentId",
            "taskId",
            "runId",
            "assignmentGeneration",
            "result",
          ]) ||
          !safeText(p.agentId) ||
          !safeText(p.taskId) ||
          !safeText(p.runId) ||
          !Number.isSafeInteger(p.assignmentGeneration)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Result correlation is invalid.",
          );
        if (principal.kind === "pi_child" && principal.agentId !== p.agentId)
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Result agent does not match the authenticated child.",
          );
        const run = this.store.state.runs[p.runId];
        if (
          !run ||
          run.taskId !== p.taskId ||
          run.agentId !== p.agentId ||
          run.assignmentGeneration !== p.assignmentGeneration ||
          isTerminal(run.state)
        )
          throw new OrchestratorError(
            "RUN_MISMATCH",
            "Run identity or assignment generation does not match.",
          );
        if (!(await this.#canAccessAgent(principal, p.agentId)))
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Run is outside the descendant scope.",
          );
        validateResult(p.result);
        const body = p.result as ResultBody;
        const hash = payloadHash(body);
        const prior = Object.values(this.store.state.results ?? {}).find(
          (item) => item.runId === run.id,
        );
        if (prior) {
          if (prior.payloadHash !== hash)
            throw new OrchestratorError(
              "RESULT_ALREADY_PUBLISHED",
              "A different terminal result is already published.",
            );
          result = { resultId: prior.id, state: "already_published" };
        } else {
          const id = createId("res");
          const publishedAt = new Date().toISOString();
          committedEvent = await this.store.append({
            type: "result.published",
            actor: { principalId: principal.id, kind: principal.kind },
            entityRefs: {
              taskId: run.taskId,
              runId: run.id,
              agentId: p.agentId,
              resultId: id,
            },
            payload: {
              resultId: id,
              payloadHash: hash,
              status: body.status,
              assignmentGeneration: p.assignmentGeneration,
              payload: body,
              publishedAt,
              piSettled: run.settled,
            },
          });
          await this.store.append({
            type: "result.validated",
            actor: { principalId: principal.id, kind: principal.kind },
            entityRefs: { resultId: id, runId: run.id },
            payload: {
              piSettled: run.settled,
              schemaValid: true,
              correlationValid: true,
            },
          });
          if (run.settled)
            await this.store.append({
              type: "run.state_changed",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { runId: run.id, taskId: run.taskId },
              payload: {
                runId: run.id,
                state: body.status === "succeeded" ? "succeeded" : body.status,
              },
            });
          result = {
            resultId: id,
            state: run.settled ? body.status : "result_pending",
          };
        }
      } else if (request.method === "result.get") {
        requirePermission(principal, "read:results");
        if (
          Object.keys(request.params).some(
            (key) => !["resultId", "taskId"].includes(key),
          ) ||
          (!safeText(request.params.resultId) &&
            !safeText(request.params.taskId))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Result ID is invalid.",
          );
        const item = safeText(request.params.resultId)
          ? this.store.state.results?.[request.params.resultId]
          : Object.values(this.store.state.results ?? {}).find(
              (candidate) => candidate.taskId === request.params.taskId,
            );
        if (!item)
          throw new OrchestratorError("NOT_FOUND", "Result was not found.");
        if (!(await this.#canAccessTask(principal, item.taskId)))
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Result is outside the descendant scope.",
          );
        const task = this.store.state.tasks[item.taskId];
        if (
          principal.kind === "pi_child" &&
          task?.parentAgentId !== principal.agentId &&
          item.agentId !== principal.agentId
        )
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Result is outside the descendant scope.",
          );
        result = item;
      } else if (request.method === "question.open") {
        requirePermission(principal, "manage:self");
        const p = request.params;
        if (
          !exactKeys(p, [
            "agentId",
            "taskId",
            "runId",
            "assignmentGeneration",
            "question",
          ]) ||
          !safeText(p.agentId) ||
          !safeText(p.taskId) ||
          !safeText(p.runId) ||
          !Number.isSafeInteger(p.assignmentGeneration)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Question correlation is invalid.",
          );
        if (principal.kind === "pi_child" && principal.agentId !== p.agentId)
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Question agent does not match the authenticated child.",
          );
        const run = this.store.state.runs[p.runId];
        if (
          !run ||
          run.taskId !== p.taskId ||
          run.agentId !== p.agentId ||
          run.assignmentGeneration !== p.assignmentGeneration ||
          run.state !== "working"
        )
          throw new OrchestratorError(
            "RUN_MISMATCH",
            "Run identity or assignment generation does not match.",
          );
        if (!(await this.#canAccessAgent(principal, p.agentId)))
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Run is outside the descendant scope.",
          );
        if (
          Object.values(this.store.state.questions ?? {}).some(
            (q) => q.runId === run.id && q.state === "open",
          )
        )
          throw new OrchestratorError(
            "LIMIT_EXCEEDED",
            "A run may have only one open question.",
          );
        validateQuestion(p.question);
        const q = p.question as QuestionBody;
        const id = createId("qst");
        const askedAt = new Date().toISOString();
        committedEvent = await this.store.append({
          type: "question.opened",
          actor: { principalId: principal.id, kind: principal.kind },
          entityRefs: {
            questionId: id,
            taskId: run.taskId,
            runId: run.id,
            agentId: run.agentId!,
          },
          payload: {
            questionId: id,
            assignmentGeneration: p.assignmentGeneration,
            payload: q,
            askedAt,
          },
        });
        await this.store.append({
          type: "run.state_changed",
          actor: { principalId: principal.id, kind: principal.kind },
          entityRefs: { runId: run.id, taskId: run.taskId },
          payload: { runId: run.id, state: "blocked" },
        });
        result = {
          ...(this.store.state.questions?.[id] ?? {}),
          id,
          payload: q,
          askedAt,
        };
      } else if (request.method === "question.answer") {
        requirePermission(principal, "read:state");
        const p = request.params;
        if (
          !exactKeys(p, ["questionId", "answer"]) ||
          !safeText(p.questionId) ||
          !p.answer ||
          typeof p.answer !== "object"
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Question answer is invalid.",
          );
        const question = this.store.state.questions?.[p.questionId];
        if (!question)
          throw new OrchestratorError(
            "QUESTION_NOT_FOUND",
            "Question was not found.",
          );
        if (question.state !== "open")
          throw new OrchestratorError(
            "QUESTION_ALREADY_ANSWERED",
            "Question is already terminal.",
          );
        const body = question.payload as QuestionBody | undefined;
        const answer = p.answer as { optionId?: unknown; text?: unknown };
        if (
          answer.optionId !== undefined &&
          !body?.options.some((o) => o.id === answer.optionId)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Answer option is not present.",
          );
        if (
          answer.optionId === undefined &&
          (!body?.allowFreeform ||
            typeof answer.text !== "string" ||
            answer.text.length > 16_384)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Free-form answer is not allowed or is invalid.",
          );
        const run = this.store.state.runs[question.runId];
        if (
          principal.kind === "pi_parent" &&
          run?.agentId &&
          principal.agentId !== run.agentId
        ) {
          let current: string | undefined = run.agentId;
          let allowed = false;
          for (let depth = 0; depth < 5 && current; depth++) {
            if (current === principal.agentId) {
              allowed = true;
              break;
            }
            current = this.store.state.agents[current]?.parentAgentId;
          }
          if (!allowed)
            throw new OrchestratorError(
              "PERMISSION_DENIED",
              "Question is outside the descendant scope.",
            );
        }
        committedEvent = await this.store.append({
          type: "question.answered",
          actor: { principalId: principal.id, kind: principal.kind },
          entityRefs: {
            questionId: question.id,
            taskId: question.taskId,
            runId: question.runId,
          },
          payload: {
            questionId: question.id,
            answeredBy: principal.id,
            answeredAt: new Date().toISOString(),
            answer: {
              ...(typeof answer.optionId === "string"
                ? { optionId: answer.optionId }
                : {}),
              ...(typeof answer.text === "string" ? { text: answer.text } : {}),
            },
          },
        });
        await this.store.append({
          type: "run.state_changed",
          actor: { principalId: principal.id, kind: principal.kind },
          entityRefs: { runId: question.runId, taskId: question.taskId },
          payload: { runId: question.runId, state: "working" },
        });
        result = this.store.state.questions?.[question.id];
      } else if (request.method === "question.timeout") {
        requirePermission(principal, "manage:all");
        if (
          !exactKeys(request.params, ["questionId"]) ||
          !safeText(request.params.questionId)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Question ID is invalid.",
          );
        const question =
          this.store.state.questions?.[request.params.questionId];
        if (!question)
          throw new OrchestratorError(
            "QUESTION_NOT_FOUND",
            "Question was not found.",
          );
        if (question.state !== "open") {
          result = question;
        } else {
          committedEvent = await this.store.append({
            type: "question.timed_out",
            actor: { principalId: principal.id, kind: principal.kind },
            entityRefs: {
              questionId: question.id,
              taskId: question.taskId,
              runId: question.runId,
            },
            payload: { questionId: question.id },
          });
          await this.store.append({
            type: "run.state_changed",
            actor: { principalId: principal.id, kind: principal.kind },
            entityRefs: { runId: question.runId, taskId: question.taskId },
            payload: { runId: question.runId, state: "failed" },
          });
          result = this.store.state.questions?.[question.id];
        }
      } else if (request.method === "task.cancel") {
        requirePermission(principal, "delegate");
        if (
          Object.keys(request.params).some(
            (key) => !["taskId", "reason", "cascade"].includes(key),
          ) ||
          !safeText(request.params.taskId) ||
          !safeText(request.params.reason, 256) ||
          (request.params.cascade !== undefined &&
            typeof request.params.cascade !== "boolean")
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Task cancellation is invalid.",
          );
        const task = this.store.state.tasks[request.params.taskId];
        if (!task)
          throw new OrchestratorError("TASK_NOT_FOUND", "Task was not found.");
        if (!(await this.#canAccessTask(principal, task.id)))
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Task is outside the descendant scope.",
          );
        committedEvent = await this.store.append({
          type: "task.cancel_requested",
          actor: { principalId: principal.id, kind: principal.kind },
          entityRefs: { taskId: task.id },
          payload: {
            taskId: task.id,
            reason: request.params.reason,
            cascade: request.params.cascade === true,
          },
        });
        result = { taskId: task.id, state: "cancelled" };
      } else if (request.method === "task.collect") {
        requirePermission(principal, "read:results");
        if (
          Object.keys(request.params).some(
            (key) => !["taskIds", "maxBytes"].includes(key),
          ) ||
          !Array.isArray(request.params.taskIds) ||
          request.params.taskIds.length > 64
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Task collection is invalid.",
          );
        const maxBytes =
          request.params.maxBytes === undefined
            ? 32_768
            : request.params.maxBytes;
        if (
          !Number.isSafeInteger(maxBytes) ||
          Number(maxBytes) < 1 ||
          Number(maxBytes) > 262_144
        )
          throw new OrchestratorError(
            "LIMIT_EXCEEDED",
            "Collection output limit is invalid.",
          );
        for (const id of request.params.taskIds as unknown[])
          if (
            typeof id === "string" &&
            !(await this.#canAccessTask(principal, id))
          )
            throw new OrchestratorError(
              "PERMISSION_DENIED",
              "Task is outside the descendant scope.",
            );
        const items = (request.params.taskIds as unknown[]).map((id) => {
          if (typeof id !== "string")
            return { taskId: "invalid", result: null, retrieval: null };
          const task = this.store.state.tasks[id];
          if (!task)
            return {
              taskId: id,
              result: null,
              retrieval: { method: "task.get", params: { taskId: id } },
            };
          const found = Object.values(this.store.state.results ?? {}).find(
            (r) => r.taskId === id,
          );
          return {
            taskId: id,
            id: found?.id,
            state: task.state,
            result: found
              ? {
                  id: found.id,
                  resultId: found.id,
                  status: found.status,
                  summary:
                    typeof (found.payload as { summary?: unknown } | undefined)
                      ?.summary === "string"
                      ? (found.payload as { summary: string }).summary
                      : undefined,
                }
              : null,
            retrieval: found
              ? { method: "result.get", params: { taskId: id } }
              : { method: "task.get", params: { taskId: id } },
          };
        });
        const bounded: unknown[] = [];
        let used = 2;
        let truncated = false;
        for (const item of items) {
          const encoded = JSON.stringify(item);
          if (used + Buffer.byteLength(encoded) + 1 <= Number(maxBytes)) {
            bounded.push(item);
            used += Buffer.byteLength(encoded) + 1;
          } else {
            truncated = true;
            bounded.push({
              taskId: (item as { taskId: string }).taskId,
              result: null,
              truncated: true,
              retrieval: (item as { retrieval: unknown }).retrieval,
            });
          }
        }
        let collection = { items: bounded, truncated };
        if (Buffer.byteLength(JSON.stringify(collection)) > Number(maxBytes)) {
          collection = {
            items: items.map((item) => ({
              taskId: (item as { taskId: string }).taskId,
              truncated: true,
              retrieval: (item as { retrieval: unknown }).retrieval,
            })),
            truncated: true,
          };
        }
        if (Buffer.byteLength(JSON.stringify(collection)) > Number(maxBytes))
          throw new OrchestratorError(
            "LIMIT_EXCEEDED",
            "Collection cannot fit the requested output bound.",
          );
        result = collection;
      } else if (
        request.method === "agent.spawn" ||
        request.method === "delegate.execute"
      ) {
        requirePermission(principal, "delegate");
        const p = request.params;
        const allowedKeys =
          request.method === "agent.spawn"
            ? [
                "task",
                "profileId",
                "project",
                "isolation",
                "budget",
                "parentAgentId",
                "dryRun",
                "objective",
              ]
            : [
                "mode",
                "title",
                "parentAgentId",
                "steps",
                "wait",
                "waitUntil",
                "timeoutMs",
                "failureMode",
                "dryRun",
              ];
        if (Object.keys(p).some((key) => !allowedKeys.includes(key)))
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Delegation request contains unknown fields.",
          );
        if (
          principal.kind === "pi_parent" &&
          safeText(p.parentAgentId) &&
          p.parentAgentId !== principal.agentId
        )
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "A parent cannot target another parent subtree.",
          );
        const parentAgentId =
          principal.kind === "pi_parent"
            ? principal.agentId
            : safeText(p.parentAgentId)
              ? p.parentAgentId
              : undefined;
        if (!parentAgentId)
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "A broker-bound parent identity is required.",
          );
        if (!(await this.#canAccessAgent(principal, parentAgentId)))
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Parent is outside the authenticated scope.",
          );
        const dryRun = p.dryRun === true;
        const steps =
          request.method === "agent.spawn"
            ? [
                {
                  key: "single",
                  profileId: p.profileId,
                  title:
                    p.task &&
                    typeof p.task === "object" &&
                    safeText((p.task as Record<string, unknown>).title)
                      ? (p.task as Record<string, unknown>).title
                      : "Delegated task",
                  objective:
                    p.task &&
                    typeof p.task === "object" &&
                    safeText(
                      (p.task as Record<string, unknown>).objective,
                      65_536,
                    )
                      ? (p.task as Record<string, unknown>).objective
                      : p.objective,
                  constraints:
                    p.task &&
                    typeof p.task === "object" &&
                    Array.isArray(
                      (p.task as Record<string, unknown>).constraints,
                    )
                      ? (p.task as Record<string, unknown>).constraints
                      : [],
                  dependsOn: [],
                },
              ]
            : Array.isArray(p.steps)
              ? p.steps
              : [];
        if (
          !Array.isArray(steps) ||
          steps.length === 0 ||
          steps.length > 32 ||
          steps.some(
            (step) =>
              !step ||
              typeof step !== "object" ||
              !safeText((step as Record<string, unknown>).profileId, 64) ||
              !safeText((step as Record<string, unknown>).objective, 65_536),
          )
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Delegation steps are invalid.",
          );
        const workflowId = createId("wfl");
        const planned = steps.map((raw) => ({
          key: safeText((raw as Record<string, unknown>).key, 64)
            ? ((raw as Record<string, unknown>).key as string)
            : createId("tsk"),
          profileId: (raw as Record<string, unknown>).profileId as string,
          title: safeText((raw as Record<string, unknown>).title, 256)
            ? ((raw as Record<string, unknown>).title as string)
            : "Delegated task",
          objective: (raw as Record<string, unknown>).objective as string,
          constraints: Array.isArray(
            (raw as Record<string, unknown>).constraints,
          )
            ? ((raw as Record<string, unknown>).constraints as unknown[])
            : [],
          dependsOn: Array.isArray((raw as Record<string, unknown>).dependsOn)
            ? ((raw as Record<string, unknown>).dependsOn as unknown[])
            : [],
        }));
        if (dryRun) {
          result = {
            workflowId,
            state: "created",
            plan: planned.map((step) => ({
              key: step.key,
              profileId: step.profileId,
              title: step.title,
              objective: step.objective,
              estimatedAgentCount: 1,
            })),
          };
        } else {
          const taskIds = planned.map(() => createId("tsk"));
          committedEvent = await this.store.append({
            type: "workflow.created",
            actor: { principalId: principal.id, kind: principal.kind },
            entityRefs: { workflowId },
            payload: {
              workflowId,
              taskIds,
              parentAgentId,
              mode:
                request.method === "delegate.execute"
                  ? safeText(p.mode, 32)
                    ? p.mode
                    : "parallel"
                  : "single",
            },
          });
          const spawned: Array<Record<string, unknown>> = [];
          for (let index = 0; index < planned.length; index++) {
            const step = planned[index]!;
            const taskId = taskIds[index]!;
            const agentId = createId("agt");
            const runId = createId("run");
            const assignmentId = createId("asg");
            await this.store.append({
              type: "task.created_m3",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { taskId },
              payload: {
                taskId,
                title: step.title,
                objective: step.objective,
                createdAt: new Date().toISOString(),
                parentAgentId,
                profileId: step.profileId,
                dependencies: step.dependsOn
                  .map((key) =>
                    planned.find((candidate) => candidate.key === key),
                  )
                  .filter(Boolean)
                  .map((candidate) => taskIds[planned.indexOf(candidate!)]),
              },
            });
            await this.store.append({
              type: "agent.registered",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { agentId },
              payload: {
                agentId,
                managed: true,
                generation: 1,
                parentAgentId,
                profileId: step.profileId,
                displayName: step.title,
              },
            });
            await this.store.append({
              type: "run.created",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { runId, taskId, agentId },
              payload: {
                runId,
                taskId,
                agentId,
                assignmentId,
                assignmentGeneration: 1,
                agentGeneration: 1,
              },
            });
            await this.store.append({
              type: "task.state_changed",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { taskId },
              payload: { to: "provisioning" },
            });
            if (!this.#herdr)
              throw new OrchestratorError(
                "HERDR_UNAVAILABLE",
                "Injected Herdr service is unavailable.",
              );
            const provisionParams =
              p.project && typeof p.project === "object"
                ? (p.project as Record<string, unknown>)
                : {};
            const provisioned = await this.#herdr.provision({
              agentId,
              parentAgentId,
              role: step.profileId,
              workspaceId: safeText(provisionParams.workspaceId)
                ? provisionParams.workspaceId
                : "",
              cwd: safeText(provisionParams.cwd) ? provisionParams.cwd : ".",
              profileId: step.profileId,
              isolation:
                provisionParams.isolation === "worktree"
                  ? "worktree"
                  : "shared-readonly",
              prompt: step.objective,
              ...(safeText(provisionParams.projectBase)
                ? { projectBase: provisionParams.projectBase }
                : {}),
              ...(safeText(provisionParams.branch)
                ? { branch: provisionParams.branch }
                : {}),
            });
            await this.store.append({
              type: "agent.state_changed",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { agentId },
              payload: {
                agentId,
                state: "starting",
                ...(provisioned.paneId ? { paneId: provisioned.paneId } : {}),
              },
            });
            spawned.push({
              key: step.key,
              taskId,
              runId,
              agentId,
              assignmentId,
              assignmentGeneration: 1,
              state: "provisioning",
              paneId: provisioned.paneId,
            });
          }
          result = { workflowId, state: "running", tasks: spawned };
        }
      } else if (request.method === "workflow.create") {
        requirePermission(principal, "delegate");
        const p = request.params;
        if (
          Object.keys(p).some(
            (key) =>
              !["definition", "objective", "parentAgentId", "dryRun"].includes(
                key,
              ),
          ) ||
          !p.definition ||
          typeof p.definition !== "object" ||
          !safeText(p.objective, 65_536) ||
          (!safeText(p.parentAgentId) && !principal.agentId) ||
          (principal.kind === "pi_parent" && !principal.agentId)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Workflow parameters are invalid.",
          );
        const parentAgentId =
          principal.kind === "pi_parent"
            ? principal.agentId!
            : safeText(p.parentAgentId)
              ? p.parentAgentId
              : principal.agentId!;
        if (!(await this.#canAccessAgent(principal, parentAgentId)))
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Workflow parent is outside the authenticated scope.",
          );
        try {
          validateWorkflow(p.definition as WorkflowDefinition);
        } catch {
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Workflow definition is invalid.",
          );
        }
        const plan = planWorkflow(p.definition as WorkflowDefinition, {
          objective: p.objective as string,
          dryRun: p.dryRun === true,
        });
        const taskIds = plan.steps.map((step) => step.taskId);
        if (p.dryRun !== true)
          committedEvent = await this.store.append({
            type: "workflow.created",
            actor: { principalId: principal.id, kind: principal.kind },
            entityRefs: { workflowId: plan.workflowId },
            payload: {
              workflowId: plan.workflowId,
              taskIds,
              parentAgentId,
              mode: plan.mode,
            },
          });
        if (p.dryRun !== true)
          for (const step of plan.steps)
            await this.store.append({
              type: "task.created_m3",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { taskId: step.taskId },
              payload: {
                taskId: step.taskId,
                title:
                  (p.definition as WorkflowDefinition).steps.find(
                    (x) => x.key === step.key,
                  )?.title ?? step.key,
                objective: step.objective,
                createdAt: new Date().toISOString(),
                parentAgentId,
                profileId: step.profileId,
                dependencies: step.dependsOn
                  .map((key) => plan.steps.find((x) => x.key === key)?.taskId)
                  .filter((x): x is string => Boolean(x)),
              },
            });
        if (p.dryRun !== true) {
          // Task events are committed only for a real workflow.
        }
        result = {
          workflowId: plan.workflowId,
          state: p.dryRun === true ? "created" : "created",
          tasks: plan.steps.map((s) => ({
            key: s.key,
            taskId: s.taskId,
            state: "queued",
          })),
        };
      } else if (request.method === "workflow.get") {
        requirePermission(principal, "read:state");
        if (
          !exactKeys(request.params, ["workflowId"]) ||
          !safeText(request.params.workflowId)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Workflow ID is invalid.",
          );
        const workflow = this.store.state.workflows[request.params.workflowId];
        if (!workflow)
          throw new OrchestratorError(
            "WORKFLOW_NOT_FOUND",
            "Workflow was not found.",
          );
        if (
          !(
            await Promise.all(
              workflow.taskIds.map((id) => this.#canAccessTask(principal, id)),
            )
          ).every(Boolean)
        )
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Workflow is outside the descendant scope.",
          );
        result = {
          ...workflow,
          tasks: workflow.taskIds
            .map((id) => this.store.state.tasks[id])
            .filter(Boolean),
        };
      } else if (request.method === "workflow.list") {
        requirePermission(principal, "read:state");
        if (Object.keys(request.params).length)
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Workflow list parameters must be empty.",
          );
        result = {
          items: (
            await Promise.all(
              Object.values(this.store.state.workflows).map(async (workflow) =>
                (
                  await Promise.all(
                    workflow.taskIds.map((id) =>
                      this.#canAccessTask(principal, id),
                    ),
                  )
                ).every(Boolean)
                  ? workflow
                  : undefined,
              ),
            )
          ).filter((workflow): workflow is NonNullable<typeof workflow> =>
            Boolean(workflow),
          ),
          nextCursor: null,
          snapshotSeq: this.store.state.lastEventSeq,
        };
      } else if (request.method === "workflow.cancel") {
        requirePermission(principal, "delegate");
        if (
          Object.keys(request.params).some(
            (key) => !["workflowId", "cascade"].includes(key),
          ) ||
          !safeText(request.params.workflowId)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Workflow cancellation is invalid.",
          );
        const workflow = this.store.state.workflows[request.params.workflowId];
        if (!workflow)
          throw new OrchestratorError(
            "WORKFLOW_NOT_FOUND",
            "Workflow was not found.",
          );
        if (
          !(
            await Promise.all(
              workflow.taskIds.map((id) => this.#canAccessTask(principal, id)),
            )
          ).every(Boolean)
        )
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Workflow is outside the descendant scope.",
          );
        committedEvent = await this.store.append({
          type: "workflow.state_changed",
          actor: { principalId: principal.id, kind: principal.kind },
          entityRefs: { workflowId: workflow.id },
          payload: { workflowId: workflow.id, state: "cancelled" },
        });
        if (request.params.cascade !== false)
          for (const taskId of workflow.taskIds) {
            const task = this.store.state.tasks[taskId];
            if (task && !isTerminal(task.state))
              await this.store.append({
                type: "task.cancel_requested",
                actor: { principalId: principal.id, kind: principal.kind },
                entityRefs: { taskId },
                payload: {
                  taskId,
                  reason: "workflow_cancelled",
                  cascade: true,
                },
              });
          }
        result = { workflowId: workflow.id, state: "cancelled" };
      } else if (
        request.method === "scheduler.admit" ||
        request.method === "scheduler.block"
      ) {
        requirePermission(principal, "delegate");
        if (
          Object.keys(request.params).some(
            (key) => !["taskId", "reason", "provision"].includes(key),
          ) ||
          !safeText(request.params.taskId)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Scheduler parameters are invalid.",
          );
        const task = this.store.state.tasks[request.params.taskId];
        if (!task)
          throw new OrchestratorError("TASK_NOT_FOUND", "Task was not found.");
        if (request.method === "scheduler.block") {
          committedEvent = await this.store.append({
            type: "scheduler.blocked",
            actor: { principalId: principal.id, kind: principal.kind },
            entityRefs: { taskId: task.id },
            payload: {
              taskId: task.id,
              reason: safeText(request.params.reason, 256)
                ? request.params.reason
                : "dependency_blocked",
            },
          });
          result = {
            taskId: task.id,
            admitted: false,
            reason: request.params.reason ?? "dependency_blocked",
          };
        } else {
          committedEvent = await this.store.append({
            type: "scheduler.admitted",
            actor: { principalId: principal.id, kind: principal.kind },
            entityRefs: { taskId: task.id },
            payload: { taskId: task.id },
          });
          await this.store.append({
            type: "task.state_changed",
            actor: { principalId: principal.id, kind: principal.kind },
            entityRefs: { taskId: task.id },
            payload: { to: "provisioning" },
          });
          result = { taskId: task.id, admitted: true, state: "provisioning" };
        }
      } else if (request.method === "run.create") {
        requirePermission(principal, "delegate");
        if (
          Object.keys(request.params).some(
            (key) =>
              ![
                "taskId",
                "agentId",
                "assignmentGeneration",
                "agentGeneration",
                "piSessionId",
                "terminalId",
              ].includes(key),
          ) ||
          !safeText(request.params.taskId) ||
          !safeText(request.params.agentId) ||
          !Number.isSafeInteger(request.params.assignmentGeneration)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Run parameters are invalid.",
          );
        const task = this.store.state.tasks[request.params.taskId];
        const agent = this.store.state.agents[request.params.agentId];
        if (!task)
          throw new OrchestratorError("TASK_NOT_FOUND", "Task was not found.");
        if (!agent)
          throw new OrchestratorError(
            "AGENT_NOT_FOUND",
            "Agent was not found.",
          );
        const runId = createId("run");
        committedEvent = await this.store.append({
          type: "run.created",
          actor: { principalId: principal.id, kind: principal.kind },
          entityRefs: { runId, taskId: task.id, agentId: agent.id },
          payload: {
            runId,
            taskId: task.id,
            agentId: agent.id,
            assignmentId: createId("asg"),
            assignmentGeneration: request.params.assignmentGeneration,
            agentGeneration: agent.generation,
            ...(safeText(request.params.piSessionId)
              ? { piSessionId: request.params.piSessionId }
              : {}),
            ...(safeText(request.params.terminalId)
              ? { terminalId: request.params.terminalId }
              : {}),
          },
        });
        await this.store.append({
          type: "run.state_changed",
          actor: { principalId: principal.id, kind: principal.kind },
          entityRefs: { runId, taskId: task.id },
          payload: { runId, state: "working" },
        });
        result = {
          runId,
          taskId: task.id,
          agentId: agent.id,
          assignmentGeneration: request.params.assignmentGeneration,
          state: "working",
        };
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
          items: (
            await Promise.all(
              Object.values(this.store.state.tasks).map(async (task) =>
                (await this.#canAccessTask(principal, task.id))
                  ? task
                  : undefined,
              ),
            )
          ).filter((task): task is NonNullable<typeof task> => Boolean(task)),
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
        const task = this.store.state.tasks[request.params.taskId];
        if (task && !(await this.#canAccessTask(principal, task.id)))
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Task is outside the descendant scope.",
          );
        result = task ?? null;
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
      for (const action of deferred) void action().catch(() => undefined);
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
  async #isDescendant(
    parentAgentId: string | undefined,
    targetAgentId: string,
  ): Promise<boolean> {
    if (!parentAgentId) return false;
    let current: string | undefined = targetAgentId;
    for (let depth = 0; depth <= 4 && current; depth++) {
      if (current === parentAgentId) return true;
      current = this.store.state.agents[current]?.parentAgentId;
    }
    return false;
  }
  #operator(principal: Principal): boolean {
    return principal.kind !== "pi_parent" && principal.kind !== "pi_child";
  }
  async #canAccessAgent(
    principal: Principal,
    agentId: string,
  ): Promise<boolean> {
    return (
      this.#operator(principal) ||
      principal.agentId === agentId ||
      (await this.#isDescendant(principal.agentId, agentId))
    );
  }
  async #canAccessTask(principal: Principal, taskId: string): Promise<boolean> {
    if (this.#operator(principal)) return true;
    const task = this.store.state.tasks[taskId];
    if (!task) return false;
    if (principal.agentId === task.parentAgentId) return true;
    if (
      task.assignedAgentId &&
      (await this.#isDescendant(principal.agentId, task.assignedAgentId))
    )
      return true;
    return false;
  }
  async #sendAdapterRequest(
    agentId: string,
    method: string,
    params: Record<string, unknown>,
    expected: {
      generation: number;
      connectionGeneration?: number;
      assignmentGeneration?: number;
      piSessionId?: string;
      runId?: string;
    },
    timeoutMs = 10_000,
  ): Promise<unknown> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
      throw new OrchestratorError("TIMEOUT", "Adapter deadline is invalid.");
    const client = [...this.#clients].find(
      (item) =>
        item.principal?.kind === "pi_child" &&
        item.principal.agentId === agentId,
    );
    const agent = this.store.state.agents[agentId];
    if (
      !client ||
      !agent ||
      client.principal?.generation !== expected.generation ||
      (expected.connectionGeneration !== undefined &&
        agent.connectionGeneration !== expected.connectionGeneration) ||
      client.principal.piSessionId !==
        (expected.piSessionId ?? agent.piSessionId) ||
      agent.generation !== expected.generation
    )
      throw new OrchestratorError(
        "AGENT_DISCONNECTED",
        "The exact managed adapter is not connected.",
        { retryable: true },
      );
    if (expected.runId && agent.currentRunId !== expected.runId)
      throw new OrchestratorError(
        "RUN_MISMATCH",
        "The managed agent current run does not match.",
      );
    const id = createId("evt");
    const frame = {
      v: 1,
      type: "server_request",
      id,
      method,
      params: {
        ...params,
        expected: {
          agentId,
          generation: expected.generation,
          ...(expected.connectionGeneration !== undefined
            ? { connectionGeneration: expected.connectionGeneration }
            : {}),
          ...(expected.assignmentGeneration !== undefined
            ? { assignmentGeneration: expected.assignmentGeneration }
            : {}),
          ...(expected.piSessionId
            ? { piSessionId: expected.piSessionId }
            : {}),
          ...(expected.runId ? { runId: expected.runId } : {}),
        },
      },
    };
    const pending = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.serverRequests.delete(id);
        reject(
          new OrchestratorError(
            "TIMEOUT",
            "Managed adapter request timed out.",
            { retryable: true },
          ),
        );
      }, timeoutMs);
      timer.unref();
      client.serverRequests.set(id, { resolve, reject, timer });
    });
    client.socket.write(encodeFrame(frame));
    return await pending;
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
