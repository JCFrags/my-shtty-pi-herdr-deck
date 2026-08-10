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
import type { EventInput, OrchestrationState, StoredEvent } from "./types.js";
import type { Snapshot } from "./snapshot-store.js";
const MAX_RETAINED_EVENTS = 1_000;
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
    if (event.type === "task.created") {
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
        exactKeys(p, ["to"]) &&
        (p.to === "queued" || p.to === "cancelled");
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
            "reason",
            "terminalId",
            "sessionId",
            "generation",
            "parentAgentId",
            "ownerId",
            "tokenDigest",
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
        typeof p.state === "string";
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
