import {
  createServer,
  createConnection,
  type Server,
  type Socket,
} from "node:net";
import { lstatSync, renameSync, unlinkSync } from "node:fs";
import { chmod, lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  createPrivateExclusive,
  readPrivateRegular,
} from "../shared/private-fs.js";
import { EventStore } from "../state/event-store.js";
import { createId, isEntityId } from "../shared/ids.js";
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
  createBrokerProcessRecord,
  removeBrokerProcessRecord,
  type BrokerProcessRecord,
  type BrokerProcessRecordIdentity,
} from "./process-record.js";
import {
  ensurePrivateDirectory,
  sessionKey,
  type CanonicalResolvedPaths,
  type ResolvedPaths,
} from "../shared/paths.js";
import { OrchestratorError } from "../shared/errors.js";
import { assertInvariants } from "../state/invariants.js";
import { SnapshotStore } from "../state/snapshot-store.js";
import {
  ProvisionOutcomeRecordingError,
  type HerdrService,
} from "../herdr/service.js";
import {
  validateQuestion,
  validateResult,
  payloadHash,
} from "../results/validation.js";
import type { ResultBody, QuestionBody } from "../results/types.js";
import type {
  HerdrTaskMetadata,
  HerdrMetadataState,
  QuestionRecord,
  StoredEvent,
} from "../state/types.js";
import { DeterministicScheduler } from "../scheduler/scheduler.js";
import { planAdmission } from "../scheduler/admission.js";
import {
  workflowReadiness,
  fanInWorkflow,
} from "../scheduler/workflow-engine.js";
import type { SchedulerTask } from "../scheduler/types.js";
import {
  planWorkflow,
  validateWorkflow,
  type WorkflowDefinition,
} from "../scheduler/workflows.js";
import {
  resolveIsolation,
  resolveWorkflowIsolation,
} from "./isolation-policy.js";
import {
  acceptedCompactWorkflow,
  compileCompactDelegation,
} from "./compact-delegation.js";
import {
  modelSelectionMatches,
  resolveSpawnPolicy,
  validateModelSelection,
  type AgentPlacement,
  type ModelPolicyConfig,
  type ModelProfileId,
} from "./model-policy.js";
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
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
    remediation?: string;
  };
}
function validateServerResponse(value: unknown): ServerResponse {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid server response.");
  const frame = value as Record<string, unknown>;
  if (
    frame.v !== 1 ||
    frame.type !== "server_response" ||
    !isEntityId(frame.id, "evt") ||
    typeof frame.ok !== "boolean"
  )
    throw new Error("Invalid server response.");
  if (frame.ok) {
    if (!exactKeys(frame, ["v", "type", "id", "ok", "result"]))
      throw new Error("Invalid server response.");
  } else {
    if (
      !exactKeys(frame, ["v", "type", "id", "ok", "error"]) ||
      !frame.error ||
      typeof frame.error !== "object" ||
      Array.isArray(frame.error)
    )
      throw new Error("Invalid server response.");
    const error = frame.error as Record<string, unknown>;
    if (
      !Object.keys(error).every((key) =>
        ["code", "message", "retryable", "details", "remediation"].includes(
          key,
        ),
      ) ||
      !safeText(error.code, 64) ||
      !safeText(error.message, 256) ||
      typeof error.retryable !== "boolean" ||
      (error.details !== undefined && !safeBoundedRecord(error.details)) ||
      (error.remediation !== undefined && !safeText(error.remediation, 512))
    )
      throw new Error("Invalid server response.");
  }
  return frame as unknown as ServerResponse;
}
interface PendingServerRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}
interface Client {
  socket: Socket;
  principal?: Principal;
  subscribed: boolean;
  initializing?: boolean;
  subscriptionCutoff?: number;
  subscriptionBuffer?: Map<number, import("../state/types.js").StoredEvent>;
  subscriptionId?: string;
  eventFilter?: SubscriptionFilter;
  slowClosed?: boolean;
  processing: Promise<void>;
  requestWindowStarted: number;
  requestCount: number;
  serverRequests: Map<string, PendingServerRequest>;
  adoptedRegistration: boolean;
  managedConnectionGeneration: number | undefined;
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
export function validatePiSessionReference(value: unknown): {
  source: "herdr:pi";
  agent: "pi";
  kind: "path" | "id";
  value: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OrchestratorError(
      "INVALID_REQUEST",
      "Pi session reference is invalid.",
    );
  const reference = value as Record<string, unknown>;
  const kind = reference.kind;
  const sessionValue = reference.value;
  if (
    !exactKeys(reference, ["source", "agent", "kind", "value"]) ||
    reference.source !== "herdr:pi" ||
    reference.agent !== "pi" ||
    (kind !== "path" && kind !== "id") ||
    !safeText(sessionValue, kind === "path" ? 4096 : 256) ||
    Buffer.byteLength(sessionValue, "utf8") > (kind === "path" ? 4096 : 256) ||
    (kind === "path" &&
      (!isAbsolute(sessionValue) || resolve(sessionValue) !== sessionValue))
  )
    throw new OrchestratorError(
      "INVALID_REQUEST",
      "Pi session reference is invalid.",
    );
  return {
    source: "herdr:pi",
    agent: "pi",
    kind,
    value: sessionValue,
  };
}
function exactRequestedIsolation(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "mode") ||
    !safeText((value as Record<string, unknown>).mode, 64)
  )
    throw new OrchestratorError(
      "INVALID_REQUEST",
      "Isolation must be an exact object with one mode.",
    );
  return (value as Record<string, unknown>).mode;
}
function isRegisteredHerdrResourceState(value: unknown): boolean {
  return value === "registered" || value === "present" || value === "moved";
}
function safeBoundedRecord(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as object).length <= 64 &&
    Object.entries(value as Record<string, unknown>).every(
      ([key, item]) =>
        safeText(key, 128) &&
        (item === null ||
          typeof item === "boolean" ||
          (typeof item === "number" && Number.isFinite(item)) ||
          (typeof item === "string" && safeText(item, 1024))),
    )
  );
}
function safePiState(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const model = state.model;
  const scalarState = { ...state };
  delete scalarState.model;
  return (
    safeBoundedRecord(scalarState) &&
    (model === undefined ||
      (!!model &&
        typeof model === "object" &&
        !Array.isArray(model) &&
        exactKeys(model as Record<string, unknown>, ["provider", "modelId"]) &&
        safeText((model as Record<string, unknown>).provider, 128) &&
        safeText((model as Record<string, unknown>).modelId, 256)))
  );
}
function isTerminal(value: unknown): boolean {
  return ["succeeded", "failed", "cancelled", "timed_out", "lost"].includes(
    String(value),
  );
}
function isRunClosedForAdapterProgress(value: unknown): boolean {
  return isTerminal(value) || value === "settled";
}
function isAbortFallbackError(error: unknown): boolean {
  if (!(error instanceof OrchestratorError)) return false;
  return new Set([
    "AGENT_DISCONNECTED",
    "AGENT_REPLACED",
    "PI_COMMAND_REJECTED",
    "TIMEOUT",
    "RUN_MISMATCH",
  ]).has(error.code);
}
const DEFAULT_TASK_WALL_MS = 15 * 60_000;
const MAX_TASK_WALL_MS = 24 * 60 * 60_000;
const ADAPTER_ABORT_TIMEOUT_MS = 10_000;
const WALL_TIMEOUT_REASON = {
  code: "TIMEOUT" as const,
  message: "The task wall deadline expired.",
};

function boundedTaskTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_TASK_WALL_MS;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > MAX_TASK_WALL_MS
  )
    throw new OrchestratorError(
      "INVALID_REQUEST",
      "Task wall deadline is outside the bounded range.",
    );
  return Number(value);
}
function taskDeadline(now: number, value: unknown): string {
  return new Date(now + boundedTaskTimeoutMs(value)).toISOString();
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
function sameSocketIdentity(
  stat: { dev: number; ino: number; uid: number },
  expected: SocketIdentity,
): boolean {
  return (
    stat.dev === expected.dev &&
    stat.ino === expected.ino &&
    stat.uid === expected.uid
  );
}
function exactSocketSync(path: string, expected: SocketIdentity): void {
  const stat = lstatSync(path);
  if (
    !stat.isSocket() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.() ||
    !sameSocketIdentity(stat, expected)
  )
    throw new Error("Broker socket identity changed during quarantine.");
}
function absentSocketPathSync(path: string): void {
  try {
    lstatSync(path);
    throw new Error(`Replacement socket was preserved at ${path}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
function restoreSocketSync(
  original: string,
  quarantine: string,
  expected: SocketIdentity,
): void {
  try {
    exactSocketSync(quarantine, expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  absentSocketPathSync(original);
  renameSync(quarantine, original);
  exactSocketSync(original, expected);
}
export function finalizeStaleSocketRemovalSync(
  original: string,
  quarantine: string,
  expected: SocketIdentity,
): void {
  exactSocketSync(quarantine, expected);
  absentSocketPathSync(original);
  unlinkSync(quarantine);
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
    observed.uid !== process.getuid?.() ||
    (observed.mode & 0o077) !== 0
  )
    throw new Error("Broker socket ownership or mode is unsafe.");
  const identity = { dev: observed.dev, ino: observed.ino, uid: observed.uid };
  if (expected && !sameSocketIdentity(identity, expected))
    throw new Error("Broker socket identity changed before quarantine.");
  if (await listening(path)) throw new Error("Broker socket is already live.");

  const quarantine = socketQuarantine(path, "stale");
  exactSocketSync(path, identity);
  renameSync(path, quarantine);
  const failures: unknown[] = [];
  try {
    const quarantined = await lstat(quarantine);
    if (!sameSocketIdentity(quarantined, identity))
      throw new Error("Broker socket identity changed during quarantine.");
    if (await listening(quarantine))
      throw new Error("Broker socket became live during quarantine.");
    finalizeStaleSocketRemovalSync(path, quarantine, identity);
    return;
  } catch (error) {
    failures.push(error);
  }
  try {
    restoreSocketSync(path, quarantine, identity);
  } catch (error) {
    failures.push(error);
  }
  throw failures.length === 1
    ? failures[0]
    : new AggregateError(
        failures,
        "Broker socket identity cleanup and restoration failed.",
      );
}
interface CloseQuarantine {
  path: string;
  owned: boolean;
  identity: SocketIdentity;
}
function exactPathIdentitySync(path: string, expected: SocketIdentity): void {
  const stat = lstatSync(path);
  if (!sameSocketIdentity(stat, expected))
    throw new Error("Replacement socket path identity changed.");
}
async function quarantineForClose(
  path: string,
  expected: SocketIdentity,
): Promise<CloseQuarantine | undefined> {
  const quarantine = socketQuarantine(path, "close");
  let current;
  try {
    current = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const identity = { dev: current.dev, ino: current.ino, uid: current.uid };
  const owned =
    current.isSocket() &&
    current.nlink === 1 &&
    (current.mode & 0o077) === 0 &&
    current.uid === process.getuid?.() &&
    sameSocketIdentity(identity, expected);
  renameSync(path, quarantine);
  exactPathIdentitySync(quarantine, identity);
  absentSocketPathSync(path);
  return { path: quarantine, owned, identity };
}
function restoreReplacement(
  original: string,
  quarantine: string,
  expected: SocketIdentity,
): void {
  exactPathIdentitySync(quarantine, expected);
  absentSocketPathSync(original);
  renameSync(quarantine, original);
  exactPathIdentitySync(original, expected);
}
export function sessionKeyMatches(
  expectedSessionKey: string,
  received: string,
): boolean {
  return expectedSessionKey === received;
}
export interface BrokerOptions {
  herdr?: HerdrService;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
  herdrFactory?: (
    store: EventStore,
    paths: CanonicalResolvedPaths,
  ) => Promise<HerdrService>;
  modelPolicy?: ModelPolicyConfig;
  compactDelegationEnabled?: boolean;
}
export class Broker {
  readonly store: EventStore;
  readonly snapshotStore: SnapshotStore;
  readonly paths: CanonicalResolvedPaths;
  #server: Server | undefined;
  #socketIdentity: SocketIdentity | undefined;
  #mutationTail: Promise<void> = Promise.resolve();
  #deferredWork = new Set<Promise<void>>();
  #stopPromise: Promise<void> | undefined;
  #stopping = false;
  #startAttempted = false;
  #backgroundFailure: unknown;
  #advanceTail: Promise<void> = Promise.resolve();
  #lock: BrokerLock;
  #processRecord:
    | { record: BrokerProcessRecord; identity: BrokerProcessRecordIdentity }
    | undefined;
  #secret: string;
  #clients = new Set<Client>();
  #questionTimers = new Map<string, NodeJS.Timeout>();
  #deadlineTimers = new Map<string, NodeJS.Timeout>();
  #coordinationSignals = new Map<string, number>();
  #now: () => number;
  #setTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  #clearTimeout: (timer: NodeJS.Timeout) => void;
  #herdr?: HerdrService;
  readonly #modelPolicy: ModelPolicyConfig;
  readonly #compactDelegationEnabled: boolean;
  readonly #herdrFactory:
    | ((
        store: EventStore,
        paths: CanonicalResolvedPaths,
      ) => Promise<HerdrService>)
    | undefined;
  constructor(paths: ResolvedPaths, options: BrokerOptions = {}) {
    this.paths = {
      ...paths,
      startup: paths.startup ?? `${paths.lock}.startup`,
      pid: paths.pid ?? `${paths.lock}.pid`,
      log: paths.log ?? `${paths.socket}.log`,
      herdrSocket: paths.herdrSocket ?? paths.socket,
      sessionKey: paths.sessionKey ?? sessionKey(paths.socket),
    };
    this.#lock = new BrokerLock(this.paths.lock, this.paths.socket);
    this.#secret = "";
    this.#now = options.now ?? Date.now;
    this.#setTimeout =
      options.setTimeout ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimeout = options.clearTimeout ?? clearTimeout;
    this.#modelPolicy = options.modelPolicy ?? {};
    this.#compactDelegationEnabled =
      options.compactDelegationEnabled ??
      process.env.PI_HERDR_COMPACT_DELEGATION !== "0";
    this.store = new EventStore(this.paths.events);
    this.store.onAppend((event) => {
      if (
        event.entityRefs?.taskId &&
        (event.type === "task.cancel_requested" ||
          (event.type === "task.state_changed" &&
            isTerminal(
              (event.payload as Record<string, unknown> | undefined)?.to,
            )))
      )
        this.#clearTaskDeadline(event.entityRefs.taskId);
      if (
        event.type === "run.state_changed" &&
        event.entityRefs?.runId &&
        isTerminal(
          (event.payload as Record<string, unknown> | undefined)?.state,
        )
      ) {
        const run = this.store.state.runs[event.entityRefs.runId];
        if (run) this.#clearTaskDeadline(run.taskId);
      }
      for (const subscriber of this.#clients) {
        if (
          (subscriber.subscribed || subscriber.initializing) &&
          this.#eventVisible(subscriber.principal!, event) &&
          this.#matchesFilter(subscriber.eventFilter, event)
        ) {
          if (
            subscriber.initializing &&
            event.seq > (subscriber.subscriptionCutoff ?? 0)
          ) {
            const buffer = subscriber.subscriptionBuffer ?? new Map();
            buffer.set(event.seq, event);
            subscriber.subscriptionBuffer = buffer;
            if (
              buffer.size > 256 ||
              [...buffer.values()].reduce(
                (total, item) =>
                  total + Buffer.byteLength(JSON.stringify(item)),
                0,
              ) > 1_048_576
            ) {
              subscriber.slowClosed = true;
              subscriber.socket.destroy();
            }
          } else if (subscriber.subscribed) this.#sendEvent(subscriber, event);
        }
      }
      if (event.type !== "herdr.metadata_projected")
        this.#trackDeferred(() =>
          this.#enqueueMutation(() => this.#projectCompactMetadata(event)),
        );
    });
    this.snapshotStore = new SnapshotStore(this.paths.snapshot);
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
    if (this.#stopping || this.#stopPromise || this.#startAttempted)
      throw new OrchestratorError(
        "INVALID_REQUEST",
        "A Broker instance can start only once before shutdown.",
      );
    this.#startAttempted = true;
    try {
      await ensurePrivateDirectory(this.paths.root);
      await ensurePrivateDirectory(this.paths.runtime);
      await this.#lock.acquire();
      this.#processRecord = await createBrokerProcessRecord(
        this.paths.pid,
        this.paths.sessionKey,
        this.paths.socket,
      );
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
      // Recover absolute deadlines in timestamp order. Tasks win equal
      // timestamps, then stable task or question IDs provide the tie rule.
      const expired: Array<{
        at: number;
        kind: "question" | "task";
        id: string;
      }> = [];
      for (const task of Object.values(this.store.state.tasks)) {
        if (isTerminal(task.state) || !task.timeoutAt) continue;
        const at = Date.parse(task.timeoutAt);
        if (Number.isFinite(at) && at <= this.#now())
          expired.push({ at, kind: "task", id: task.id });
      }
      for (const question of Object.values(this.store.state.questions ?? {})) {
        if (question.state !== "open") continue;
        const payload = question.payload as { timeoutMs?: unknown } | undefined;
        const timeoutMs =
          typeof payload?.timeoutMs === "number" &&
          Number.isSafeInteger(payload.timeoutMs)
            ? payload.timeoutMs
            : 300_000;
        const askedAt = question.askedAt ? Date.parse(question.askedAt) : NaN;
        if (Number.isFinite(askedAt) && askedAt + timeoutMs <= this.#now())
          expired.push({
            at: askedAt + timeoutMs,
            kind: "question",
            id: question.id,
          });
      }
      expired.sort(
        (left, right) =>
          left.at - right.at ||
          (left.kind === right.kind
            ? left.id.localeCompare(right.id)
            : left.kind === "task"
              ? -1
              : 1),
      );
      for (const item of expired)
        if (item.kind === "question")
          await this.#terminalizeQuestionTimeout(item.id);
        else await this.#terminalizeTaskDeadline(item.id);
      for (const task of Object.values(this.store.state.tasks))
        if (!isTerminal(task.state)) this.#scheduleTaskDeadline(task);
      for (const question of Object.values(this.store.state.questions ?? {}))
        if (question.state === "open") this.#scheduleQuestionTimeout(question);
      for (const workflow of Object.values(this.store.state.workflows))
        if (
          !["succeeded", "failed", "blocked", "cancelled"].includes(
            workflow.state,
          )
        )
          await this.#advanceWorkflow(workflow.id, {
            principalId: "prn_00000000000000000000000000",
            kind: "system",
          });
      for (const metadata of Object.values(
        this.store.state.herdrMetadata ?? {},
      ))
        if (metadata.state === "settled" && !metadata.exitedAt)
          await this.#projectCompactMetadata(
            {
              entityRefs: { taskId: metadata.taskId },
            } as unknown as StoredEvent,
            true,
          ).catch(() => undefined);
      for (const metadata of Object.values(
        this.store.state.herdrMetadata ?? {},
      ))
        if (metadata.state === "cleanup_pending" && this.#herdr) {
          const task = this.store.state.tasks[metadata.taskId];
          const workflowDigest = String(
            (task?.project?.compact as { workflowDigest?: unknown } | undefined)
              ?.workflowDigest ?? "",
          );
          if (!/^[a-f0-9]{64}$/u.test(workflowDigest)) continue;
          try {
            await this.#herdr.closeRetainedTab({
              workspaceId: metadata.workspaceId,
              tabId: metadata.tabId,
              paneId: metadata.paneId,
              terminalId: metadata.terminalId,
            });
            const closed = {
              ...metadata,
              state: "closed" as const,
              updatedAt: new Date(this.#now()).toISOString(),
            };
            delete (closed as Partial<HerdrTaskMetadata>).metadataDigest;
            await this.store.append({
              type: "herdr.metadata_projected",
              actor: {
                principalId: "prn_00000000000000000000000000",
                kind: "system",
              },
              entityRefs: {
                workflowId: metadata.workflowId,
                taskId: metadata.taskId,
                runId: metadata.runId,
                agentId: metadata.agentId,
                workflowDigest,
              },
              payload: {
                ...closed,
                metadataDigest: sha256(canonicalJson(closed)),
              },
            });
          } catch {
            // Keep the durable intent. A later recovery can retry exact proof.
          }
        }
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
      const cleanupFailures: unknown[] = [];
      if (this.#server)
        try {
          await this.stop();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      else {
        if (this.#processRecord)
          try {
            await removeBrokerProcessRecord(
              this.paths.pid,
              this.#processRecord,
            );
            this.#processRecord = undefined;
          } catch (cleanupError) {
            cleanupFailures.push(cleanupError);
          }
        try {
          await this.#lock.release();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (cleanupFailures.length)
        throw new AggregateError(
          [error, ...cleanupFailures],
          "Broker start and cleanup failed.",
        );
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
  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    const attempt = this.#stopUnlocked();
    this.#stopPromise = attempt;
    void attempt.then(
      () => undefined,
      () => {
        if (
          this.#stopPromise === attempt &&
          (this.#processRecord !== undefined ||
            this.#lock.identity !== undefined)
        )
          this.#stopPromise = undefined;
      },
    );
    return attempt;
  }
  async #stopUnlocked(): Promise<void> {
    const failures: unknown[] = [];
    let backgroundRecorded = false;
    const recordBackgroundFailure = (): void => {
      if (!backgroundRecorded && this.#backgroundFailure !== undefined) {
        failures.push(this.#backgroundFailure);
        backgroundRecorded = true;
      }
    };
    let quarantined: CloseQuarantine | undefined;
    const identity = this.#socketIdentity;
    try {
      for (const client of this.#clients) {
        for (const pending of client.serverRequests.values())
          this.#clearTimeout(pending.timer);
        client.socket.destroy();
      }
      for (const timer of this.#questionTimers.values())
        this.#clearTimeout(timer);
      this.#questionTimers.clear();
      for (const timer of this.#deadlineTimers.values())
        this.#clearTimeout(timer);
      this.#deadlineTimers.clear();
      if (typeof this.#herdr?.shutdown === "function") this.#herdr.shutdown();
      await this.#drainAdmittedWork();
      recordBackgroundFailure();
      if (this.#server && identity)
        quarantined = await quarantineForClose(this.paths.socket, identity);
      await new Promise<void>(
        (resolve) => this.#server?.close(() => resolve()) ?? resolve(),
      );
      this.#server = undefined;
      if (quarantined?.owned) await safeStaleSocket(quarantined.path, identity);
      else if (quarantined) {
        const replacement = quarantined.path;
        restoreReplacement(
          this.paths.socket,
          replacement,
          quarantined.identity,
        );
        quarantined = undefined;
        throw new Error("Broker socket identity changed before shutdown.");
      }
    } catch (error) {
      failures.push(error);
      if (this.#server)
        try {
          await new Promise<void>((resolve, reject) =>
            this.#server!.close((closeError) =>
              closeError ? reject(closeError) : resolve(),
            ),
          );
        } catch (closeError) {
          failures.push(closeError);
        }
      this.#server = undefined;
      if (quarantined && !quarantined.owned)
        try {
          restoreReplacement(
            this.paths.socket,
            quarantined.path,
            quarantined.identity,
          );
        } catch (restoreError) {
          failures.push(restoreError);
        }
    } finally {
      for (const timer of this.#questionTimers.values())
        this.#clearTimeout(timer);
      this.#questionTimers.clear();
      for (const timer of this.#deadlineTimers.values())
        this.#clearTimeout(timer);
      this.#deadlineTimers.clear();
      if (this.#processRecord)
        try {
          await removeBrokerProcessRecord(this.paths.pid, this.#processRecord);
          this.#processRecord = undefined;
        } catch (error) {
          failures.push(error);
        }
      try {
        await this.#lock.release();
      } catch (error) {
        failures.push(error);
      }
      this.#socketIdentity = undefined;
    }
    recordBackgroundFailure();
    const retained = failures.filter(
      (failure) => (failure as NodeJS.ErrnoException).code !== "ENOENT",
    );
    if (retained.length === 1) throw retained[0];
    if (retained.length > 1)
      throw new AggregateError(retained, "Broker shutdown and cleanup failed.");
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
      managedConnectionGeneration: undefined,
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
      if (type === "server_response") return validateServerResponse(value);
      return validateRequest(value);
    });
    socket.on("error", () => {
      socket.destroy();
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
          if (!pending) {
            this.#failConnection(client, "unknown_or_late_server_response");
            return;
          }
          client.serverRequests.delete(item.value.id);
          this.#clearTimeout(pending.timer);
          if (item.value.ok) {
            if (
              pending.method === "assignment.deliver" &&
              (!item.value.result ||
                typeof item.value.result !== "object" ||
                Array.isArray(item.value.result) ||
                Object.keys(item.value.result as object).length !== 1 ||
                !["accepted", "rejected", "already_accepted"].includes(
                  String((item.value.result as Record<string, unknown>).status),
                ))
            ) {
              pending.reject(
                new OrchestratorError(
                  "PI_COMMAND_REJECTED",
                  "Adapter response shape was invalid.",
                ),
              );
            } else pending.resolve(item.value.result);
          } else
            pending.reject(
              new OrchestratorError(
                "PI_COMMAND_REJECTED",
                "The managed adapter rejected the request.",
              ),
            );
        } else queued.push(item);
      }
      client.processing = client.processing
        .then(async () => {
          for (const item of queued) {
            if (!item.ok) {
              this.#failConnection(client, "malformed_client_frame");
              return;
            }
            if (!client.principal) {
              if (item.value.type !== "hello") {
                socket.destroy();
                return;
              }
              try {
                if (
                  !sessionKeyMatches(
                    this.paths.sessionKey,
                    item.value.sessionKey,
                  )
                )
                  throw new OrchestratorError(
                    "AUTH_FAILED",
                    "Session key does not match the orchestration session.",
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
                if (
                  client.principal.kind === "pi_child" &&
                  [...this.#clients].some(
                    (candidate) =>
                      candidate !== client &&
                      !candidate.socket.destroyed &&
                      candidate.principal?.kind === "pi_child" &&
                      candidate.principal.agentId ===
                        client.principal?.agentId &&
                      candidate.principal.generation ===
                        client.principal?.generation &&
                      candidate.principal.piSessionId ===
                        client.principal?.piSessionId,
                  )
                )
                  throw new OrchestratorError(
                    "AUTH_FAILED",
                    "The exact managed adapter is already connected.",
                  );
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
                ).catch((auditError: unknown) =>
                  this.#observeBackgroundFailure(auditError),
                );
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
        this.#clearTimeout(pending.timer);
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
  async #enqueueMutation<T>(action: () => Promise<T>): Promise<T> {
    if (this.#stopping)
      throw new OrchestratorError(
        "BROKER_READ_ONLY",
        "The broker is stopping.",
      );
    const previous = this.#mutationTail;
    let release!: () => void;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
  #observeBackgroundFailure(error: unknown): void {
    if (
      this.#stopping &&
      error instanceof OrchestratorError &&
      error.code === "BROKER_READ_ONLY"
    )
      return;
    if (this.#backgroundFailure === undefined) this.#backgroundFailure = error;
  }
  #trackDeferred(action: () => Promise<void>): void {
    const work = new Promise<void>((resolve) => {
      void Promise.resolve()
        .then(action)
        .then(
          () => resolve(),
          (error: unknown) => {
            this.#observeBackgroundFailure(error);
            resolve();
          },
        );
    });
    this.#deferredWork.add(work);
    void work.then(() => this.#deferredWork.delete(work));
  }
  async #drainAdmittedWork(): Promise<void> {
    while (true) {
      const mutation = this.#mutationTail;
      await mutation;
      const deferred = [...this.#deferredWork];
      if (deferred.length) await Promise.all(deferred);
      if (mutation === this.#mutationTail && this.#deferredWork.size === 0)
        return;
    }
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
    await this.#enqueueMutation(() => this.#requestUnlocked(client, request));
  }
  async #requestUnlocked(client: Client, request: RequestFrame): Promise<void> {
    const principal = client.principal!;
    const responseMethod = request.method;
    try {
      let result: unknown;
      let compactPreview: unknown;
      let compactReplayResponse: unknown;
      let compactIdempotency: { key: string; paramsHash: string } | undefined;
      if (request.method === "compact.delegate") {
        requirePermission(principal, "delegate");
        if (!this.#compactDelegationEnabled)
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Compact delegation is disabled.",
          );
        const p = request.params;
        const allowed = [
          "text",
          "accept",
          "workflowDigest",
          "parentAgentId",
          "wait",
          "waitUntil",
          "timeoutMs",
          "failureMode",
        ];
        if (
          !exactKeys(p, allowed) ||
          typeof p.text !== "string" ||
          (p.accept !== undefined && typeof p.accept !== "boolean") ||
          (p.workflowDigest !== undefined && !safeText(p.workflowDigest, 128))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Compact delegation parameters are invalid.",
          );
        const compiled = compileCompactDelegation(
          p.text,
          (profileId, requestedIsolation) => {
            try {
              const isolation = resolveIsolation(profileId, requestedIsolation);
              const spawnPolicy = resolveSpawnPolicy(
                { taskProfileId: profileId },
                this.#modelPolicy,
              );
              const effective = spawnPolicy.effective;
              return {
                profileId,
                policy: {
                  decision: "allow",
                  placement: effective.placement,
                  isolation,
                  modelProfileId: effective.modelProfileId,
                  providerQualifiedModel: `${effective.model.provider}/${effective.model.modelId}`,
                  thinkingLevel: effective.model.thinkingLevel,
                  modelPolicyHash: spawnPolicy.policyHash,
                },
              };
            } catch {
              return undefined;
            }
          },
        );
        if (p.accept !== true) {
          compactPreview = {
            schemaVersion: compiled.schemaVersion,
            workflowDigest: compiled.workflowDigest,
            stepCount: compiled.stepCount,
            steps: compiled.steps,
          };
        } else {
          if (!request.idempotencyKey)
            throw new OrchestratorError(
              "INVALID_REQUEST",
              "Accepted compact delegation requires an idempotency key.",
            );
          const workflow = acceptedCompactWorkflow(
            compiled,
            typeof p.workflowDigest === "string" ? p.workflowDigest : undefined,
          );
          const paramsHash = sha256(
            canonicalJson({
              method: "compact.delegate",
              params: p,
              canonicalWorkflow: workflow,
            }),
          );
          const prior = this.store.state.idempotency[request.idempotencyKey];
          if (prior) {
            if (
              prior.principalId !== principal.id ||
              prior.method !== "compact.delegate" ||
              prior.paramsHash !== paramsHash
            )
              throw new OrchestratorError(
                "IDEMPOTENCY_CONFLICT",
                "Idempotency key is already bound.",
              );
            compactReplayResponse = prior.response;
          } else
            compactIdempotency = {
              key: request.idempotencyKey,
              paramsHash,
            };
          request = {
            ...request,
            method:
              compactReplayResponse === undefined
                ? "delegate.execute"
                : "compact.idempotency_replay",
            params: {
              ...workflow,
              ...(p.parentAgentId !== undefined
                ? { parentAgentId: p.parentAgentId }
                : {}),
              ...(p.wait !== undefined ? { wait: p.wait } : {}),
              ...(p.waitUntil !== undefined ? { waitUntil: p.waitUntil } : {}),
              ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
              compact: {
                workflowDigest: compiled.workflowDigest,
                transcriptPolicy: "retain-tab",
              },
            },
          };
        }
      }
      let replayEvents: import("../state/types.js").StoredEvent[] = [];
      let committedEvent: import("../state/types.js").StoredEvent | undefined;
      let responseBoundary: (() => Promise<void>) | undefined;
      const deferred: Array<() => Promise<void>> = [];
      let shutdownAfterResponse = false;
      if (compactPreview !== undefined) {
        result = compactPreview;
      } else if (compactReplayResponse !== undefined) {
        const replayWorkflowId =
          compactReplayResponse &&
          typeof compactReplayResponse === "object" &&
          safeText(
            (compactReplayResponse as Record<string, unknown>).workflowId,
          )
            ? ((compactReplayResponse as Record<string, unknown>)
                .workflowId as string)
            : undefined;
        if (replayWorkflowId && this.store.state.workflows[replayWorkflowId]) {
          for (const taskId of this.store.state.workflows[replayWorkflowId]!
            .taskIds)
            this.#scheduleTaskDeadline(this.store.state.tasks[taskId]!);
          await this.#advanceWorkflow(replayWorkflowId, {
            principalId: principal.id,
            kind: principal.kind,
          });
        }
        result = compactReplayResponse;
      } else if (
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
      } else if (request.method === "system.doctor") {
        if (
          !exactKeys(request.params, []) ||
          Object.keys(request.params).length ||
          !this.#herdr
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "System doctor parameters are invalid.",
          );
        if (principal.kind !== "cli" && principal.kind !== "human")
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Only an authenticated local operator can run doctor.",
          );
        result = await this.#herdr.diagnose();
      } else if (request.method === "system.shutdown") {
        if (
          !exactKeys(request.params, []) ||
          Object.keys(request.params).length
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "System shutdown parameters must be empty.",
          );
        if (principal.kind !== "cli" && principal.kind !== "human")
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Only an authenticated local operator can stop the broker.",
          );
        result = { stopping: true };
        shutdownAfterResponse = true;
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
        client.initializing = true;
        client.subscriptionCutoff = currentSeq;
        client.subscriptionBuffer = new Map();
        replayEvents = (await this.store.readEventsFrom(replayStart)).filter(
          (event) =>
            this.#eventVisible(principal, event) &&
            this.#matchesFilter(filter, event),
        );
        client.subscribed = false;
        client.subscriptionId = subscriptionId();
        client.eventFilter = filter;
        result = {
          subscriptionId: client.subscriptionId,
          ...(includeSnapshot
            ? {
                snapshot: {
                  seq: currentSeq,
                  agents: Object.values(this.store.state.agents).filter(
                    (item) => this.#canAccessAgentSync(principal, item.id),
                  ),
                  tasks: Object.values(this.store.state.tasks).filter((item) =>
                    this.#canAccessTaskSync(principal, item.id),
                  ),
                  runs: Object.values(this.store.state.runs).filter(
                    (item) =>
                      this.#canAccessTaskSync(principal, item.taskId) &&
                      (!item.agentId ||
                        this.#canAccessAgentSync(principal, item.agentId)),
                  ),
                  workflows: Object.values(this.store.state.workflows).filter(
                    (item) =>
                      item.taskIds.some((taskId) =>
                        this.#canAccessTaskSync(principal, taskId),
                      ),
                  ),
                  groups: Object.values(this.store.state.groups ?? {}).filter(
                    (item) =>
                      item.agentIds.some((agentId) =>
                        this.#canAccessAgentSync(principal, agentId),
                      ),
                  ),
                  questions: Object.values(
                    this.store.state.questions ?? {},
                  ).filter((item) =>
                    this.#canAccessAgentSync(principal, item.agentId),
                  ),
                  results: Object.values(this.store.state.results ?? {}).filter(
                    (item) => this.#canAccessTaskSync(principal, item.taskId),
                  ),
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
        const registrationKeys =
          request.method === "agent.register_adopted"
            ? ["adapterVersion", "herdr", "pi"]
            : ["agentId", "generation", "adapterVersion", "herdr", "pi"];
        if (
          !exactKeys(p, registrationKeys) ||
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
        if (
          !Object.keys(herdr).every((key) =>
            [
              "paneId",
              "terminalId",
              "detectedKind",
              "name",
              "sessionReference",
            ].includes(key),
          ) ||
          !Object.keys(pi).every((key) =>
            ["sessionId", "sessionName", "capabilities", "state"].includes(key),
          ) ||
          !safeText(herdr.detectedKind, 32) ||
          herdr.detectedKind !== "pi" ||
          (herdr.name !== undefined && !safeText(herdr.name, 256)) ||
          !safeBoundedRecord(pi.capabilities) ||
          !safePiState(pi.state) ||
          (pi.sessionName !== undefined && !safeText(pi.sessionName, 256))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Pi registration fields are invalid.",
          );
        const sessionReference = validatePiSessionReference(
          herdr.sessionReference,
        );
        if (
          request.method === "agent.register_managed" &&
          (!isEntityId(p.agentId, "agt") ||
            !Number.isSafeInteger(p.generation) ||
            Number(p.generation) < 1)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Managed registration identity is invalid.",
          );
        let registrationConnectionGeneration: number | undefined;
        let agentId: string = (
          request.method === "agent.register_managed"
            ? (principal.agentId ?? p.agentId)
            : createId("agt")
        ) as string;
        if (
          !safeText(agentId) ||
          !safeText(herdr.paneId) ||
          (herdr.terminalId !== undefined && !safeText(herdr.terminalId)) ||
          !safeText(pi.sessionId)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Pi identity is invalid.",
          );
        let adoptedContext:
          | {
              paneId: string;
              terminalId: string;
              workspaceId?: string;
              tabId?: string;
              cwd?: string;
              worktreeId?: string;
            }
          | undefined;
        if (request.method === "agent.register_adopted") {
          if (!this.#herdr || typeof this.#herdr.verifyRoot !== "function")
            throw new OrchestratorError(
              "HERDR_UNAVAILABLE",
              "Adopted registration requires Herdr verification.",
            );
          try {
            adoptedContext = await this.#herdr.verifyRoot({
              paneId: herdr.paneId as string,
              ...(safeText(herdr.terminalId)
                ? { terminalId: herdr.terminalId }
                : {}),
              sessionReference,
            });
            herdr.terminalId = adoptedContext.terminalId;
          } catch {
            throw new OrchestratorError(
              "AGENT_REPLACED",
              "Herdr occupant verification failed.",
            );
          }
        }
        let existing = this.store.state.agents[agentId];
        if (request.method === "agent.register_adopted") {
          const roots = Object.values(this.store.state.agents).filter(
            (candidate) =>
              !candidate.managed &&
              candidate.paneId === herdr.paneId &&
              candidate.terminalId === herdr.terminalId,
          );
          if (roots.length > 1)
            throw new OrchestratorError(
              "AGENT_REPLACED",
              "Adopted root claim is ambiguous.",
            );
          existing = roots[0];
          if (existing && existing.piSessionId !== pi.sessionId)
            throw new OrchestratorError(
              "AGENT_REPLACED",
              "Pi session does not match the adopted root.",
            );
          if (
            existing &&
            [...this.#clients].some(
              (item) =>
                item !== client &&
                item.adoptedRegistration &&
                item.principal?.agentId === existing!.id,
            )
          )
            throw new OrchestratorError(
              "AGENT_REPLACED",
              "The adopted root is already active.",
            );
          if (existing) agentId = existing.id;
        }
        let actualModel:
          | { provider: string; modelId: string; thinkingLevel: string }
          | undefined;
        if (request.method === "agent.register_managed") {
          const piState = pi.state as Record<string, unknown>;
          const reportedModel = piState.model;
          const expected = existing?.effectiveModel;
          const hasAttestation =
            !!reportedModel &&
            typeof reportedModel === "object" &&
            !Array.isArray(reportedModel) &&
            safeText(
              (reportedModel as Record<string, unknown>).provider,
              128,
            ) &&
            safeText((reportedModel as Record<string, unknown>).modelId, 256) &&
            safeText(piState.thinkingLevel, 32);
          if (!hasAttestation && expected) {
            if (this.#herdr)
              await this.#herdr.recordRegistrationMismatch(agentId);
            await this.store.append({
              type: "agent.state_changed",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { agentId },
              payload: {
                agentId,
                state: "replaced",
                reason: "PI_MODEL_ATTESTATION_MISSING",
              },
            });
            throw new OrchestratorError(
              "AGENT_REPLACED",
              "Managed Pi registration lacks model attestation.",
            );
          }
          if (hasAttestation) {
            actualModel = {
              provider: (reportedModel as Record<string, unknown>)
                .provider as string,
              modelId: (reportedModel as Record<string, unknown>)
                .modelId as string,
              thinkingLevel: piState.thinkingLevel as string,
            };
          }
          if (
            expected &&
            actualModel &&
            !modelSelectionMatches(
              {
                provider: String(expected.provider ?? ""),
                modelId: String(expected.modelId ?? ""),
                thinkingLevel: expected.thinkingLevel as never,
              },
              actualModel,
            )
          ) {
            if (this.#herdr)
              await this.#herdr.recordRegistrationMismatch(agentId);
            await this.store.append({
              type: "agent.state_changed",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { agentId },
              payload: {
                agentId,
                state: "replaced",
                actualModel,
                reason: "PI_MODEL_ATTESTATION_MISMATCH",
              },
            });
            throw new OrchestratorError(
              "AGENT_REPLACED",
              "Managed Pi model attestation does not match policy.",
            );
          }
        }
        if (
          existing &&
          existing.piSessionId !== undefined &&
          existing.piSessionId !== pi.sessionId
        )
          throw new OrchestratorError(
            "AGENT_REPLACED",
            "Pi session does not match the current agent generation.",
          );
        const adoptedReconnect =
          request.method === "agent.register_adopted" && Boolean(existing);
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
              ...(adoptedContext?.workspaceId
                ? { workspaceId: adoptedContext.workspaceId }
                : {}),
              ...(adoptedContext?.tabId ? { tabId: adoptedContext.tabId } : {}),
              ...(adoptedContext?.cwd ? { cwd: adoptedContext.cwd } : {}),
              ...(adoptedContext?.worktreeId
                ? { worktreeId: adoptedContext.worktreeId }
                : {}),
              ...(safeText(p.profileId) ? { profileId: p.profileId } : {}),
              ...(safeText(p.parentAgentId)
                ? { parentAgentId: p.parentAgentId }
                : {}),
            },
          });
          committedEvent = event;
        }
        if (request.method === "agent.register_adopted") {
          try {
            const finalContext = await this.#herdr!.verifyRoot({
              paneId: herdr.paneId as string,
              terminalId: adoptedContext!.terminalId,
              sessionReference,
            });
            if (
              finalContext.paneId !== adoptedContext!.paneId ||
              finalContext.terminalId !== adoptedContext!.terminalId ||
              finalContext.workspaceId !== adoptedContext!.workspaceId ||
              finalContext.tabId !== adoptedContext!.tabId ||
              finalContext.cwd !== adoptedContext!.cwd ||
              finalContext.worktreeId !== adoptedContext!.worktreeId
            )
              throw new Error("HERDR_IDENTITY_MISMATCH");
            adoptedContext = finalContext;
          } catch {
            await this.store
              .append({
                type: "agent.state_changed",
                actor: { principalId: principal.id, kind: principal.kind },
                entityRefs: { agentId },
                payload: {
                  agentId,
                  state: "replaced",
                  reason: "HERDR_IDENTITY_MISMATCH",
                },
              })
              .catch((error: unknown) => {
                this.#observeBackgroundFailure(error);
              });
            throw new OrchestratorError(
              "AGENT_REPLACED",
              "Herdr occupant changed during adoption.",
            );
          }
          if (adoptedReconnect) {
            const current = this.store.state.agents[agentId]!;
            await this.store.append({
              type: "agent.state_changed",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { agentId },
              payload: {
                agentId,
                state: "idle",
                paneId: herdr.paneId,
                terminalId: herdr.terminalId,
                piSessionId: pi.sessionId,
                ...(adoptedContext?.workspaceId
                  ? { workspaceId: adoptedContext.workspaceId }
                  : {}),
                ...(adoptedContext?.tabId
                  ? { tabId: adoptedContext.tabId }
                  : {}),
                ...(adoptedContext?.cwd ? { cwd: adoptedContext.cwd } : {}),
                ...(adoptedContext?.worktreeId
                  ? { worktreeId: adoptedContext.worktreeId }
                  : {}),
                connectionGeneration: (current.connectionGeneration ?? 0) + 1,
                lastAdapterSeq: 0,
              },
            });
          }
          responseBoundary = async () => {
            try {
              const boundary = await this.#herdr!.verifyRoot({
                paneId: adoptedContext!.paneId,
                terminalId: adoptedContext!.terminalId,
                sessionReference,
              });
              if (
                boundary.paneId !== adoptedContext!.paneId ||
                boundary.terminalId !== adoptedContext!.terminalId ||
                boundary.workspaceId !== adoptedContext!.workspaceId ||
                boundary.tabId !== adoptedContext!.tabId ||
                boundary.cwd !== adoptedContext!.cwd ||
                boundary.worktreeId !== adoptedContext!.worktreeId
              )
                throw new Error("HERDR_IDENTITY_MISMATCH");
            } catch (primary) {
              const errors: unknown[] = [primary];
              try {
                await this.store.append({
                  type: "agent.state_changed",
                  actor: { principalId: principal.id, kind: principal.kind },
                  entityRefs: { agentId },
                  payload: {
                    agentId,
                    state: "replaced",
                    reason: "HERDR_IDENTITY_MISMATCH",
                  },
                });
              } catch (eventError) {
                errors.push(eventError);
                this.#observeBackgroundFailure(eventError);
              }
              const failure = new OrchestratorError(
                "AGENT_REPLACED",
                "Herdr occupant changed during adoption.",
              );
              Object.assign(failure, {
                cause: new AggregateError(
                  errors,
                  "Adopted registration identity changed at response boundary.",
                ),
              });
              throw failure;
            }
            principal.agentId = agentId;
            principal.generation =
              this.store.state.agents[agentId]?.generation ?? 1;
            principal.piSessionId = pi.sessionId as string;
            client.adoptedRegistration = true;
          };
        }
        if (request.method === "agent.register_managed") {
          if (!this.#herdr)
            throw new OrchestratorError(
              "HERDR_UNAVAILABLE",
              "Managed registration requires Herdr verification.",
            );
          const presentedIdentity = {
            paneId: herdr.paneId as string,
            ...(safeText(herdr.terminalId)
              ? { terminalId: herdr.terminalId }
              : {}),
            sessionReference,
          };
          if (this.store.state.herdrResources?.[agentId]?.state === "pending")
            await this.#herdr.register(
              agentId,
              {
                ...presentedIdentity,
                sessionId: pi.sessionId,
                generation: Number(p.generation ?? 1),
              },
              undefined,
            );
          const managedContext = await this.#herdr.verifyManagedPane(
            agentId,
            presentedIdentity,
          );
          const current = this.store.state.agents[agentId];
          const nextConnectionGeneration =
            (current?.connectionGeneration ?? 0) + 1;
          registrationConnectionGeneration = nextConnectionGeneration;
          responseBoundary = async () => {
            const exactManagedContext = async () => {
              const boundary = await this.#herdr!.verifyManagedPane(
                agentId,
                managedContext,
              );
              if (
                boundary.paneId !== managedContext.paneId ||
                boundary.terminalId !== managedContext.terminalId ||
                boundary.workspaceId !== managedContext.workspaceId ||
                boundary.tabId !== managedContext.tabId ||
                boundary.cwd !== managedContext.cwd ||
                boundary.worktreeId !== managedContext.worktreeId
              )
                throw new Error("HERDR_REGISTRATION_IDENTITY_MISMATCH");
            };
            try {
              await exactManagedContext();
              if (current)
                await this.store.append({
                  type: "agent.state_changed",
                  actor: { principalId: principal.id, kind: principal.kind },
                  entityRefs: { agentId },
                  payload: {
                    agentId,
                    state: "idle",
                    paneId: managedContext.paneId,
                    terminalId: managedContext.terminalId,
                    piSessionId: pi.sessionId,
                    ...(actualModel ? { actualModel } : {}),
                    connectionGeneration: nextConnectionGeneration,
                  },
                });
              await exactManagedContext();
            } catch (primary) {
              const errors: unknown[] = [primary];
              try {
                await this.#herdr!.recordRegistrationMismatch(agentId);
              } catch (resourceError) {
                errors.push(resourceError);
                this.#observeBackgroundFailure(resourceError);
              }
              if (this.store.state.agents[agentId])
                try {
                  await this.store.append({
                    type: "agent.state_changed",
                    actor: { principalId: principal.id, kind: principal.kind },
                    entityRefs: { agentId },
                    payload: {
                      agentId,
                      state: "replaced",
                      reason: "HERDR_REGISTRATION_IDENTITY_MISMATCH",
                    },
                  });
                } catch (agentError) {
                  errors.push(agentError);
                  this.#observeBackgroundFailure(agentError);
                }
              const failure = new OrchestratorError(
                "AGENT_REPLACED",
                "Managed Herdr resource changed during registration.",
              );
              Object.assign(failure, {
                cause: new AggregateError(
                  errors,
                  "Managed registration identity changed at response boundary.",
                ),
              });
              throw failure;
            }
            client.managedConnectionGeneration = nextConnectionGeneration;
          };
          const runId = this.store.state.agents[agentId]?.currentRunId;
          const run = runId ? this.store.state.runs[runId] : undefined;
          if (run && !isRunClosedForAdapterProgress(run.state)) {
            const connectionGeneration = nextConnectionGeneration;
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
              const canFinalize = () => {
                const currentAgent = this.store.state.agents[agentId];
                const currentRun = this.store.state.runs[run.id];
                return (
                  !!currentAgent &&
                  !!currentRun &&
                  currentAgent.generation === agentGeneration &&
                  currentAgent.connectionGeneration === connectionGeneration &&
                  currentAgent.piSessionId === pi.sessionId &&
                  currentAgent.currentRunId === run.id &&
                  currentRun.agentId === agentId &&
                  currentRun.assignmentId === assignmentId &&
                  currentRun.assignmentConnectionGeneration ===
                    connectionGeneration &&
                  currentRun.assignmentDeliveryState === "pending" &&
                  ![
                    "succeeded",
                    "failed",
                    "cancelled",
                    "timed_out",
                    "lost",
                    "settled",
                  ].includes(currentRun.state)
                );
              };
              if (!canFinalize()) return;
              let accepted: unknown;
              try {
                accepted = await this.#sendAdapterRequest(
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
              } catch (error) {
                if (!(
                  error instanceof OrchestratorError &&
                  [
                    "AGENT_DISCONNECTED",
                    "AGENT_REPLACED",
                    "PI_COMMAND_REJECTED",
                    "TIMEOUT",
                  ].includes(error.code)
                ))
                  throw error;
                accepted = undefined;
              }
              const acceptedByAdapter =
                accepted &&
                typeof accepted === "object" &&
                ["accepted", "already_accepted"].includes(
                  String((accepted as Record<string, unknown>).status),
                );
              await this.#enqueueMutation(async () => {
                if (!canFinalize()) return;
                await this.store.append({
                  type: acceptedByAdapter
                    ? "assignment.accepted"
                    : "assignment.delivery_failed",
                  actor: { principalId: principal.id, kind: principal.kind },
                  entityRefs: { agentId, taskId: run.taskId, runId: run.id },
                  payload: acceptedByAdapter
                    ? {
                        assignmentId,
                        runId: run.id,
                        taskId: run.taskId,
                        agentId,
                        generation: agentGeneration,
                        assignmentGeneration: run.assignmentGeneration,
                        piSessionId: pi.sessionId,
                        connectionGeneration,
                        deliveryState: "accepted",
                      }
                    : {
                        assignmentId,
                        runId: run.id,
                        taskId: run.taskId,
                        agentId,
                        generation: agentGeneration,
                        assignmentGeneration: run.assignmentGeneration,
                        reason: "DELIVERY_RETRYABLE",
                        retryable: true,
                      },
                });
              });
            });
          }
        }
        result = {
          agentId,
          generation: this.store.state.agents[agentId]?.generation ?? 1,
          connectionGeneration:
            registrationConnectionGeneration ??
            this.store.state.agents[agentId]?.connectionGeneration ??
            1,
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
        const p = request.params;
        if (
          principal.kind !== "pi_child" ||
          !exactKeys(p, ["agentId", "adapterSeq", "state"]) ||
          p.agentId !== agentId ||
          !Number.isSafeInteger(p.adapterSeq) ||
          Number(p.adapterSeq) <= 0 ||
          !safeBoundedRecord(p.state)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Heartbeat sequence or state is invalid.",
          );
        if (
          (this.store.state.agents[agentId]!.lastAdapterSeq ?? 0) >=
          Number(p.adapterSeq)
        )
          throw new OrchestratorError(
            "RUN_MISMATCH",
            "Heartbeat sequence is stale.",
          );
        const state = p.state as Record<string, unknown>;
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
            adapterSeq: p.adapterSeq,
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
          Number(p.adapterSeq) <= 0 ||
          !p.safeData ||
          typeof p.safeData !== "object" ||
          Array.isArray(p.safeData) ||
          !exactKeys(p.safeData as Record<string, unknown>, [
            "toolName",
            "contextPercent",
          ]) ||
          !(
            (p.safeData as Record<string, unknown>).toolName === null ||
            safeText((p.safeData as Record<string, unknown>).toolName, 128)
          ) ||
          !(
            (p.safeData as Record<string, unknown>).contextPercent === null ||
            (typeof (p.safeData as Record<string, unknown>).contextPercent ===
              "number" &&
              Number.isFinite(
                (p.safeData as Record<string, unknown>).contextPercent,
              ) &&
              Number((p.safeData as Record<string, unknown>).contextPercent) >=
                0 &&
              Number((p.safeData as Record<string, unknown>).contextPercent) <=
                100)
          ) ||
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
        if ((agent.lastAdapterSeq ?? 0) >= Number(p.adapterSeq))
          throw new OrchestratorError(
            "RUN_MISMATCH",
            "Lifecycle sequence is stale.",
          );
        const assignment =
          p.assignment &&
          typeof p.assignment === "object" &&
          !Array.isArray(p.assignment)
            ? (p.assignment as Record<string, unknown>)
            : undefined;
        const progressEvent = ["turn_start", "agent_settled"].includes(
          p.event as string,
        );
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
          if (
            !exactKeys(assignment, ["assignmentId", "generation"]) ||
            !safeText(assignment.assignmentId) ||
            !Number.isSafeInteger(assignment.generation)
          )
            throw new OrchestratorError(
              "RUN_MISMATCH",
              "Lifecycle assignment correlation is invalid.",
            );
          const assignmentId = assignment.assignmentId as string;
          const runId = agent.currentRunId;
          const run = runId ? this.store.state.runs[runId] : undefined;
          if (
            !run ||
            run.agentId !== agent.id ||
            run.assignmentId !== assignmentId ||
            assignment.generation !== run.assignmentGeneration
          )
            throw new OrchestratorError(
              "RUN_MISMATCH",
              "Lifecycle assignment identity is stale.",
            );
          const exactTurn =
            Number.isSafeInteger(p.turnIndex) &&
            Number(p.turnIndex) >= 0 &&
            safeText(p.agentCycleId, 256);
          if (isRunClosedForAdapterProgress(run.state))
            throw new OrchestratorError(
              "RUN_MISMATCH",
              "Run is already closed for lifecycle progress.",
            );
          if (progressEvent && run.assignmentDeliveryState !== "accepted")
            throw new OrchestratorError(
              "RUN_MISMATCH",
              "Assignment was not accepted.",
            );
          if (
            p.event === "agent_settled" &&
            (run.state !== "working" ||
              run.agentCycleId !== p.agentCycleId ||
              run.firstTurnIndex === undefined ||
              Number(p.turnIndex) < run.firstTurnIndex)
          )
            throw new OrchestratorError(
              "RUN_MISMATCH",
              "Settlement lifecycle is stale.",
            );
          if (p.event === "turn_start" && run.state === "working")
            throw new OrchestratorError(
              "RUN_MISMATCH",
              "Run start lifecycle is duplicated.",
            );
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
                adapterSeq: p.adapterSeq,
                connectionGeneration: p.connectionGeneration,
              },
            });
            result = {
              accepted: true,
              runId: run.id,
              state: this.store.state.runs[run.id]?.state,
            };
            deferred.push(async () =>
              this.#enqueueMutation(() =>
                this.#advanceWorkflow(
                  this.store.state.tasks[run.taskId]?.workflowId ?? "",
                  { principalId: principal.id, kind: principal.kind },
                ),
              ),
            );
          } else if (p.event === "turn_start") {
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
                adapterSeq: p.adapterSeq,
                connectionGeneration: p.connectionGeneration,
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
          (p.runId !== undefined && !safeText(p.runId)) ||
          (p.assignmentGeneration !== undefined &&
            (!Number.isSafeInteger(p.assignmentGeneration) ||
              Number(p.assignmentGeneration) < 1))
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
          request.method === "agent.interrupt" ||
          request.method === "agent.stop" ||
          request.method === "agent.close"
        ) {
          const allowed =
            request.method === "agent.interrupt"
              ? ["agentId", "runId", "assignmentGeneration", "reason"]
              : request.method === "agent.stop"
                ? [
                    "agentId",
                    "runId",
                    "assignmentGeneration",
                    "reason",
                    "force",
                  ]
                : [
                    "agentId",
                    "runId",
                    "assignmentGeneration",
                    "reason",
                    "confirm",
                  ];
          if (
            !exactKeys(p, allowed) ||
            (p.reason !== undefined && !safeText(p.reason, 16_384)) ||
            (p.force !== undefined && typeof p.force !== "boolean") ||
            (p.confirm !== undefined && typeof p.confirm !== "boolean") ||
            (request.method === "agent.close" && p.confirm !== true)
          )
            throw new OrchestratorError(
              "INVALID_REQUEST",
              "Agent control request is invalid.",
            );
          if (p.runId !== undefined || p.assignmentGeneration !== undefined) {
            const correlated =
              typeof p.runId === "string"
                ? this.store.state.runs[p.runId]
                : undefined;
            if (
              !correlated ||
              correlated.agentId !== target ||
              p.assignmentGeneration !== correlated.assignmentGeneration
            )
              throw new OrchestratorError(
                "RUN_MISMATCH",
                "Agent control run identity does not match.",
              );
          }
        }
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
          delete params.assignmentGeneration;
          delete params.reason;
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
      } else if (request.method === "agent.ask") {
        requirePermission(principal, "manage:self");
        const p = request.params;
        if (
          !exactKeys(p, ["agentId", "message", "followUps", "timeoutMs"]) ||
          !safeText(p.agentId) ||
          !safeText(p.message, 16_384) ||
          !Number.isSafeInteger(p.timeoutMs) ||
          Number(p.timeoutMs) < 1 ||
          Number(p.timeoutMs) > 120_000 ||
          (p.followUps !== undefined &&
            (!Array.isArray(p.followUps) ||
              p.followUps.length > 3 ||
              p.followUps.some((item) => !safeText(item, 16_384))))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Peer question thread is invalid.",
          );
        const target = p.agentId as string;
        const agent = this.store.state.agents[target];
        if (!agent)
          throw new OrchestratorError(
            "AGENT_NOT_FOUND",
            "Agent was not found.",
          );
        if (!this.#canPeerAskAgent(principal, target))
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Agent is outside the project or group peer scope.",
          );
        const messages = [
          p.message,
          ...((p.followUps as string[] | undefined) ?? []),
        ] as string[];
        const answers: string[] = [];
        for (let index = 0; index < messages.length; index++) {
          const response = await this.#sendAdapterRequest(
            target,
            "control.ask",
            {
              message: messages[index],
              delivery: index === 0 ? "normal" : "follow_up",
              timeoutMs: p.timeoutMs,
            },
            {
              generation: agent.generation,
              ...(agent.piSessionId ? { piSessionId: agent.piSessionId } : {}),
              ...(agent.currentRunId ? { runId: agent.currentRunId } : {}),
            },
            p.timeoutMs as number,
          );
          const answer =
            response && typeof response === "object" && !Array.isArray(response)
              ? (response as Record<string, unknown>).answer
              : undefined;
          if (!safeText(answer, 65_536))
            throw new OrchestratorError(
              "PEER_ANSWER_UNAVAILABLE",
              "The peer did not return an answer.",
            );
          answers.push(answer);
        }
        result = {
          threadId: createId("evt"),
          agentId: target,
          messageCount: messages.length,
          followUpCount: messages.length - 1,
          answer: answers.at(-1),
          answers,
        };
      } else if (request.method === "coordination.signal") {
        requirePermission(principal, "manage:self");
        if (
          !exactKeys(request.params, ["targetId"]) ||
          !safeText(request.params.targetId, 256)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Signal ID is invalid.",
          );
        this.#coordinationSignals.set(request.params.targetId, this.#now());
        result = { targetId: request.params.targetId, signaled: true };
      } else if (request.method === "coordination.wait") {
        requirePermission(principal, "read:state");
        const p = request.params;
        if (
          !exactKeys(p, [
            "kind",
            "targetId",
            "until",
            "durationMs",
            "startedAt",
            "timeoutMs",
            "pollMs",
          ]) ||
          ![
            "timer",
            "signal",
            "agent",
            "task",
            "result",
            "question",
            "group",
          ].includes(p.kind as string) ||
          (p.targetId !== undefined && !safeText(p.targetId, 256)) ||
          (p.until !== undefined &&
            (!Array.isArray(p.until) ||
              p.until.length < 1 ||
              p.until.length > 16 ||
              p.until.some((item) => !safeText(item, 64))))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Coordination wait target is invalid.",
          );
        const until = new Set((p.until as string[] | undefined) ?? []);
        let state: string | undefined;
        let value: unknown;
        if (p.kind === "timer") {
          const startedAt =
            typeof p.startedAt === "string" ? Date.parse(p.startedAt) : NaN;
          if (
            !Number.isFinite(startedAt) ||
            !Number.isSafeInteger(p.durationMs) ||
            Number(p.durationMs) < 1 ||
            Number(p.durationMs) > 86_400_000
          )
            throw new OrchestratorError(
              "INVALID_REQUEST",
              "Timer wait is invalid.",
            );
          state =
            this.#now() >= startedAt + Number(p.durationMs)
              ? "elapsed"
              : "pending";
        } else if (p.kind === "signal") {
          if (!safeText(p.targetId, 256))
            throw new OrchestratorError(
              "INVALID_REQUEST",
              "Signal ID is invalid.",
            );
          state = this.#coordinationSignals.has(p.targetId)
            ? "signaled"
            : "pending";
        } else {
          if (!safeText(p.targetId, 256))
            throw new OrchestratorError(
              "INVALID_REQUEST",
              "Target ID is invalid.",
            );
          if (p.kind === "agent") value = this.store.state.agents[p.targetId];
          else if (p.kind === "task")
            value = this.store.state.tasks[p.targetId];
          else if (p.kind === "result")
            value = this.store.state.results?.[p.targetId];
          else if (p.kind === "question")
            value = this.store.state.questions?.[p.targetId];
          else value = this.store.state.groups?.[p.targetId];
          if (!value)
            throw new OrchestratorError(
              "TARGET_NOT_FOUND",
              "Wait target was not found.",
            );
          state = String(
            (value as Record<string, unknown>).state ?? "available",
          );
        }
        const ready = until.size > 0 ? until.has(state) : state !== "pending";
        result = {
          kind: p.kind,
          targetId: p.targetId ?? null,
          state,
          ready,
          value,
        };
      } else if (request.method === "group.create") {
        requirePermission(principal, "manage:self");
        const p = request.params;
        if (
          !exactKeys(p, ["name", "agentIds"]) ||
          !safeText(p.name, 256) ||
          !Array.isArray(p.agentIds) ||
          p.agentIds.length < 1 ||
          p.agentIds.length > 64 ||
          p.agentIds.some((id) => !safeText(id, 256)) ||
          new Set(p.agentIds).size !== p.agentIds.length
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Group definition is invalid.",
          );
        for (const agentId of p.agentIds as string[]) {
          if (!this.store.state.agents[agentId])
            throw new OrchestratorError(
              "AGENT_NOT_FOUND",
              "A group agent was not found.",
            );
          if (!(await this.#canAccessAgent(principal, agentId)))
            throw new OrchestratorError(
              "PERMISSION_DENIED",
              "A group agent is outside the descendant scope.",
            );
        }
        const groupId = createId("grp");
        committedEvent = await this.store.append({
          type: "group.created",
          actor: { principalId: principal.id, kind: principal.kind },
          entityRefs: { groupId },
          payload: {
            groupId,
            name: p.name,
            agentIds: p.agentIds,
            createdAt: new Date(this.#now()).toISOString(),
          },
        });
        result = this.store.state.groups![groupId];
      } else if (
        request.method === "group.list" ||
        request.method === "group.get" ||
        request.method === "group.wait" ||
        request.method === "group.stop" ||
        request.method === "group.close"
      ) {
        requirePermission(
          principal,
          request.method === "group.list" ||
            request.method === "group.get" ||
            request.method === "group.wait"
            ? "read:state"
            : "manage:self",
        );
        if (request.method === "group.list") {
          if (!exactKeys(request.params, []))
            throw new OrchestratorError(
              "INVALID_REQUEST",
              "Group list input is invalid.",
            );
          const items = [];
          for (const group of Object.values(this.store.state.groups ?? {}))
            if (
              await Promise.all(
                group.agentIds.map((id) => this.#canAccessAgent(principal, id)),
              ).then((access) => access.every(Boolean))
            )
              items.push(group);
          result = {
            items,
            nextCursor: null,
            snapshotSeq: this.store.state.lastEventSeq,
          };
        } else {
          const p = request.params;
          if (!safeText(p.groupId, 256))
            throw new OrchestratorError(
              "INVALID_REQUEST",
              "Group ID is invalid.",
            );
          const group = this.store.state.groups?.[p.groupId];
          if (!group)
            throw new OrchestratorError(
              "GROUP_NOT_FOUND",
              "Group was not found.",
            );
          for (const agentId of group.agentIds)
            if (!(await this.#canAccessAgent(principal, agentId)))
              throw new OrchestratorError(
                "PERMISSION_DENIED",
                "Group is outside the descendant scope.",
              );
          if (request.method === "group.get") {
            if (!exactKeys(p, ["groupId"]))
              throw new OrchestratorError(
                "INVALID_REQUEST",
                "Group get input is invalid.",
              );
            result = group;
          } else if (request.method === "group.wait") {
            if (
              !exactKeys(p, ["groupId", "until", "mode", "timeoutMs"]) ||
              !Array.isArray(p.until) ||
              p.until.length < 1 ||
              p.until.length > 16 ||
              p.until.some((item) => !safeText(item, 64)) ||
              !["all", "any"].includes(p.mode as string)
            )
              throw new OrchestratorError(
                "INVALID_REQUEST",
                "Group wait input is invalid.",
              );
            const until = new Set(p.until as string[]);
            const members = group.agentIds.map((agentId) => ({
              agentId,
              state: this.store.state.agents[agentId]?.state ?? "missing",
            }));
            const matches = members.map((member) => until.has(member.state));
            result = {
              groupId: group.id,
              state: group.state,
              members,
              ready:
                p.mode === "all"
                  ? matches.every(Boolean)
                  : matches.some(Boolean),
            };
          } else {
            const close = request.method === "group.close";
            const allowed = close
              ? ["groupId", "reason", "confirm"]
              : ["groupId", "reason", "force"];
            if (
              !exactKeys(p, allowed) ||
              (close
                ? p.reason !== undefined && !safeText(p.reason, 16_384)
                : !safeText(p.reason, 16_384)) ||
              (close
                ? p.confirm !== true
                : p.force !== undefined && typeof p.force !== "boolean")
            )
              throw new OrchestratorError(
                "INVALID_REQUEST",
                "Group control input is invalid.",
              );
            if (!this.#herdr)
              throw new OrchestratorError(
                "AGENT_DISCONNECTED",
                "Herdr is unavailable.",
              );
            const outcomes = [];
            for (const agentId of group.agentIds) {
              const resource = this.store.state.herdrResources?.[agentId];
              if (!resource?.paneId) {
                outcomes.push({ agentId, state: "unavailable" });
                continue;
              }
              const guard = {
                paneId: resource.paneId,
                ...(resource.terminalId
                  ? { terminalId: resource.terminalId }
                  : {}),
                ...(resource.sessionId
                  ? { sessionId: resource.sessionId }
                  : {}),
              } as never;
              if (close) await this.#herdr.close(guard);
              else await this.#herdr.stop(guard);
              outcomes.push({ agentId, state: close ? "closed" : "stopped" });
            }
            const type = close ? "group.closed" : "group.stopped";
            committedEvent = await this.store.append({
              type,
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { groupId: group.id },
              payload: {
                groupId: group.id,
                at: new Date(this.#now()).toISOString(),
                ...(close ? { confirm: true } : {}),
              },
            });
            result = { ...this.store.state.groups![group.id], outcomes };
          }
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
          if (run.settled)
            deferred.push(async () =>
              this.#enqueueMutation(() =>
                this.#advanceWorkflow(
                  this.store.state.tasks[run.taskId]?.workflowId ?? "",
                  { principalId: principal.id, kind: principal.kind },
                ),
              ),
            );
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
            "toolCallId",
            "question",
          ]) ||
          !safeText(p.agentId) ||
          !safeText(p.taskId) ||
          !safeText(p.runId) ||
          !Number.isSafeInteger(p.assignmentGeneration) ||
          !safeText(p.toolCallId, 256)
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
          !["working", "blocked"].includes(run.state)
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
        const existing = Object.values(this.store.state.questions ?? {}).find(
          (q) => q.runId === run.id,
        );
        if (existing && existing.toolCallId === p.toolCallId) {
          if (
            existing.taskId !== run.taskId ||
            existing.agentId !== run.agentId ||
            existing.assignmentGeneration !== p.assignmentGeneration
          )
            throw new OrchestratorError(
              "RUN_MISMATCH",
              "Question correlation does not match the existing tool call.",
            );
          if (existing.state === "open")
            this.#scheduleQuestionTimeout(existing);
          result = {
            questionId: existing.id,
            runId: existing.runId,
            assignmentGeneration: existing.assignmentGeneration,
            toolCallId: existing.toolCallId,
            state: existing.state,
            ...(existing.state === "answered" && existing.answer
              ? { answer: existing.answer }
              : {}),
          };
        } else if (
          Object.values(this.store.state.questions ?? {}).some(
            (q) => q.runId === run.id && q.state === "open",
          )
        )
          throw new OrchestratorError(
            "LIMIT_EXCEEDED",
            "A run may have only one open question.",
          );
        else {
          validateQuestion(p.question);
          const q = p.question as QuestionBody;
          const id = createId("qst");
          const askedAt = new Date(this.#now()).toISOString();
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
              toolCallId: p.toolCallId,
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
          this.#scheduleQuestionTimeout(this.store.state.questions![id]!);
          result = {
            questionId: id,
            runId: run.id,
            assignmentGeneration: p.assignmentGeneration,
            toolCallId: p.toolCallId,
            state: "open",
          };
        }
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
        const answer = p.answer as { optionId: unknown; text: unknown };
        if (
          Object.keys(answer).length !== 2 ||
          !exactKeys(answer as Record<string, unknown>, ["optionId", "text"])
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Answer fields are invalid.",
          );
        if (
          (answer.optionId !== null && typeof answer.optionId !== "string") ||
          (answer.optionId === null &&
            (!body?.allowFreeform || typeof answer.text !== "string")) ||
          (typeof answer.optionId === "string" &&
            (!body?.options.some((o) => o.id === answer.optionId) ||
              (answer.text !== null && typeof answer.text !== "string"))) ||
          (typeof answer.optionId === "string" &&
            answer.optionId.length === 0) ||
          (answer.text !== null &&
            (typeof answer.text !== "string" ||
              answer.text.length === 0 ||
              Buffer.byteLength(answer.text, "utf8") > 16_384 ||
              /[\u0000-\u001f\u007f]/u.test(answer.text)))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Answer does not match the canonical shape.",
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
              optionId:
                typeof answer.optionId === "string" ? answer.optionId : null,
              text: typeof answer.text === "string" ? answer.text : null,
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
        deferred.push(
          this.#deferQuestionDelivery(
            this.store.state.questions?.[question.id] ?? question,
            "answered",
            result && typeof result === "object"
              ? (
                  result as {
                    answer?: { optionId: string | null; text: string | null };
                  }
                ).answer
              : undefined,
          ),
        );
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
          const activeRun = this.store.state.runs[question.runId];
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
          const deliverTimeout = this.#deferQuestionDelivery(
            question,
            "timed_out",
          );
          deferred.push(async () => {
            await deliverTimeout().catch((error: unknown) => {
              this.#observeAdapterDeliveryFailure(error);
            });
          });
          if (
            activeRun?.agentId &&
            !isRunClosedForAdapterProgress(activeRun.state)
          )
            deferred.push(() => this.#cancelExactRun(activeRun));
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
        if (isTerminal(task.state)) {
          result = { taskId: task.id, state: task.state };
        } else {
          const activeRun = task.currentRunId
            ? this.store.state.runs[task.currentRunId]
            : undefined;
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
          if (
            activeRun &&
            activeRun.agentId &&
            !isRunClosedForAdapterProgress(activeRun.state)
          )
            deferred.push(() => this.#cancelExactRun(activeRun));
          for (const question of Object.values(
            this.store.state.questions ?? {},
          ).filter(
            (item) => item.taskId === task.id && item.state === "open",
          )) {
            await this.store.append({
              type: "question.cancelled",
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
              payload: { runId: question.runId, state: "cancelled" },
            });
            deferred.push(
              this.#deferQuestionDelivery(
                this.store.state.questions?.[question.id] ?? question,
                "cancelled",
              ),
            );
          }
          result = { taskId: task.id, state: "cancelled" };
          if (task.workflowId)
            deferred.push(async () =>
              this.#enqueueMutation(() =>
                this.#advanceWorkflow(task.workflowId!, {
                  principalId: principal.id,
                  kind: principal.kind,
                }),
              ),
            );
        }
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
        request.method === "metadata.get" ||
        request.method === "transcript.close"
      ) {
        requirePermission(principal, "read:state");
        const p = request.params;
        const close = request.method === "transcript.close";
        if (
          !exactKeys(p, close ? ["taskId", "confirm"] : ["taskId"]) ||
          !safeText(p.taskId) ||
          (close && p.confirm !== true)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Transcript metadata request is invalid.",
          );
        const task = this.store.state.tasks[p.taskId as string];
        if (!task)
          throw new OrchestratorError("NOT_FOUND", "Task was not found.");
        if (!(await this.#canAccessTask(principal, task.id)))
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Task is outside the authenticated scope.",
          );
        const matches = Object.values(
          this.store.state.herdrMetadata ?? {},
        ).filter((item) => item.taskId === task.id);
        if (matches.length !== 1)
          throw new OrchestratorError(
            matches.length === 0 ? "NOT_FOUND" : "HERDR_IDENTITY_MISMATCH",
            matches.length === 0
              ? "Task metadata was not found."
              : "Task metadata identity is ambiguous.",
          );
        const metadata = matches[0]!;
        const workflowDigest = String(
          (task.project?.compact as { workflowDigest?: unknown } | undefined)
            ?.workflowDigest ?? "",
        );
        if (!/^[a-f0-9]{64}$/u.test(workflowDigest))
          throw new OrchestratorError(
            "STATE_CORRUPT",
            "Compact task correlation is invalid.",
          );
        if (!close) result = metadata;
        else if (metadata.state === "closed") {
          result = {
            taskId: metadata.taskId,
            metadataId: metadata.metadataId,
            transcriptRef: metadata.transcriptRef,
            state: "closed",
          };
        } else {
          if (
            !this.#herdr ||
            !metadata.exitedAt ||
            !metadata.transcriptRef ||
            metadata.transcriptPolicy !== "retain-tab"
          )
            throw new OrchestratorError(
              "INVALID_REQUEST",
              "The retained transcript is not ready for close.",
            );
          let closeIntent = metadata;
          if (metadata.state !== "cleanup_pending") {
            const pendingAt = new Date(this.#now()).toISOString();
            const pending = {
              ...metadata,
              state: "cleanup_pending" as const,
              updatedAt: pendingAt,
            };
            delete (pending as Partial<HerdrTaskMetadata>).metadataDigest;
            committedEvent = await this.store.append({
              type: "herdr.metadata_projected",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: {
                workflowId: metadata.workflowId,
                taskId: metadata.taskId,
                runId: metadata.runId,
                agentId: metadata.agentId,
                workflowDigest,
              },
              payload: {
                ...pending,
                metadataDigest: sha256(canonicalJson(pending)),
              },
            });
            closeIntent = this.store.state.herdrMetadata![metadata.metadataId]!;
          }
          await this.#herdr.closeRetainedTab({
            workspaceId: closeIntent.workspaceId,
            tabId: closeIntent.tabId,
            paneId: closeIntent.paneId,
            terminalId: closeIntent.terminalId,
          });
          const updatedAt = new Date(this.#now()).toISOString();
          const closed = {
            ...closeIntent,
            state: "closed" as const,
            updatedAt,
          };
          delete (closed as Partial<HerdrTaskMetadata>).metadataDigest;
          committedEvent = await this.store.append({
            type: "herdr.metadata_projected",
            actor: { principalId: principal.id, kind: principal.kind },
            entityRefs: {
              workflowId: metadata.workflowId,
              taskId: metadata.taskId,
              runId: metadata.runId,
              agentId: metadata.agentId,
              workflowDigest,
            },
            payload: {
              ...closed,
              metadataDigest: sha256(canonicalJson(closed)),
            },
          });
          result = {
            taskId: metadata.taskId,
            metadataId: metadata.metadataId,
            transcriptRef: metadata.transcriptRef,
            state: "closed",
          };
        }
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
                "modelProfileId",
                "placement",
                "project",
                "isolation",
                "budget",
                "parentAgentId",
                "wait",
                "dryRun",
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
                "compact",
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
        const parentAgent = this.store.state.agents[parentAgentId];
        if (
          !parentAgent ||
          !safeText(parentAgent.cwd) ||
          !safeText(parentAgent.workspaceId)
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Authenticated parent project context is unavailable.",
          );
        const inheritedProject: Record<string, unknown> = {
          cwd: parentAgent.cwd,
          workspaceId: parentAgent.workspaceId,
        };
        if (
          request.method === "agent.spawn" &&
          p.project !== undefined &&
          (!p.project ||
            typeof p.project !== "object" ||
            (p.project as Record<string, unknown>).cwd !==
              inheritedProject.cwd ||
            ((p.project as Record<string, unknown>).workspaceId !== undefined &&
              (p.project as Record<string, unknown>).workspaceId !==
                inheritedProject.workspaceId))
        )
          throw new OrchestratorError(
            "PERMISSION_DENIED",
            "Spawn project is outside the authenticated parent context.",
          );
        const requestedIsolation =
          request.method === "agent.spawn"
            ? exactRequestedIsolation(p.isolation)
            : undefined;
        if (
          request.method === "agent.spawn" &&
          ((p.placement !== undefined &&
            p.placement !== "current-workspace" &&
            p.placement !== "new-workspace") ||
            (p.modelProfileId !== undefined &&
              p.modelProfileId !== "manager" &&
              p.modelProfileId !== "subagent"))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Spawn placement or model profile is invalid.",
          );
        const compact =
          p.compact &&
          typeof p.compact === "object" &&
          !Array.isArray(p.compact)
            ? (p.compact as Record<string, unknown>)
            : undefined;
        if (
          p.compact !== undefined &&
          (!compact ||
            !exactKeys(compact, ["workflowDigest", "transcriptPolicy"]) ||
            !/^[a-f0-9]{64}$/u.test(String(compact.workflowDigest)) ||
            compact.transcriptPolicy !== "retain-tab")
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Compact workflow metadata is invalid.",
          );
        const dryRun = p.dryRun === true;
        const creationNow = this.#now();
        const createdAt = new Date(creationNow).toISOString();
        const wallDeadline = taskDeadline(
          creationNow,
          request.method === "delegate.execute" ? p.timeoutMs : undefined,
        );
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
        const planned = steps.map((raw) => {
          const record = raw as Record<string, unknown>;
          const profileId = record.profileId as string;
          const requested = compact
            ? exactRequestedIsolation({ mode: record.isolation })
            : requestedIsolation;
          const spawnPolicy = resolveSpawnPolicy(
            {
              taskProfileId: profileId,
              ...(request.method === "agent.spawn" &&
              (p.placement === "current-workspace" ||
                p.placement === "new-workspace")
                ? { placement: p.placement as AgentPlacement }
                : {}),
              ...(request.method === "agent.spawn" &&
              (p.modelProfileId === "manager" ||
                p.modelProfileId === "subagent")
                ? { modelProfileId: p.modelProfileId as ModelProfileId }
                : {}),
            },
            this.#modelPolicy,
          );
          if (compact) {
            const expectedPolicy = record.compactPolicy;
            const effective = spawnPolicy.effective;
            const currentPolicy = {
              decision: "allow",
              placement: effective.placement,
              isolation: resolveIsolation(profileId, requested),
              modelProfileId: effective.modelProfileId,
              providerQualifiedModel: `${effective.model.provider}/${effective.model.modelId}`,
              thinkingLevel: effective.model.thinkingLevel,
              modelPolicyHash: spawnPolicy.policyHash,
            };
            if (canonicalJson(expectedPolicy) !== canonicalJson(currentPolicy))
              throw new OrchestratorError(
                "INVALID_REQUEST",
                "Compact policy changed after preview acceptance.",
              );
          }
          return {
            key: safeText(record.key, 64)
              ? (record.key as string)
              : createId("tsk"),
            profileId,
            title: safeText(record.title, 256)
              ? (record.title as string)
              : "Delegated task",
            objective: record.objective as string,
            constraints: Array.isArray(record.constraints)
              ? (record.constraints as unknown[])
              : [],
            dependsOn: Array.isArray(record.dependsOn)
              ? (record.dependsOn as unknown[])
              : [],
            isolation: resolveIsolation(profileId, requested),
            spawnPolicy,
          };
        });
        const taskIds = planned.map(() => createId("tsk"));
        try {
          validateWorkflow({
            version: 1,
            id: workflowId,
            name: safeText(p.title, 256) ? p.title : "Delegation",
            description: "",
            mode: (request.method === "delegate.execute" &&
            [
              "parallel",
              "chain",
              "dag",
              "single",
              "implement_review_fix",
            ].includes(String(p.mode))
              ? p.mode
              : "parallel") as WorkflowDefinition["mode"],
            failureMode:
              p.failureMode === "fail_fast" ? "fail_fast" : "collect_all",
            maxCorrectionLoops: 0,
            steps: planned.map((step) => ({
              key: step.key,
              profileId: step.profileId,
              title: step.title,
              objectiveTemplate: step.objective,
              constraints: step.constraints.filter(
                (item): item is string => typeof item === "string",
              ),
              dependsOn: step.dependsOn.filter(
                (item): item is string => typeof item === "string",
              ),
              resultProjection: [],
              isolationMode: step.isolation,
            })),
          });
        } catch (error) {
          throw new OrchestratorError(
            "INVALID_REQUEST",
            error instanceof Error && error.message === "WORKFLOW_CYCLE"
              ? "Delegation dependencies contain a cycle."
              : "Delegation workflow is invalid.",
          );
        }
        const scheduler = new DeterministicScheduler();
        if (
          Object.values(this.store.state.tasks).filter(
            (task) => task.state === "queued",
          ).length +
            planned.length >
          scheduler.limits.maxQueuedTasks
        )
          throw new OrchestratorError(
            "LIMIT_EXCEEDED",
            "The global task queue is full.",
          );
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
              requestedModel: step.spawnPolicy.requested,
              effectiveModel: step.spawnPolicy.effective,
            })),
          };
        } else if (compact && compactIdempotency) {
          const frozenResponse = {
            workflowId,
            state: "scheduled",
            tasks: planned.map((step, index) => ({
              key: step.key,
              taskId: taskIds[index]!,
              state: "queued",
            })),
          };
          committedEvent = await this.store.append({
            type: "compact.delegation_scheduled",
            actor: { principalId: principal.id, kind: principal.kind },
            entityRefs: { workflowId },
            payload: {
              workflowId,
              parentAgentId,
              mode: safeText(p.mode, 32) ? p.mode : "dag",
              idempotencyKey: compactIdempotency.key,
              paramsHash: compactIdempotency.paramsHash,
              response: frozenResponse,
              tasks: planned.map((step, index) => ({
                taskId: taskIds[index]!,
                title: step.title,
                objective: step.objective,
                createdAt,
                parentAgentId,
                workflowId,
                profileId: step.profileId,
                dependencies: step.dependsOn
                  .map((key) =>
                    planned.find((candidate) => candidate.key === key),
                  )
                  .filter(Boolean)
                  .map((candidate) => taskIds[planned.indexOf(candidate!)]),
                project: {
                  ...inheritedProject,
                  isolation: step.isolation,
                  requestedSpawnPolicy: step.spawnPolicy.requested,
                  effectiveSpawnPolicy: step.spawnPolicy.effective,
                  modelPolicyHash: step.spawnPolicy.policyHash,
                  compact: {
                    workflowDigest: compact.workflowDigest,
                    transcriptPolicy: "retain-tab",
                  },
                },
                timeoutAt: wallDeadline,
              })),
            },
          });
          for (const taskId of taskIds)
            this.#scheduleTaskDeadline(this.store.state.tasks[taskId]!);
          await this.#advanceWorkflow(workflowId, {
            principalId: principal.id,
            kind: principal.kind,
          });
          result = frozenResponse;
          compactIdempotency = undefined;
        } else {
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
          for (let index = 0; index < planned.length; index++) {
            const step = planned[index]!;
            const taskId = taskIds[index]!;
            await this.store.append({
              type: "task.created_m3",
              actor: { principalId: principal.id, kind: principal.kind },
              entityRefs: { taskId },
              payload: {
                taskId,
                title: step.title,
                objective: step.objective,
                createdAt,
                parentAgentId,
                workflowId,
                profileId: step.profileId,
                dependencies: step.dependsOn
                  .map((key) =>
                    planned.find((candidate) => candidate.key === key),
                  )
                  .filter(Boolean)
                  .map((candidate) => taskIds[planned.indexOf(candidate!)]),
                project: {
                  ...inheritedProject,
                  isolation: step.isolation,
                  requestedSpawnPolicy: step.spawnPolicy.requested,
                  effectiveSpawnPolicy: step.spawnPolicy.effective,
                  modelPolicyHash: step.spawnPolicy.policyHash,
                  ...(compact
                    ? {
                        compact: {
                          workflowDigest: compact.workflowDigest,
                          transcriptPolicy: "retain-tab",
                        },
                      }
                    : {}),
                },
                timeoutAt: wallDeadline,
              },
            });
            this.#scheduleTaskDeadline(this.store.state.tasks[taskId]!);
          }
          await this.#advanceWorkflow(workflowId, {
            principalId: principal.id,
            kind: principal.kind,
          });
          const currentTasks = planned.map((step, index) => {
            const task = this.store.state.tasks[taskIds[index]!];
            const run = task?.currentRunId
              ? this.store.state.runs[task.currentRunId]
              : undefined;
            return {
              key: step.key,
              taskId: taskIds[index],
              ...(run?.agentId
                ? {
                    agentId: run.agentId,
                    runId: run.id,
                    assignmentId: run.assignmentId,
                  }
                : {}),
              state: task?.state ?? "queued",
            };
          });
          result = {
            workflowId,
            state: this.store.state.workflows[workflowId]?.state ?? "running",
            tasks: currentTasks,
          };
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
        const resolvedPlan = plan.steps.map((step) => ({
          ...step,
          isolationMode: resolveWorkflowIsolation(
            step.profileId,
            step.isolationMode,
          ),
          requestedIsolationMode: step.isolationMode,
        }));
        for (const step of plan.steps)
          if (
            step.isolationMode === "reuse-worktree" &&
            step.dependsOn.length !== 1
          )
            throw new OrchestratorError(
              "INVALID_REQUEST",
              "reuse-worktree requires exactly one dependency.",
            );
        const taskIds = resolvedPlan.map((step) => step.taskId);
        const creationNow = this.#now();
        const createdAt = new Date(creationNow).toISOString();
        const queueLimit = new DeterministicScheduler().limits.maxQueuedTasks;
        if (
          !p.dryRun &&
          Object.values(this.store.state.tasks).filter(
            (task) => task.state === "queued",
          ).length +
            resolvedPlan.length >
            queueLimit
        )
          throw new OrchestratorError(
            "LIMIT_EXCEEDED",
            "The global task queue is full.",
          );
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
          for (const step of resolvedPlan) {
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
                createdAt,
                parentAgentId,
                workflowId: plan.workflowId,
                ...(this.store.state.agents[parentAgentId]?.cwd &&
                this.store.state.agents[parentAgentId]?.workspaceId
                  ? {
                      project: {
                        cwd: this.store.state.agents[parentAgentId]!.cwd,
                        workspaceId:
                          this.store.state.agents[parentAgentId]!.workspaceId,
                        isolation: step.isolationMode,
                      },
                    }
                  : {}),
                profileId: step.profileId,
                isolationMode: step.requestedIsolationMode,
                dependencies: step.dependsOn
                  .map((key) => plan.steps.find((x) => x.key === key)?.taskId)
                  .filter((x): x is string => Boolean(x)),
                timeoutAt: taskDeadline(creationNow, undefined),
              },
            });
            this.#scheduleTaskDeadline(this.store.state.tasks[step.taskId]!);
          }
        if (p.dryRun !== true)
          await this.#advanceWorkflow(plan.workflowId, {
            principalId: principal.id,
            kind: principal.kind,
          });
        result = {
          workflowId: plan.workflowId,
          state:
            p.dryRun === true
              ? "created"
              : (this.store.state.workflows[plan.workflowId]?.state ??
                "running"),
          tasks: resolvedPlan.map((s) => ({
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
            const activeRun = task?.currentRunId
              ? this.store.state.runs[task.currentRunId]
              : undefined;
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
            if (
              activeRun &&
              activeRun.agentId &&
              !isRunClosedForAdapterProgress(activeRun.state)
            )
              deferred.push(() => this.#cancelExactRun(activeRun));
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
        if (isTerminal(task.state))
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "The task is already terminal.",
          );
        if (!agent)
          throw new OrchestratorError(
            "AGENT_NOT_FOUND",
            "Agent was not found.",
          );
        if (task.timeoutAt && Date.parse(task.timeoutAt) <= this.#now())
          throw new OrchestratorError(
            "TIMEOUT",
            "The task wall deadline has expired.",
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
            ...(task.timeoutAt ? { timeoutAt: task.timeoutAt } : {}),
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
        const creationNow = this.#now();
        const createdAt = new Date(creationNow).toISOString();
        let timeoutAt: string;
        if (p.timeoutAt !== undefined) {
          if (
            !safeText(p.timeoutAt) ||
            !Number.isFinite(Date.parse(p.timeoutAt)) ||
            Date.parse(p.timeoutAt) <= creationNow ||
            Date.parse(p.timeoutAt) - creationNow > MAX_TASK_WALL_MS
          )
            throw new OrchestratorError(
              "INVALID_REQUEST",
              "Task wall deadline is invalid or expired.",
            );
          timeoutAt = new Date(Date.parse(p.timeoutAt)).toISOString();
        } else timeoutAt = taskDeadline(creationNow, undefined);
        committedEvent = await this.store.append({
          type: "task.created_m3",
          actor: { principalId: principal.id, kind: principal.kind },
          entityRefs: { taskId },
          payload: {
            taskId,
            title: p.title,
            objective: p.objective,
            createdAt,
            ...(safeText(p.parentAgentId)
              ? { parentAgentId: p.parentAgentId }
              : {}),
            ...(safeText(p.profileId) ? { profileId: p.profileId } : {}),
            ...(Array.isArray(p.dependencies)
              ? { dependencies: p.dependencies }
              : {}),
            timeoutAt,
          },
        });
        this.#scheduleTaskDeadline(this.store.state.tasks[taskId]!);
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
        const createdAt = new Date(this.#now()).toISOString();
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
              createdAt,
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
      if (committedEvent) await this.#writeSnapshotBestEffort();
      await responseBoundary?.();
      const response = {
        v: 1,
        type: "response",
        id: request.id,
        method: responseMethod,
        ok: true,
        result,
      };
      this.#writeFrame(client, response);
      if (shutdownAfterResponse)
        setImmediate(() => {
          void this.stop().catch((error: unknown) =>
            this.#observeBackgroundFailure(error),
          );
        });
      for (const action of deferred) this.#trackDeferred(action);
      for (const event of replayEvents) this.#sendEvent(client, event);
      if (client.initializing) {
        for (const event of [
          ...(client.subscriptionBuffer?.values() ?? []),
        ].sort((a, b) => a.seq - b.seq))
          this.#sendEvent(client, event);
        client.subscriptionBuffer?.clear();
        client.initializing = false;
        client.subscribed = true;
      }
    } catch (error) {
      const typed =
        error instanceof OrchestratorError
          ? error
          : new OrchestratorError("INVALID_REQUEST", "Request failed.");
      if (typed.code === "PERMISSION_DENIED" && !this.store.readOnly) {
        let denied: import("../state/types.js").StoredEvent | undefined;
        try {
          denied = await this.store.append({
            type: "audit.authorization_denied",
            actor: {
              principalId: principal.id,
              kind: principal.kind,
            },
            entityRefs: {},
            payload: { action: responseMethod },
          });
        } catch (auditError: unknown) {
          this.#observeBackgroundFailure(auditError);
        }
        if (denied) await this.#writeSnapshotBestEffort();
      }
      this.#writeFrame(client, {
        v: 1,
        type: "response",
        id: request.id,
        method: responseMethod,
        ok: false,
        error: {
          code: typed.code,
          message: typed.message,
          retryable: typed.retryable,
        },
      });
    }
  }
  async #projectCompactMetadata(
    event: StoredEvent,
    forcePublication = false,
  ): Promise<void> {
    let taskId = event.entityRefs.taskId;
    const referencedRun = event.entityRefs.runId
      ? this.store.state.runs[event.entityRefs.runId]
      : undefined;
    if (!taskId && referencedRun) taskId = referencedRun.taskId;
    if (!taskId && event.entityRefs.agentId) {
      const agent = this.store.state.agents[event.entityRefs.agentId];
      const run = agent?.currentRunId
        ? this.store.state.runs[agent.currentRunId]
        : undefined;
      taskId = run?.taskId;
    }
    if (!taskId) return;
    const task = this.store.state.tasks[taskId];
    const compact = task?.project?.compact as
      { workflowDigest?: unknown; transcriptPolicy?: unknown } | undefined;
    if (
      !task ||
      !compact ||
      !/^[a-f0-9]{64}$/u.test(String(compact.workflowDigest)) ||
      compact.transcriptPolicy !== "retain-tab" ||
      !task.workflowId ||
      !task.currentRunId
    )
      return;
    const run = this.store.state.runs[task.currentRunId];
    const agent = run?.agentId
      ? this.store.state.agents[run.agentId]
      : undefined;
    const resource = run?.agentId
      ? this.store.state.herdrResources?.[run.agentId]
      : undefined;
    const workspaceId = resource?.workspaceId ?? agent?.workspaceId;
    const tabId = resource?.tabId ?? agent?.tabId;
    const paneId = resource?.paneId ?? agent?.paneId;
    const terminalId = resource?.terminalId ?? agent?.terminalId;
    const sessionId = resource?.sessionId ?? agent?.piSessionId;
    if (
      !run ||
      !agent ||
      !workspaceId ||
      !tabId ||
      !paneId ||
      !terminalId ||
      !sessionId ||
      !task.profileId
    )
      return;
    const current = Object.values(this.store.state.herdrMetadata ?? {}).find(
      (item) => item.taskId === task.id && item.runId === run.id,
    );
    if (current?.state === "closed") return;
    const terminalState = new Map<string, HerdrMetadataState>([
      ["succeeded", "completed"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
      ["timed_out", "failed"],
    ]);
    const terminalOutcome = terminalState.get(task.state);
    const terminal = terminalOutcome !== undefined;
    const state =
      terminal && !current?.exitedAt
        ? "settled"
        : (terminalOutcome ??
          (run.state === "result_pending" ||
          run.state === "result_pending_missing"
            ? "settling"
            : run.settled
              ? "settled"
              : run.state === "blocked" || task.state === "blocked"
                ? "blocked"
                : task.state === "provisioning"
                  ? "creating"
                  : task.state === "assigned"
                    ? "starting"
                    : "working"));
    const result = Object.values(this.store.state.results ?? {}).find(
      (item) => item.taskId === task.id && item.runId === run.id,
    );
    const question = Object.values(this.store.state.questions ?? {})
      .filter((item) => item.taskId === task.id && item.runId === run.id)
      .sort((left, right) => left.id.localeCompare(right.id))
      .at(-1);
    const updatedAt = new Date(this.#now()).toISOString();
    const metadataId =
      current?.metadataId ??
      `hmd_${sha256(`${task.id}:${run.id}`).slice(0, 26)}`;
    const exitedAt = current?.exitedAt ?? null;
    const value: Omit<HerdrTaskMetadata, "metadataDigest"> = {
      schemaVersion: 1,
      metadataId,
      orchestrationId: `orc_${sha256(this.paths.sessionKey).slice(0, 26)}`,
      workflowId: task.workflowId,
      taskId: task.id,
      runId: run.id,
      agentId: agent.id,
      ...(task.parentAgentId ? { parentAgentId: task.parentAgentId } : {}),
      profileId: task.profileId,
      state,
      placement: "background",
      transcriptPolicy: "retain-tab",
      workspaceId,
      tabId,
      paneId,
      terminalId,
      piSessionRef: `pis_${sha256(sessionId).slice(0, 26)}`,
      startedAt: current?.startedAt ?? task.createdAt,
      updatedAt,
      settledAt: run.settled ? (current?.settledAt ?? updatedAt) : null,
      exitedAt,
      transcriptRef: current?.transcriptRef ?? null,
      resultRef: result?.id ?? null,
      questionRef: question?.id ?? null,
      errorCode: task.terminalReason?.code ?? null,
    };
    const appendProjection = async (
      projection: Omit<HerdrTaskMetadata, "metadataDigest">,
    ): Promise<StoredEvent> =>
      await this.store.append({
        type: "herdr.metadata_projected",
        actor: {
          principalId: "prn_00000000000000000000000000",
          kind: "system",
        },
        entityRefs: {
          workflowId: task.workflowId!,
          taskId: task.id,
          runId: run.id,
          agentId: agent.id,
          workflowDigest: String(compact.workflowDigest),
        },
        payload: {
          ...projection,
          metadataDigest: sha256(canonicalJson(projection)),
        },
      });
    const semantic = (item: Omit<HerdrTaskMetadata, "metadataDigest">) =>
      canonicalJson({ ...item, updatedAt: "" });
    if (!current || semantic(value) !== semantic(current) || forcePublication) {
      const projectedEvent = await appendProjection(value);
      if (
        !value.exitedAt &&
        this.#herdr &&
        !(terminal && current?.state === "settled" && !current.exitedAt)
      )
        try {
          await this.#herdr.reportTaskMetadata(
            { workspaceId, tabId, paneId, terminalId, sessionId },
            this.store.state.herdrMetadata![metadataId]!,
            projectedEvent.seq,
          );
        } catch (error) {
          await appendProjection({
            ...value,
            state: "conflict",
            updatedAt: new Date(this.#now()).toISOString(),
            errorCode: "HERDR_METADATA_PUBLICATION_FAILED",
          });
          throw error;
        }
    }
    const latest = this.store.state.herdrMetadata?.[metadataId];
    if (terminal && !latest?.exitedAt && !this.#herdr) {
      await appendProjection({
        ...value,
        state: "orphaned",
        updatedAt: new Date(this.#now()).toISOString(),
        errorCode: "HERDR_UNAVAILABLE",
      });
      return;
    }
    if (terminal && !latest?.exitedAt && this.#herdr) {
      try {
        await this.#herdr.exitRetainingTab({
          workspaceId,
          tabId,
          paneId,
          terminalId,
          sessionId,
        });
      } catch (error) {
        await appendProjection({
          ...value,
          state: "orphaned",
          updatedAt: new Date(this.#now()).toISOString(),
          errorCode: "HERDR_PROCESS_EXIT_FAILED",
        });
        throw error;
      }
      const finalTime = new Date(this.#now()).toISOString();
      await appendProjection({
        ...value,
        state: terminalOutcome!,
        updatedAt: finalTime,
        settledAt: value.settledAt ?? finalTime,
        exitedAt: finalTime,
        transcriptRef: `trn_${sha256(`${metadataId}:${sessionId}`).slice(0, 26)}`,
      });
    }
  }
  #isDescendantSync(
    parentAgentId: string | undefined,
    targetAgentId: string,
  ): boolean {
    if (!parentAgentId) return false;
    let current: string | undefined = targetAgentId;
    const seen = new Set<string>();
    for (let depth = 0; depth <= 4 && current; depth++) {
      if (current === parentAgentId) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      current = this.store.state.agents[current]?.parentAgentId;
    }
    return false;
  }
  async #isDescendant(
    parentAgentId: string | undefined,
    targetAgentId: string,
  ): Promise<boolean> {
    return this.#isDescendantSync(parentAgentId, targetAgentId);
  }
  #operator(principal: Principal): boolean {
    return principal.kind !== "pi_parent" && principal.kind !== "pi_child";
  }
  #canAccessAgentSync(principal: Principal, agentId: string): boolean {
    return (
      this.#operator(principal) ||
      principal.agentId === agentId ||
      this.#isDescendantSync(principal.agentId, agentId)
    );
  }
  #canPeerAskAgent(principal: Principal, targetAgentId: string): boolean {
    if (this.#canAccessAgentSync(principal, targetAgentId)) return true;
    const sourceId = principal.agentId;
    const source = sourceId ? this.store.state.agents[sourceId] : undefined;
    const target = this.store.state.agents[targetAgentId];
    if (!source || !target) return false;
    const sameProject =
      (!!source.workspaceId && source.workspaceId === target.workspaceId) ||
      (!!source.cwd && source.cwd === target.cwd);
    const sameGroup = Object.values(this.store.state.groups ?? {}).some(
      (group) =>
        group.state === "open" &&
        group.agentIds.includes(source.id) &&
        group.agentIds.includes(target.id),
    );
    return sameProject || sameGroup;
  }
  #canAccessTaskSync(principal: Principal, taskId: string): boolean {
    if (this.#operator(principal)) return true;
    const task = this.store.state.tasks[taskId];
    if (!task) return false;
    return (
      principal.agentId === task.parentAgentId ||
      (!!task.assignedAgentId &&
        this.#isDescendantSync(principal.agentId, task.assignedAgentId))
    );
  }
  #eventVisible(
    principal: Principal,
    event: import("../state/types.js").StoredEvent,
  ): boolean {
    if (this.#operator(principal)) return true;
    if (event.type.startsWith("audit.")) return false;
    const refs = event.entityRefs ?? {};
    if (refs.agentId) return this.#canAccessAgentSync(principal, refs.agentId);
    if (refs.taskId) return this.#canAccessTaskSync(principal, refs.taskId);
    if (refs.runId) {
      const run = this.store.state.runs[refs.runId];
      return !!run?.agentId && this.#canAccessAgentSync(principal, run.agentId);
    }
    if (refs.resultId) {
      const item = this.store.state.results?.[refs.resultId];
      return !!item && this.#canAccessTaskSync(principal, item.taskId);
    }
    if (refs.questionId) {
      const item = this.store.state.questions?.[refs.questionId];
      return !!item && this.#canAccessAgentSync(principal, item.agentId);
    }
    if (refs.workflowId) {
      const item = this.store.state.workflows[refs.workflowId];
      if (
        item &&
        item.taskIds.some((taskId) =>
          this.#canAccessTaskSync(principal, taskId),
        )
      )
        return true;
      const parentAgentId = (
        event.payload as Record<string, unknown> | undefined
      )?.parentAgentId;
      return (
        safeText(parentAgentId) &&
        this.#canAccessAgentSync(principal, parentAgentId)
      );
    }
    return false;
  }
  async #canAccessAgent(
    principal: Principal,
    agentId: string,
  ): Promise<boolean> {
    return this.#canAccessAgentSync(principal, agentId);
  }
  async #canAccessTask(principal: Principal, taskId: string): Promise<boolean> {
    return this.#canAccessTaskSync(principal, taskId);
  }
  async #cancelExactRun(run: import("../state/types.js").Run): Promise<void> {
    const agent = run.agentId
      ? this.store.state.agents[run.agentId]
      : undefined;
    if (
      !agent ||
      !run.agentId ||
      agent.currentRunId !== run.id ||
      agent.generation !== (run.agentGeneration ?? agent.generation)
    )
      return;
    const resourceBefore = this.store.state.herdrResources?.[run.agentId];
    const agentBefore = {
      paneId: agent.paneId,
      terminalId: agent.terminalId,
      piSessionId: agent.piSessionId,
      generation: agent.generation,
      connectionGeneration: agent.connectionGeneration,
      currentRunId: agent.currentRunId,
    };
    const resourceValidBefore =
      !!resourceBefore?.paneId &&
      resourceBefore.agentId === run.agentId &&
      resourceBefore.generation === agent.generation &&
      agent.paneId === resourceBefore.paneId &&
      agent.terminalId === resourceBefore.terminalId &&
      agent.piSessionId === resourceBefore.sessionId;
    const resourceBytesBefore =
      resourceValidBefore && resourceBefore
        ? canonicalJson(resourceBefore)
        : undefined;
    const resourceTupleBefore = resourceBefore
      ? {
          paneId: resourceBefore.paneId,
          terminalId: resourceBefore.terminalId,
          sessionId: resourceBefore.sessionId,
          generation: resourceBefore.generation,
          replaced: resourceBefore.replaced,
          orphaned: resourceBefore.orphaned,
        }
      : undefined;
    const expected = {
      generation: agent.generation,
      ...(agent.connectionGeneration !== undefined
        ? { connectionGeneration: agent.connectionGeneration }
        : {}),
      ...(agent.piSessionId ? { piSessionId: agent.piSessionId } : {}),
      runId: run.id,
    };
    let adapterError: unknown;
    try {
      const result = await this.#sendAdapterRequest(
        run.agentId,
        "control.abort",
        {},
        expected,
        ADAPTER_ABORT_TIMEOUT_MS,
      );
      if (
        result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        Object.keys(result).length === 1 &&
        (result as Record<string, unknown>).ok === true
      )
        return;
      adapterError = new OrchestratorError(
        "PI_COMMAND_REJECTED",
        "The managed adapter returned an invalid abort response.",
      );
    } catch (error) {
      adapterError = error;
    }
    const unexpectedAdapterError = !isAbortFallbackError(adapterError)
      ? adapterError
      : undefined;
    const current = this.store.state.agents[run.agentId];
    const resource = this.store.state.herdrResources?.[run.agentId];
    const agentUnchanged =
      !!current &&
      current.currentRunId === agentBefore.currentRunId &&
      current.generation === agentBefore.generation &&
      current.connectionGeneration === agentBefore.connectionGeneration &&
      current.paneId === agentBefore.paneId &&
      current.terminalId === agentBefore.terminalId &&
      current.piSessionId === agentBefore.piSessionId;
    const resourceUnchanged =
      !!resource &&
      !!resourceTupleBefore &&
      resource.agentId === run.agentId &&
      resource.paneId === resourceTupleBefore.paneId &&
      resource.terminalId === resourceTupleBefore.terminalId &&
      resource.sessionId === resourceTupleBefore.sessionId &&
      resource.generation === resourceTupleBefore.generation &&
      resource.replaced === resourceTupleBefore.replaced &&
      resource.orphaned === resourceTupleBefore.orphaned &&
      resourceBytesBefore !== undefined &&
      canonicalJson(resource) === resourceBytesBefore;
    const fallbackSafe =
      !!this.#herdr &&
      agentUnchanged &&
      resourceValidBefore &&
      resourceUnchanged &&
      !resourceTupleBefore?.replaced &&
      !resourceTupleBefore?.orphaned;
    if (!fallbackSafe) {
      if (unexpectedAdapterError !== undefined) throw unexpectedAdapterError;
      return;
    }
    try {
      await this.#herdr!.stop({
        paneId: resource!.paneId,
        ...(resource!.terminalId ? { terminalId: resource!.terminalId } : {}),
        ...(resource!.sessionId ? { sessionId: resource!.sessionId } : {}),
        ...(resource!.generation !== undefined
          ? { generation: resource!.generation }
          : {}),
      } as never);
    } catch (fallbackError) {
      if (unexpectedAdapterError !== undefined)
        throw new AggregateError(
          [unexpectedAdapterError, fallbackError],
          "Adapter abort and Herdr fallback failed.",
        );
      throw fallbackError;
    }
    if (unexpectedAdapterError !== undefined) throw unexpectedAdapterError;
  }
  async #terminalizeTaskDeadline(taskId: string): Promise<void> {
    const task = this.store.state.tasks[taskId];
    if (!task || isTerminal(task.state)) return;
    const run = task.currentRunId
      ? this.store.state.runs[task.currentRunId]
      : undefined;
    const actor = {
      principalId: "prn_00000000000000000000000000",
      kind: "system" as const,
    };
    if (run) {
      const shouldCancelRun = !isRunClosedForAdapterProgress(run.state);
      const cancelledQuestions: QuestionRecord[] = [];
      for (const question of Object.values(this.store.state.questions ?? {})) {
        if (question.taskId !== task.id || question.state !== "open") continue;
        await this.store.append({
          type: "question.cancelled",
          actor,
          entityRefs: {
            questionId: question.id,
            taskId: question.taskId,
            runId: question.runId,
          },
          payload: {
            questionId: question.id,
          },
        });
        cancelledQuestions.push(question);
      }
      await this.store.append({
        type: "run.state_changed",
        actor,
        entityRefs: { runId: run.id, taskId: task.id },
        payload: {
          runId: run.id,
          state: "timed_out",
          reason: WALL_TIMEOUT_REASON,
        },
      });
      const deliveries = cancelledQuestions.map((question) =>
        this.#deferQuestionDelivery(
          this.store.state.questions?.[question.id] ?? question,
          "cancelled",
        )().catch((error: unknown) => {
          this.#observeAdapterDeliveryFailure(error);
        }),
      );
      const cancellation = shouldCancelRun
        ? this.#cancelExactRun(run)
        : Promise.resolve();
      const outcomes = await Promise.allSettled([...deliveries, cancellation]);
      for (const outcome of outcomes)
        if (outcome.status === "rejected")
          this.#observeBackgroundFailure(outcome.reason);
    } else {
      await this.store.append({
        type: "task.state_changed",
        actor,
        entityRefs: { taskId: task.id },
        payload: { to: "timed_out", reason: WALL_TIMEOUT_REASON },
      });
    }
    this.#clearTaskDeadline(task.id);
  }
  #scheduleTaskDeadline(task: {
    id: string;
    state: string;
    timeoutAt?: string;
  }): void {
    if (
      isTerminal(task.state) ||
      !task.timeoutAt ||
      this.#deadlineTimers.has(task.id)
    )
      return;
    const deadline = Date.parse(task.timeoutAt);
    if (!Number.isFinite(deadline)) return;
    const timer = this.#setTimeout(
      () => {
        this.#deadlineTimers.delete(task.id);
        void this.#enqueueMutation(() =>
          this.#terminalizeTaskDeadline(task.id),
        ).catch((error: unknown) => this.#observeBackgroundFailure(error));
      },
      Math.max(0, deadline - this.#now()),
    );
    timer.unref();
    this.#deadlineTimers.set(task.id, timer);
  }
  #clearTaskDeadline(taskId: string): void {
    const timer = this.#deadlineTimers.get(taskId);
    if (timer) this.#clearTimeout(timer);
    this.#deadlineTimers.delete(taskId);
  }
  async #terminalizeQuestionTimeout(questionId: string): Promise<void> {
    const current = this.store.state.questions?.[questionId];
    if (!current || current.state !== "open") return;
    const activeRun = this.store.state.runs[current.runId];
    const actor = {
      principalId: "prn_00000000000000000000000000",
      kind: "system" as const,
    };
    await this.store.append({
      type: "question.timed_out",
      actor,
      entityRefs: {
        questionId: current.id,
        taskId: current.taskId,
        runId: current.runId,
      },
      payload: { questionId: current.id },
    });
    await this.store.append({
      type: "run.state_changed",
      actor,
      entityRefs: { runId: current.runId, taskId: current.taskId },
      payload: { runId: current.runId, state: "failed" },
    });
    const deliverTimeout = this.#deferQuestionDelivery(
      this.store.state.questions?.[current.id] ?? current,
      "timed_out",
    );
    const delivery = deliverTimeout().catch((error: unknown) => {
      this.#observeAdapterDeliveryFailure(error);
    });
    const cancellation =
      activeRun?.agentId && !isRunClosedForAdapterProgress(activeRun.state)
        ? this.#cancelExactRun(activeRun)
        : Promise.resolve();
    const outcomes = await Promise.allSettled([delivery, cancellation]);
    for (const outcome of outcomes)
      if (outcome.status === "rejected")
        this.#observeBackgroundFailure(outcome.reason);
  }
  #scheduleQuestionTimeout(question: QuestionRecord): void {
    if (question.state !== "open" || this.#questionTimers.has(question.id))
      return;
    const payload = question.payload as { timeoutMs?: unknown } | undefined;
    const timeoutMs =
      typeof payload?.timeoutMs === "number" &&
      Number.isSafeInteger(payload.timeoutMs)
        ? payload.timeoutMs
        : 300_000;
    const askedAt = question.askedAt ? Date.parse(question.askedAt) : NaN;
    const deadline = Number.isFinite(askedAt)
      ? askedAt + timeoutMs
      : this.#now() + timeoutMs;
    const timer = this.#setTimeout(
      () => {
        this.#questionTimers.delete(question.id);
        void this.#enqueueMutation(() =>
          this.#terminalizeQuestionTimeout(question.id),
        ).catch((error: unknown) => this.#observeBackgroundFailure(error));
      },
      Math.max(0, deadline - this.#now()),
    );
    timer.unref();
    this.#questionTimers.set(question.id, timer);
  }
  #deferQuestionDelivery(
    question: QuestionRecord,
    state: "answered" | "cancelled" | "timed_out",
    answer?: { optionId: string | null; text: string | null },
  ): () => Promise<void> {
    return async () => {
      const timer = this.#questionTimers.get(question.id);
      if (timer) {
        this.#clearTimeout(timer);
        this.#questionTimers.delete(question.id);
      }
      const agent = this.store.state.agents[question.agentId];
      const assignmentGeneration = question.assignmentGeneration;
      const run = this.store.state.runs[question.runId];
      if (
        assignmentGeneration === undefined ||
        !agent ||
        !run ||
        run.agentId !== question.agentId ||
        run.assignmentGeneration !== assignmentGeneration ||
        agent.currentRunId !== question.runId ||
        agent.currentAssignmentGeneration !== assignmentGeneration
      ) {
        this.#queueAudit("question_terminal_delivery_stale");
        return;
      }
      const connected = [...this.#clients].some(
        (item) =>
          item.principal?.kind === "pi_child" &&
          item.principal.agentId === question.agentId,
      );
      if (!agent || !question.toolCallId) return;
      if (!connected) {
        if (state === "cancelled" || state === "timed_out")
          this.#queueAudit("question_terminal_delivery_rejected");
        return;
      }
      const delivered = await this.#sendAdapterRequest(
        question.agentId,
        "question.deliver_answer",
        {
          questionId: question.id,
          runId: question.runId,
          toolCallId: question.toolCallId,
          state,
          ...(answer ? { answer } : {}),
        },
        {
          generation: agent.generation,
          ...(agent.connectionGeneration !== undefined
            ? { connectionGeneration: agent.connectionGeneration }
            : {}),
          ...(agent.piSessionId ? { piSessionId: agent.piSessionId } : {}),
          assignmentGeneration,
          runId: question.runId,
        },
      );
      if (
        !delivered ||
        typeof delivered !== "object" ||
        Object.keys(delivered as object).length !== 1 ||
        (delivered as Record<string, unknown>).accepted !== true
      )
        this.#queueAudit("question_terminal_delivery_rejected");
    };
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
    const agent = this.store.state.agents[agentId];
    const clients = [...this.#clients].filter(
      (item) =>
        !item.socket.destroyed &&
        item.principal?.kind === "pi_child" &&
        item.principal.agentId === agentId &&
        item.managedConnectionGeneration === agent?.connectionGeneration,
    );
    const client = clients.length === 1 ? clients[0] : undefined;
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
      params: method.startsWith("control.")
        ? {
            ...params,
            agentId,
            generation: expected.generation,
            ...(expected.connectionGeneration !== undefined
              ? { connectionGeneration: expected.connectionGeneration }
              : {}),
            ...(expected.piSessionId
              ? { piSessionId: expected.piSessionId }
              : {}),
          }
        : {
            ...params,
            expected:
              method === "assignment.deliver"
                ? {
                    piSessionId: expected.piSessionId,
                    activity: "idle",
                    connectionGeneration: expected.connectionGeneration,
                  }
                : {
                    agentId,
                    generation: expected.generation,
                    ...(expected.connectionGeneration !== undefined
                      ? {
                          connectionGeneration: expected.connectionGeneration,
                        }
                      : {}),
                    ...(expected.assignmentGeneration !== undefined
                      ? {
                          assignmentGeneration: expected.assignmentGeneration,
                        }
                      : {}),
                    ...(expected.piSessionId
                      ? { piSessionId: expected.piSessionId }
                      : {}),
                    ...(expected.runId ? { runId: expected.runId } : {}),
                  },
          },
    };
    let pendingEntry!: PendingServerRequest;
    const pending = new Promise<unknown>((resolve, reject) => {
      const timer = this.#setTimeout(() => {
        if (client.serverRequests.get(id) !== pendingEntry) return;
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
      pendingEntry = { method, resolve, reject, timer };
      client.serverRequests.set(id, pendingEntry);
    });
    try {
      client.socket.write(encodeFrame(frame));
    } catch (error) {
      if (client.serverRequests.get(id) === pendingEntry) {
        client.serverRequests.delete(id);
        this.#clearTimeout(pendingEntry.timer);
      }
      // The private promise has no observer on this synchronous path. Throwing
      // the write/encode error keeps the public request rejection exact.
      throw error;
    }
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
  async #writeSnapshotBestEffort(): Promise<void> {
    try {
      await this.snapshotStore.write(this.store.state, this.#secret);
    } catch (error: unknown) {
      this.#observeBackgroundFailure(error);
    }
  }
  async #recordAudit(action: string): Promise<void> {
    await this.#enqueueMutation(async () => {
      if (this.store.readOnly) return;
      await this.store.append({
        type: "audit.action",
        actor: {
          principalId: "prn_00000000000000000000000000",
          kind: "system",
        },
        entityRefs: {},
        payload: { action },
      });
      await this.#writeSnapshotBestEffort();
    });
  }
  async #advanceWorkflow(
    workflowId: string,
    actor: { principalId: string; kind: string },
  ): Promise<void> {
    const previous = this.#advanceTail;
    let release!: () => void;
    this.#advanceTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.#advanceWorkflowUnlocked(workflowId, actor);
    } finally {
      release();
    }
  }
  async #advanceWorkflowUnlocked(
    workflowId: string,
    actor: { principalId: string; kind: string },
  ): Promise<void> {
    const workflow = this.store.state.workflows[workflowId];
    if (!workflow) return;
    for (const taskId of workflow.taskIds) {
      const task = this.store.state.tasks[taskId];
      const run = task?.currentRunId
        ? this.store.state.runs[task.currentRunId]
        : undefined;
      const published = run
        ? Object.values(this.store.state.results ?? {}).find(
            (candidate) => candidate.runId === run.id,
          )
        : undefined;
      if (run?.settled && !isTerminal(run.state) && published)
        await this.store.append({
          type: "run.state_changed",
          actor,
          entityRefs: { runId: run.id, taskId },
          payload: { runId: run.id, state: published.status },
        });
    }
    for (const taskId of workflow.taskIds) {
      const candidate = this.store.state.tasks[taskId];
      if (candidate?.isolationMode !== "reuse-worktree") continue;
      const dependencies = candidate.dependencies ?? [];
      if (dependencies.length !== 1)
        throw new OrchestratorError(
          "INVALID_REQUEST",
          "reuse-worktree requires exactly one dependency.",
        );
      const predecessor = this.store.state.tasks[dependencies[0]!];
      const predecessorRun = predecessor?.currentRunId
        ? this.store.state.runs[predecessor.currentRunId]
        : undefined;
      const resource = predecessorRun?.agentId
        ? this.store.state.herdrResources?.[predecessorRun.agentId]
        : undefined;
      if (candidate.state === "queued" && predecessor?.state === "succeeded") {
        const existingWorktreeId = candidate.project?.worktreeId;
        const existingWorktreePath = candidate.project?.cwd;
        if (
          (existingWorktreeId !== undefined &&
            !safeText(existingWorktreePath)) ||
          !resource ||
          !predecessorRun ||
          resource.ownerId !== predecessorRun.agentId ||
          !isRegisteredHerdrResourceState(resource.state) ||
          !safeText(resource.worktreeId) ||
          !safeText(resource.worktreePath) ||
          !safeText(resource.workspaceId) ||
          !candidate.project ||
          !safeText(candidate.project.workspaceId) ||
          resource.workspaceId !== candidate.project.workspaceId
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "The dependency worktree is missing or not owned by its succeeded task.",
          );
        if (
          existingWorktreeId !== undefined &&
          (existingWorktreeId !== resource.worktreeId ||
            existingWorktreePath !== resource.worktreePath ||
            candidate.project.isolation !==
              resolveWorkflowIsolation(
                candidate.profileId ?? "scout",
                candidate.isolationMode,
              ))
        )
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "The retained worktree binding does not match its predecessor.",
          );
        if (existingWorktreeId === undefined) {
          const project = {
            cwd: resource.worktreePath,
            workspaceId: candidate.project.workspaceId,
            worktreeId: resource.worktreeId,
            isolation: resolveWorkflowIsolation(
              candidate.profileId ?? "scout",
              candidate.isolationMode,
            ),
          };
          await this.store.append({
            type: "task.project_bound",
            actor,
            entityRefs: { taskId },
            payload: { taskId, project },
          });
        }
      }
    }
    const tasks = workflow.taskIds
      .map((id) => this.store.state.tasks[id])
      .filter((task): task is NonNullable<typeof task> => Boolean(task));
    const scheduler = new DeterministicScheduler();
    const plan = {
      workflowId,
      mode: "dag" as const,
      dryRun: false,
      steps: tasks.map((task) => ({
        key: task.id,
        taskId: task.id,
        profileId: task.profileId ?? "scout",
        objective: task.objective,
        constraints: task.constraints ?? [],
        dependsOn: task.dependencies ?? [],
        isolationMode: resolveWorkflowIsolation(
          task.profileId ?? "scout",
          task.isolationMode ?? task.project?.isolation,
        ),
      })),
      estimatedAgentCount: tasks.length,
      limits: {
        maxActiveAgents: scheduler.limits.maxActiveAgents,
        maxTasks: scheduler.limits.maxQueuedTasks,
      },
    };
    const states = new Map<
      string,
      {
        state:
          | "queued"
          | "running"
          | "succeeded"
          | "failed"
          | "blocked"
          | "cancelled"
          | "timed_out";
      }
    >(
      tasks.map((task) => [
        task.id,
        {
          state: (task.state === "assigned" || task.state === "provisioning"
            ? "running"
            : [
                  "queued",
                  "running",
                  "succeeded",
                  "failed",
                  "blocked",
                  "cancelled",
                  "timed_out",
                ].includes(task.state)
              ? task.state
              : "queued") as
            | "queued"
            | "running"
            | "succeeded"
            | "failed"
            | "blocked"
            | "cancelled"
            | "timed_out",
        },
      ]),
    );
    const readiness = workflowReadiness(plan, states);
    for (const task of readiness.blocked)
      if (this.store.state.tasks[task.taskId]?.state === "queued")
        await this.store.append({
          type: "task.state_changed",
          actor,
          entityRefs: { taskId: task.taskId },
          payload: { to: "blocked" },
        });
    for (const task of Object.values(this.store.state.tasks))
      if (
        task.state === "queued" &&
        task.timeoutAt &&
        Number.isFinite(Date.parse(task.timeoutAt)) &&
        Date.parse(task.timeoutAt) <= this.#now()
      )
        await this.#terminalizeTaskDeadline(task.id);
    const allTasks = Object.values(this.store.state.tasks);
    const depthOf = (parentAgentId: string | undefined): number => {
      let depth = 0;
      const seen = new Set<string>();
      let current = parentAgentId;
      while (current) {
        if (seen.has(current))
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Delegation ancestry contains a cycle.",
          );
        seen.add(current);
        const parent = this.store.state.agents[current];
        if (!parent)
          throw new OrchestratorError(
            "INVALID_REQUEST",
            "Delegation ancestry is missing.",
          );
        depth++;
        current = parent.parentAgentId;
      }
      return depth;
    };
    const queued = allTasks
      .filter((task) => task.state === "queued")
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
    const allowedQueued = new Set(
      queued.slice(0, scheduler.limits.maxQueuedTasks).map((task) => task.id),
    );
    const schedulable = allTasks.filter(
      (task) => task.state !== "queued" || allowedQueued.has(task.id),
    );
    const schedulerTasks = new Map<string, SchedulerTask>(
      schedulable.map((task, index) => [
        task.id,
        {
          id: task.id,
          parentAgentId: task.parentAgentId ?? "",
          profileId: task.profileId ?? "scout",
          priority: "normal",
          queuedAt: index,
          depth: depthOf(task.parentAgentId),
          dependencies: (task.dependencies ?? []).map((dependency) => ({
            taskId: dependency,
            requirement: "succeeded" as const,
          })),
          state: (task.state === "assigned"
            ? "running"
            : task.state) as SchedulerTask["state"],
        },
      ]),
    );
    const admitted = new Set(
      planAdmission(scheduler, schedulerTasks).admittedTaskIds,
    );
    for (const taskId of admitted) {
      const task = this.store.state.tasks[taskId];
      if (
        !task ||
        task.assignedAgentId ||
        !this.#herdr ||
        !scheduler.canProvision()
      )
        continue;
      const project = task.project;
      if (
        !project ||
        !safeText(project.cwd) ||
        !safeText(project.workspaceId) ||
        (project.isolation !== "worktree" &&
          project.isolation !== "shared-readonly")
      )
        throw new OrchestratorError(
          "INVALID_REQUEST",
          "The canonical task isolation is invalid.",
        );
      const isolation = resolveIsolation(
        task.profileId ?? "scout",
        project.isolation,
      );
      if (isolation !== project.isolation)
        throw new OrchestratorError(
          "PERMISSION_DENIED",
          "The canonical task isolation violates its profile policy.",
        );
      const replayPolicy = resolveSpawnPolicy(
        { taskProfileId: task.profileId ?? "scout" },
        this.#modelPolicy,
      );
      const storedEffectivePolicy = project.effectiveSpawnPolicy;
      const effectivePolicy =
        storedEffectivePolicy &&
        typeof storedEffectivePolicy === "object" &&
        !Array.isArray(storedEffectivePolicy)
          ? (storedEffectivePolicy as Record<string, unknown>)
          : replayPolicy.effective;
      const placement = effectivePolicy.placement;
      const modelProfileId = effectivePolicy.modelProfileId;
      if (
        (placement !== "current-workspace" && placement !== "new-workspace") ||
        (modelProfileId !== "manager" && modelProfileId !== "subagent")
      )
        throw new OrchestratorError(
          "INVALID_REQUEST",
          "The canonical task model policy is invalid.",
        );
      const effectiveModel = validateModelSelection(effectivePolicy.model);
      scheduler.setProvisioning(1);
      const agentId = createId("agt"),
        runId = createId("run"),
        assignmentId = createId("asg");
      await this.store.append({
        type: "agent.registered",
        actor,
        entityRefs: { agentId },
        payload: {
          agentId,
          managed: true,
          generation: 1,
          parentAgentId: task.parentAgentId,
          profileId: task.profileId,
          displayName: task.title,
          requestedModel:
            project.requestedSpawnPolicy ?? replayPolicy.requested,
          effectiveModel: {
            profileId: modelProfileId,
            placement,
            ...effectiveModel,
          },
          modelPolicyHash: safeText(project.modelPolicyHash, 64)
            ? project.modelPolicyHash
            : replayPolicy.policyHash,
        },
      });
      await this.store.append({
        type: "run.created",
        actor,
        entityRefs: { runId, taskId, agentId },
        payload: {
          runId,
          taskId,
          agentId,
          assignmentId,
          assignmentGeneration: 1,
          agentGeneration: 1,
          timeoutAt: task.timeoutAt,
        },
      });
      await this.store.append({
        type: "task.state_changed",
        actor,
        entityRefs: { taskId },
        payload: { to: "provisioning" },
      });
      try {
        const provisioned = await this.#herdr.provision({
          agentId,
          parentAgentId: task.parentAgentId ?? "",
          role: task.profileId ?? "scout",
          workspaceId: project.workspaceId,
          cwd: project.cwd,
          profileId: task.profileId ?? "scout",
          isolation,
          placement,
          model: effectiveModel,
          prompt: task.objective,
          ...(task.isolationMode === "reuse-worktree"
            ? {
                reuseWorktreeId: project.worktreeId as string,
                reuseWorktreePath: project.cwd,
              }
            : {}),
        });
        await this.store.append({
          type: "agent.state_changed",
          actor,
          entityRefs: { agentId },
          payload: {
            agentId,
            state: "starting",
            ...(provisioned.paneId ? { paneId: provisioned.paneId } : {}),
          },
        });
      } catch (error) {
        const compensationErrors: unknown[] = [];
        try {
          await this.store.append({
            type: "run.state_changed",
            actor,
            entityRefs: { runId, taskId },
            payload: { runId, state: "failed" },
          });
        } catch (compensationError) {
          compensationErrors.push(compensationError);
        }
        try {
          await this.store.append({
            type: "agent.state_changed",
            actor,
            entityRefs: { agentId },
            payload: {
              agentId,
              state: "replaced",
              reason: "PROVISION_FAILED",
            },
          });
        } catch (compensationError) {
          compensationErrors.push(compensationError);
        }
        if (
          error instanceof ProvisionOutcomeRecordingError ||
          compensationErrors.length > 0
        ) {
          const failures = [error, ...compensationErrors];
          this.#observeBackgroundFailure(
            failures.length === 1
              ? failures[0]
              : new AggregateError(
                  failures,
                  "Provisioning failure compensation failed.",
                ),
          );
        }
      } finally {
        scheduler.setProvisioning(-1);
      }
    }
    const finalTasks = workflow.taskIds
      .map((id) => this.store.state.tasks[id])
      .filter((task): task is NonNullable<typeof task> => Boolean(task));
    for (const task of finalTasks)
      if (
        task.state === "queued" &&
        (task.dependencies ?? []).some((dependency) =>
          ["failed", "cancelled", "timed_out", "blocked"].includes(
            this.store.state.tasks[dependency]?.state ?? "",
          ),
        )
      )
        await this.store.append({
          type: "task.state_changed",
          actor,
          entityRefs: { taskId: task.id },
          payload: { to: "blocked" },
        });
    const fanStates = new Map<
      string,
      {
        state:
          | "queued"
          | "running"
          | "succeeded"
          | "failed"
          | "blocked"
          | "cancelled"
          | "timed_out";
      }
    >(
      finalTasks.map((task) => [
        task.id,
        {
          state: (task.state === "assigned" || task.state === "provisioning"
            ? "running"
            : [
                  "queued",
                  "running",
                  "succeeded",
                  "failed",
                  "blocked",
                  "cancelled",
                  "timed_out",
                ].includes(task.state)
              ? task.state
              : "queued") as
            | "queued"
            | "running"
            | "succeeded"
            | "failed"
            | "blocked"
            | "cancelled"
            | "timed_out",
        },
      ]),
    );
    const fan = fanInWorkflow(plan, fanStates);
    const workflowState = fan.state === "queued" ? "running" : fan.state;
    if (workflow.state !== workflowState)
      await this.store.append({
        type: "workflow.state_changed",
        actor,
        entityRefs: { workflowId },
        payload: { workflowId, state: workflowState },
      });
  }
  #observeAdapterDeliveryFailure(error: unknown): void {
    // These are the only expected adapter-delivery outcomes at this boundary.
    if (!(
      error instanceof OrchestratorError &&
      [
        "AGENT_DISCONNECTED",
        "AGENT_REPLACED",
        "TIMEOUT",
        "PI_COMMAND_REJECTED",
        "RUN_MISMATCH",
      ].includes(error.code)
    ))
      this.#observeBackgroundFailure(error);
    this.#queueAudit("question_terminal_delivery_rejected");
  }
  #queueAudit(action: string): void {
    this.#trackDeferred(() => this.#recordAudit(action));
  }
  #failConnection(client: Client, action: string): void {
    this.#queueAudit(action);
    for (const pending of client.serverRequests.values()) {
      this.#clearTimeout(pending.timer);
      pending.reject(
        new OrchestratorError(
          "AGENT_DISCONNECTED",
          "The managed adapter connection closed.",
          { retryable: true },
        ),
      );
    }
    client.serverRequests.clear();
    client.slowClosed = true;
    client.socket.destroy();
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
