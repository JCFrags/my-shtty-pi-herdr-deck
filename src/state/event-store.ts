import { lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import {
  createPrivateExclusive,
  openPrivateRegular,
  readPrivateLines,
} from "../shared/private-fs.js";
import { createId, isEntityId } from "../shared/ids.js";
import { canonicalJson, sha256 } from "../shared/canonical-json.js";
import { OrchestratorError } from "../shared/errors.js";
import { emptyState, reduce } from "./reducer.js";
import type {
  ErrorSummary,
  EventInput,
  OrchestrationState,
  StoredEvent,
} from "./types.js";
import type { Snapshot } from "./snapshot-store.js";
const MAX_RETAINED_EVENTS = 1_000;
const MAX_TASK_WALL_MS = 24 * 60 * 60_000;
function validDeadline(value: unknown, base: unknown): boolean {
  if (typeof value !== "string" || typeof base !== "string") return false;
  const parsed = Date.parse(value);
  const baseMs = Date.parse(base);
  return (
    Number.isFinite(parsed) &&
    Number.isFinite(baseMs) &&
    new Date(parsed).toISOString() === value &&
    parsed > baseMs &&
    parsed - baseMs <= MAX_TASK_WALL_MS
  );
}
function validDeadlineText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function validTaskProject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const project = value as Record<string, unknown>;
  const values =
    boundedText(project.cwd, 4096) && boundedText(project.workspaceId, 256);
  if (!values) return false;
  if (exactKeys(project, ["cwd", "workspaceId"])) return true;
  if (
    exactKeys(project, ["cwd", "workspaceId", "isolation"]) &&
    (project.isolation === "shared-readonly" ||
      project.isolation === "worktree")
  )
    return true;
  if (!exactKeys(project, ["cwd", "workspaceId", "worktreeId", "isolation"]))
    return false;
  return (
    boundedText(project.worktreeId, 256) &&
    (project.isolation === "shared-readonly" ||
      project.isolation === "worktree")
  );
}
const EVENT_KEYS = [
  "schemaVersion",
  "seq",
  "id",
  "timestamp",
  "type",
  "actor",
  "entityRefs",
  "payload",
  "prevHash",
  "hash",
] as const;
const ACTOR_KINDS = new Set([
  "human",
  "cli",
  "deck",
  "pi_parent",
  "pi_child",
  "observer",
  "system",
]);
const ERROR_SUMMARY_MESSAGES = new Map<string, string>([
  ["TIMEOUT", "The task wall deadline expired."],
  ["BUDGET_EXCEEDED", "The configured budget was exceeded."],
]);
function isErrorSummary(value: unknown): value is ErrorSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  return (
    exactKeys(summary, ["code", "message"]) &&
    typeof summary.code === "string" &&
    typeof summary.message === "string" &&
    ERROR_SUMMARY_MESSAGES.get(summary.code) === summary.message
  );
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}
function validTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  try {
    return new Date(parsed).toISOString() === value;
  } catch {
    return false;
  }
}
interface FileIdentity {
  dev: number;
  ino: number;
  uid: number;
  nlink: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
export class EventStore {
  readonly path: string;
  #state = emptyState();
  #events: StoredEvent[] = [];
  #lastSeq = 0;
  #lastHash = "0".repeat(64);
  #appendTail: Promise<void> = Promise.resolve();
  #fileIdentity: FileIdentity | undefined;
  readonly #actor: { principalId: string; kind: string };
  readonly #appendBoundary: (() => Promise<void>) | undefined;
  #replayReductionCount = 0;
  readonly #appendListeners = new Set<(event: StoredEvent) => void>();
  readOnly = false;
  corruption: string | undefined;
  constructor(
    path: string,
    actor = {
      principalId: "prn_00000000000000000000000000",
      kind: "system",
    },
    appendBoundary?: () => Promise<void>,
  ) {
    this.path = path;
    this.#actor = actor;
    this.#appendBoundary = appendBoundary;
  }
  async open(snapshot?: Snapshot): Promise<void> {
    this.#replayReductionCount = 0;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      let index = 0;
      let previous: StoredEvent | undefined;
      let openedFile: FileIdentity | undefined;
      if (snapshot) {
        if (
          snapshot.schemaVersion !== 1 ||
          snapshot.lastEventSeq < 0 ||
          snapshot.lastEventHash.length !== 64 ||
          snapshot.state.lastEventSeq !== snapshot.lastEventSeq ||
          snapshot.state.lastEventHash !== snapshot.lastEventHash
        )
          throw new OrchestratorError(
            "STATE_CORRUPT",
            "Snapshot schema or cursor is invalid.",
          );
        if (
          snapshot.lastEventSeq === 0 &&
          canonicalJson(snapshot.state) !== canonicalJson(emptyState())
        )
          throw new OrchestratorError(
            "STATE_CORRUPT",
            "Genesis snapshot state does not match the event chain.",
          );
        this.#state = snapshot.state;
      }
      for await (const line of readPrivateLines(this.path, (stat) => {
        openedFile = this.#identityFrom(stat);
      })) {
        if (!line || line.endsWith("\r"))
          throw new OrchestratorError(
            "STATE_CORRUPT",
            `Noncanonical event line at ${index + 1}.`,
          );
        let event: StoredEvent;
        try {
          event = JSON.parse(line) as StoredEvent;
        } catch {
          throw new OrchestratorError(
            "STATE_CORRUPT",
            `Invalid event at line ${index + 1}.`,
          );
        }
        index++;
        this.verifyEvent(event, previous);
        previous = event;
        this.#events.push(event);
        if (this.#events.length > MAX_RETAINED_EVENTS) this.#events.shift();
        this.#lastSeq = event.seq;
        this.#lastHash = event.hash;
        if (!snapshot || event.seq > snapshot.lastEventSeq) {
          this.#replayReductionCount++;
          this.#state = reduce(this.#state, event);
        } else if (
          event.seq === snapshot.lastEventSeq &&
          event.hash !== snapshot.lastEventHash
        )
          throw new OrchestratorError(
            "STATE_CORRUPT",
            "Snapshot cursor does not match the event chain.",
          );
      }
      if (snapshot && this.#lastSeq < snapshot.lastEventSeq)
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Snapshot is ahead of the event log.",
        );
      const closedFile = this.#identityFrom(await lstat(this.path));
      if (!openedFile || !this.#sameIdentity(openedFile, closedFile, true))
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Event log changed while it was opened.",
        );
      this.#fileIdentity = closedFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (snapshot && snapshot.lastEventSeq > 0) {
          this.readOnly = true;
          this.corruption = "Snapshot exists but its event log is missing.";
          return;
        }
        await createPrivateExclusive(this.path, "");
        await this.#captureFileIdentity();
        return;
      }
      if (
        error instanceof Error &&
        (error.message.includes("incomplete line") ||
          error.message.includes("line exceeds"))
      ) {
        this.readOnly = true;
        this.corruption = error.message.includes("exceeds")
          ? "Event log line exceeds the maximum size."
          : "Event log ends with an incomplete record.";
        return;
      }
      if (
        error instanceof OrchestratorError &&
        error.code === "STATE_CORRUPT"
      ) {
        this.readOnly = true;
        this.corruption = error.message;
        return;
      }
      throw error;
    }
  }
  get state(): OrchestrationState {
    return this.#state;
  }
  get events(): readonly StoredEvent[] {
    return this.#events;
  }
  get replayReductionCount(): number {
    return this.#replayReductionCount;
  }
  onAppend(listener: (event: StoredEvent) => void): () => void {
    this.#appendListeners.add(listener);
    return () => this.#appendListeners.delete(listener);
  }
  #identityFrom(stat: Stats): FileIdentity {
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0
    )
      throw new OrchestratorError("STATE_CORRUPT", "Event log file is unsafe.");
    return {
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      nlink: stat.nlink,
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  }
  #sameIdentity(
    expected: FileIdentity,
    actual: FileIdentity,
    includeContentMetadata: boolean,
  ): boolean {
    return (
      expected.dev === actual.dev &&
      expected.ino === actual.ino &&
      expected.uid === actual.uid &&
      expected.nlink === actual.nlink &&
      (expected.mode & 0o777) === (actual.mode & 0o777) &&
      (!includeContentMetadata ||
        (expected.size === actual.size &&
          expected.mtimeMs === actual.mtimeMs &&
          expected.ctimeMs === actual.ctimeMs))
    );
  }
  async #captureFileIdentity(): Promise<void> {
    const handle = await openPrivateRegular(this.path);
    try {
      this.#fileIdentity = this.#identityFrom(await handle.stat());
    } finally {
      await handle.close();
    }
  }
  async readEventsFrom(fromSeq: number): Promise<StoredEvent[]> {
    const result: StoredEvent[] = [];
    let previous: StoredEvent | undefined;
    const expectedFile = this.#fileIdentity;
    if (!expectedFile)
      throw new OrchestratorError(
        "STATE_CORRUPT",
        "Event log identity is unavailable.",
      );
    try {
      for await (const line of readPrivateLines(this.path, (stat) => {
        const current = this.#identityFrom(stat);
        if (!this.#sameIdentity(expectedFile, current, true))
          throw new OrchestratorError(
            "STATE_CORRUPT",
            "Event log path or contents changed after startup.",
          );
      })) {
        if (!line || line.endsWith("\r"))
          throw new OrchestratorError(
            "STATE_CORRUPT",
            "Noncanonical event line.",
          );
        let event: StoredEvent;
        try {
          event = JSON.parse(line) as StoredEvent;
        } catch {
          throw new OrchestratorError("STATE_CORRUPT", "Invalid event JSON.");
        }
        this.verifyEvent(event, previous);
        previous = event;
        if (event.seq > fromSeq) result.push(event);
      }
      const closedFile = this.#identityFrom(await lstat(this.path));
      if (
        !this.#sameIdentity(expectedFile, closedFile, true) ||
        (previous?.seq ?? 0) !== this.#lastSeq ||
        (previous?.hash ?? "0".repeat(64)) !== this.#lastHash
      )
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Event log changed after startup.",
        );
      return result;
    } catch (error) {
      this.readOnly = true;
      this.corruption =
        error instanceof Error
          ? error.message
          : "Event log verification failed.";
      throw new OrchestratorError(
        "STATE_CORRUPT",
        "Event log verification failed.",
      );
    }
  }
  async verifyDisk(): Promise<ReturnType<EventStore["verify"]>> {
    try {
      await this.readEventsFrom(Number.MAX_SAFE_INTEGER);
    } catch {
      // readEventsFrom records the safe recovery state.
    }
    return this.verify();
  }
  async append(input: EventInput): Promise<StoredEvent> {
    let result: StoredEvent | undefined;
    const operation = this.#appendTail
      .catch(() => undefined)
      .then(async () => {
        if (this.readOnly)
          throw new OrchestratorError(
            "BROKER_READ_ONLY",
            "State is in read-only recovery.",
          );
        const seq = this.#lastSeq + 1;
        const base = {
          schemaVersion: 1 as const,
          seq,
          id: createId("evt"),
          timestamp: new Date().toISOString(),
          type: input.type,
          actor: input.actor ?? this.#actor,
          entityRefs: input.entityRefs ?? {},
          payload: input.payload,
          prevHash: this.#lastHash,
        };
        const event = { ...base, hash: sha256(canonicalJson(base)) };
        this.verifyEvent(event, {
          seq: this.#lastSeq,
          hash: this.#lastHash,
        } as StoredEvent);
        const candidateState = reduce(this.#state, event);
        const eventLine = `${canonicalJson(event)}\n`;
        const expectedFile = this.#fileIdentity;
        try {
          if (!expectedFile) throw new Error("Event log identity is missing.");
          const handle = await open(
            this.path,
            constants.O_WRONLY |
              constants.O_APPEND |
              (constants.O_NOFOLLOW ?? 0),
            0o600,
          );
          try {
            const before = this.#identityFrom(await handle.stat());
            const pathBefore = this.#identityFrom(await lstat(this.path));
            if (
              !this.#sameIdentity(expectedFile, before, true) ||
              !this.#sameIdentity(expectedFile, pathBefore, true)
            )
              throw new Error("Event log changed before append.");
            await this.#appendBoundary?.();
            const written = await handle.write(eventLine, undefined, "utf8");
            if (written.bytesWritten !== Buffer.byteLength(eventLine))
              throw new Error("Event log append was incomplete.");
            await handle.sync();
            const after = this.#identityFrom(await handle.stat());
            const pathAfter = this.#identityFrom(await lstat(this.path));
            if (
              !this.#sameIdentity(expectedFile, after, false) ||
              after.size !== expectedFile.size + written.bytesWritten ||
              !this.#sameIdentity(after, pathAfter, true)
            )
              throw new Error("Event log changed during append.");
            this.#fileIdentity = after;
          } finally {
            await handle.close();
          }
        } catch (error) {
          this.readOnly = true;
          this.corruption = "A canonical event append failed.";
          throw new OrchestratorError(
            "BROKER_READ_ONLY",
            "Canonical event persistence failed; the store is read-only.",
            { retryable: false },
          );
        }
        this.#events.push(event);
        if (this.#events.length > MAX_RETAINED_EVENTS) this.#events.shift();
        this.#lastSeq = event.seq;
        this.#lastHash = event.hash;
        this.#state = candidateState;
        result = event;
        for (const listener of this.#appendListeners) {
          try {
            listener(event);
          } catch {
            // Observers cannot change the committed event result.
          }
        }
      });
    this.#appendTail = operation;
    await operation;
    return result!;
  }
  verify(): {
    valid: boolean;
    lastSeq: number;
    lastHash: string;
    readOnly: boolean;
    corruption?: string;
  } {
    return {
      valid: !this.corruption,
      lastSeq: this.#lastSeq,
      lastHash: this.#lastHash,
      readOnly: this.readOnly,
      ...(this.corruption ? { corruption: this.corruption } : {}),
    };
  }
  private verifyEvent(event: StoredEvent, previous?: StoredEvent): void {
    if (!event || typeof event !== "object" || Array.isArray(event))
      throw new OrchestratorError("STATE_CORRUPT", "Event must be an object.");
    const raw = event as unknown as Record<string, unknown>;
    const actor = event.actor;
    const refs = event.entityRefs;
    const payload = event.payload;
    const baseValid =
      exactKeys(raw, EVENT_KEYS) &&
      event.schemaVersion === 1 &&
      Number.isSafeInteger(event.seq) &&
      event.seq >= 1 &&
      isEntityId(event.id, "evt") &&
      validTimestamp(event.timestamp) &&
      typeof event.type === "string" &&
      !!actor &&
      typeof actor === "object" &&
      !Array.isArray(actor) &&
      exactKeys(actor as unknown as Record<string, unknown>, [
        "principalId",
        "kind",
      ]) &&
      isEntityId(actor.principalId, "prn") &&
      ACTOR_KINDS.has(actor.kind) &&
      !!refs &&
      typeof refs === "object" &&
      !Array.isArray(refs) &&
      !!payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      /^[0-9a-f]{64}$/.test(event.prevHash) &&
      /^[0-9a-f]{64}$/.test(event.hash) &&
      event.seq === (previous?.seq ?? 0) + 1 &&
      event.prevHash === (previous?.hash ?? "0".repeat(64)) &&
      event.hash === sha256(canonicalJson({ ...event, hash: undefined }));
    if (!baseValid)
      throw new OrchestratorError(
        "STATE_CORRUPT",
        `Event chain is invalid at sequence ${String(event.seq)}.`,
      );

    const p = payload as Record<string, unknown>;
    let valid = false;
    if (event.type === "task.created_m3") {
      const taskKeyVariants: string[][] = [];
      const optionalTaskKeys = [
        "parentAgentId",
        "workflowId",
        "profileId",
        "dependencies",
        "project",
        "isolationMode",
      ];
      for (let mask = 0; mask < 64; mask++)
        for (const hasTimeout of [false, true]) {
          const keys = ["taskId", "title", "objective", "createdAt"];
          if (hasTimeout) keys.push("timeoutAt");
          for (let index = 0; index < optionalTaskKeys.length; index++)
            if (mask & (1 << index)) keys.push(optionalTaskKeys[index]!);
          taskKeyVariants.push(keys);
        }
      valid =
        exactKeys(refs, ["taskId"]) &&
        isEntityId(refs.taskId, "tsk") &&
        taskKeyVariants.some((keys) => exactKeys(p, keys)) &&
        p.taskId === refs.taskId &&
        typeof p.title === "string" &&
        p.title.length > 0 &&
        p.title.length <= 256 &&
        typeof p.objective === "string" &&
        p.objective.length > 0 &&
        p.objective.length <= 65_536 &&
        validTimestamp(p.createdAt) &&
        (p.timeoutAt === undefined ||
          validDeadline(p.timeoutAt, p.createdAt)) &&
        (p.parentAgentId === undefined || isEntityId(p.parentAgentId, "agt")) &&
        (p.workflowId === undefined || isEntityId(p.workflowId, "wfl")) &&
        (p.profileId === undefined || boundedText(p.profileId, 256)) &&
        (p.isolationMode === undefined ||
          [
            "profile-default",
            "shared-readonly",
            "worktree",
            "shared-explicit",
            "reuse-worktree",
          ].includes(p.isolationMode as string)) &&
        (p.dependencies === undefined ||
          (Array.isArray(p.dependencies) &&
            p.dependencies.length <= 64 &&
            p.dependencies.every((id) => isEntityId(id, "tsk")))) &&
        (p.project === undefined || validTaskProject(p.project));
    } else if (event.type === "task.project_bound") {
      valid =
        exactKeys(refs, ["taskId"]) &&
        isEntityId(refs.taskId, "tsk") &&
        exactKeys(p, ["taskId", "project"]) &&
        p.taskId === refs.taskId &&
        validTaskProject(p.project);
    } else if (event.type === "run.created") {
      const runKeyVariants = [
        [
          "runId",
          "taskId",
          "agentId",
          "assignmentId",
          "assignmentGeneration",
          "agentGeneration",
        ],
        [
          "runId",
          "taskId",
          "agentId",
          "assignmentId",
          "assignmentGeneration",
          "agentGeneration",
          "timeoutAt",
        ],
        [
          "runId",
          "taskId",
          "agentId",
          "assignmentId",
          "assignmentGeneration",
          "agentGeneration",
          "piSessionId",
        ],
        [
          "runId",
          "taskId",
          "agentId",
          "assignmentId",
          "assignmentGeneration",
          "agentGeneration",
          "terminalId",
        ],
        [
          "runId",
          "taskId",
          "agentId",
          "assignmentId",
          "assignmentGeneration",
          "agentGeneration",
          "piSessionId",
          "terminalId",
        ],
        [
          "runId",
          "taskId",
          "agentId",
          "assignmentId",
          "assignmentGeneration",
          "agentGeneration",
          "timeoutAt",
          "piSessionId",
        ],
        [
          "runId",
          "taskId",
          "agentId",
          "assignmentId",
          "assignmentGeneration",
          "agentGeneration",
          "timeoutAt",
          "terminalId",
        ],
        [
          "runId",
          "taskId",
          "agentId",
          "assignmentId",
          "assignmentGeneration",
          "agentGeneration",
          "timeoutAt",
          "piSessionId",
          "terminalId",
        ],
      ];
      valid =
        exactKeys(refs, ["runId", "taskId", "agentId"]) &&
        isEntityId(refs.runId, "run") &&
        isEntityId(refs.taskId, "tsk") &&
        isEntityId(refs.agentId, "agt") &&
        runKeyVariants.some((keys) => exactKeys(p, keys)) &&
        p.runId === refs.runId &&
        p.taskId === refs.taskId &&
        p.agentId === refs.agentId &&
        isEntityId(p.assignmentId, "asg") &&
        Number.isSafeInteger(p.assignmentGeneration) &&
        Number(p.assignmentGeneration) >= 0 &&
        Number.isSafeInteger(p.agentGeneration) &&
        Number(p.agentGeneration) >= 0 &&
        (p.piSessionId === undefined || boundedText(p.piSessionId, 256)) &&
        (p.terminalId === undefined || boundedText(p.terminalId, 256)) &&
        (p.timeoutAt === undefined || validDeadlineText(p.timeoutAt));
    } else if (event.type === "task.created") {
      const basicKeys = ["id", "title", "objective", "createdAt"];
      const idempotentKeys = [
        ...basicKeys,
        "idempotencyKey",
        "paramsHash",
        "response",
      ];
      const response = p.response as Record<string, unknown> | undefined;
      const hasIdempotency = Object.hasOwn(p, "idempotencyKey");
      valid =
        exactKeys(refs, ["taskId"]) &&
        isEntityId(refs.taskId, "tsk") &&
        p.id === refs.taskId &&
        typeof p.title === "string" &&
        p.title.length > 0 &&
        p.title.length <= 256 &&
        typeof p.objective === "string" &&
        p.objective.length > 0 &&
        p.objective.length <= 65_536 &&
        validTimestamp(p.createdAt) &&
        ((!hasIdempotency && exactKeys(p, basicKeys)) ||
          (hasIdempotency &&
            exactKeys(p, idempotentKeys) &&
            typeof p.idempotencyKey === "string" &&
            p.idempotencyKey.length > 0 &&
            p.idempotencyKey.length <= 256 &&
            typeof p.paramsHash === "string" &&
            /^[0-9a-f]{64}$/.test(p.paramsHash) &&
            !!response &&
            typeof response === "object" &&
            !Array.isArray(response) &&
            exactKeys(response, ["taskId", "state"]) &&
            response.taskId === p.id &&
            response.state === "queued"));
    } else if (event.type === "task.state_changed") {
      valid =
        exactKeys(refs, ["taskId"]) &&
        isEntityId(refs.taskId, "tsk") &&
        (exactKeys(p, ["to"]) ||
          (exactKeys(p, ["to", "reason"]) &&
            p.to === "timed_out" &&
            isErrorSummary(p.reason) &&
            ["TIMEOUT", "BUDGET_EXCEEDED"].includes(
              (p.reason as ErrorSummary).code,
            ))) &&
        [
          "draft",
          "queued",
          "provisioning",
          "assigned",
          "running",
          "blocked",
          "collecting",
          "succeeded",
          "failed",
          "cancelled",
          "timed_out",
        ].includes(String(p.to));
    } else if (event.type === "run.state_changed") {
      valid =
        exactKeys(refs, ["runId", "taskId"]) &&
        isEntityId(refs.runId, "run") &&
        isEntityId(refs.taskId, "tsk") &&
        exactKeys(p, ["runId", "state"]) &&
        p.runId === refs.runId &&
        this.#state.runs[String(refs.runId)]?.taskId === refs.taskId &&
        [
          "created",
          "prompting",
          "working",
          "blocked",
          "result_pending",
          "result_pending_missing",
          "succeeded",
          "failed",
          "cancelled",
          "timed_out",
          "lost",
          "settled",
        ].includes(String(p.state));
      if (
        event.type === "run.state_changed" &&
        exactKeys(refs, ["runId", "taskId"]) &&
        exactKeys(p, ["runId", "state", "reason"])
      ) {
        valid =
          isEntityId(refs.runId, "run") &&
          isEntityId(refs.taskId, "tsk") &&
          p.runId === refs.runId &&
          this.#state.runs[String(refs.runId)]?.taskId === refs.taskId &&
          p.state === "timed_out" &&
          isErrorSummary(p.reason) &&
          ["TIMEOUT", "BUDGET_EXCEEDED"].includes(
            (p.reason as ErrorSummary).code,
          );
      }
    } else if (event.type === "herdr.provision.intent") {
      valid =
        exactKeys(refs, ["agentId"]) &&
        typeof refs.agentId === "string" &&
        exactKeys(p, ["agentId"]) &&
        p.agentId === refs.agentId;
    } else if (
      event.type === "herdr.provision.outcome" ||
      event.type === "herdr.reconciled"
    ) {
      valid =
        exactKeys(refs, ["agentId"]) &&
        typeof refs.agentId === "string" &&
        exactKeys(
          p,
          [
            "agentId",
            "state",
            "paneId",
            "tabId",
            "worktreeId",
            "worktreePath",
            "workspaceId",
            "reason",
            "terminalId",
            "sessionId",
            "generation",
            "parentAgentId",
            "ownerId",
            "tokenDigest",
            "promptFileDev",
            "promptFileIno",
            "tokenFileDev",
            "tokenFileIno",
            "registrationDeadline",
            "cleanupOutcome",
            "dirty",
            "replaced",
            "orphaned",
            "unknown",
            "parentGitRoot",
            "parentGitHead",
            "parentGitBranch",
            "parentGitChangedFiles",
            "worktreeGitRoot",
            "worktreeGitHead",
            "worktreeGitBranch",
          ].filter((key) => Object.hasOwn(p, key)),
        ) &&
        p.agentId === refs.agentId &&
        typeof p.state === "string" &&
        (Object.keys(p).every(
          (key) => !key.endsWith("FileDev") && !key.endsWith("FileIno"),
        ) ||
          [
            "promptFileDev",
            "promptFileIno",
            "tokenFileDev",
            "tokenFileIno",
          ].every(
            (key) => Number.isSafeInteger(p[key]) && Number(p[key]) >= 0,
          ));
    } else if (
      [
        "agent.registered",
        "agent.heartbeat",
        "agent.moved",
        "agent.state_changed",
        "agent.replaced",
        "task.created_m3",
        "task.project_bound",
        "run.created",
        "assignment.delivered",
        "assignment.accepted",
        "assignment.delivery_failed",
        "run.pi_started",
        "run.pi_settled",
        "run.state_changed",
        "task.cancel_requested",
        "result.published",
        "result.validated",
        "run.result_recovery_requested",
        "run.result_missing",
        "question.opened",
        "question.answered",
        "question.timed_out",
        "question.cancelled",
        "group.created",
        "group.stopped",
        "group.closed",
        "workflow.created",
        "workflow.state_changed",
        "scheduler.admitted",
        "scheduler.blocked",
        "task.collected",
      ].includes(event.type)
    ) {
      const refId =
        refs.agentId ??
        refs.taskId ??
        refs.runId ??
        refs.workflowId ??
        refs.resultId ??
        refs.questionId ??
        refs.groupId;
      valid =
        typeof refId === "string" &&
        Object.keys(p).every(
          (key) => key.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(key),
        );
    } else if (
      event.type === "audit.action" ||
      event.type === "audit.authorization_denied"
    ) {
      valid =
        exactKeys(refs, []) &&
        exactKeys(p, ["action"]) &&
        typeof p.action === "string" &&
        p.action.length > 0 &&
        p.action.length <= 128;
    }
    if (!valid)
      throw new OrchestratorError(
        "STATE_CORRUPT",
        `Event payload is invalid for ${event.type}.`,
      );
  }
}
export async function writeSnapshot(
  path: string,
  snapshot: unknown,
): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(
    tmp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${canonicalJson(snapshot)}\n`, "utf8");
    await handle.sync();
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("Snapshot temporary file is unsafe.");
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  const directory = await open(dirname(path), "r");
  await directory.sync();
  await directory.close();
}
