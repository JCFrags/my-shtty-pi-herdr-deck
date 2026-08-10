import { chmod, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { constants } from "node:fs";
import {
  createPrivateExclusive,
  readPrivateLines,
} from "../shared/private-fs.js";
import { createId, isEntityId } from "../shared/ids.js";
import { canonicalJson, sha256 } from "../shared/canonical-json.js";
import { OrchestratorError } from "../shared/errors.js";
import { emptyState, reduce } from "./reducer.js";
import type { EventInput, OrchestrationState, StoredEvent } from "./types.js";
import type { Snapshot } from "./snapshot-store.js";
const MAX_RETAINED_EVENTS = 1_000;
export class EventStore {
  readonly path: string;
  #state = emptyState();
  #events: StoredEvent[] = [];
  #lastSeq = 0;
  #lastHash = "0".repeat(64);
  #appendTail: Promise<void> = Promise.resolve();
  readonly #actor: { principalId: string; kind: string };
  readOnly = false;
  corruption: string | undefined;
  constructor(
    path: string,
    actor = { principalId: "prn_system", kind: "system" },
  ) {
    this.path = path;
    this.#actor = actor;
  }
  async open(snapshot?: Snapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      let index = 0;
      let previous: StoredEvent | undefined;
      if (snapshot) {
        if (
          snapshot.schemaVersion !== 1 ||
          snapshot.lastEventSeq < 0 ||
          snapshot.lastEventHash.length !== 64
        )
          throw new OrchestratorError(
            "STATE_CORRUPT",
            "Snapshot schema is invalid.",
          );
        if (snapshot.lastEventSeq === 0) this.#state = snapshot.state;
      }
      for await (const line of readPrivateLines(this.path)) {
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
        if (!snapshot || event.seq > snapshot.lastEventSeq)
          this.#state = reduce(this.#state, event);
        else if (event.seq === snapshot.lastEventSeq) {
          if (event.hash !== snapshot.lastEventHash)
            throw new OrchestratorError(
              "STATE_CORRUPT",
              "Snapshot cursor does not match the event chain.",
            );
          this.#state = snapshot.state;
        }
      }
      if (snapshot && this.#lastSeq < snapshot.lastEventSeq)
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Snapshot is ahead of the event log.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await createPrivateExclusive(this.path, "");
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
  async readEventsFrom(fromSeq: number): Promise<StoredEvent[]> {
    const result: StoredEvent[] = [];
    for await (const line of readPrivateLines(this.path)) {
      if (!line || line.endsWith("\r"))
        throw new OrchestratorError(
          "STATE_CORRUPT",
          "Noncanonical event line.",
        );
      const event = JSON.parse(line) as StoredEvent;
      if (event.seq > fromSeq) result.push(event);
    }
    return result;
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
        const handle = await open(
          this.path,
          constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          (process.getuid?.() !== undefined && stat.uid !== process.getuid())
        ) {
          await handle.close();
          throw new Error("Unsafe event log.");
        }
        try {
          await handle.write(`${canonicalJson(event)}\n`, undefined, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
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
    const actor = event.actor;
    const payload = event.payload as Record<string, unknown>;
    const taskStates = new Set(["queued", "cancelled"]);
    const known = new Set([
      "task.created",
      "task.state_changed",
      "audit.action",
      "audit.authorization_denied",
      "system.status_changed",
      "recovery.reconciled",
    ]);
    const refKeys = Object.keys(event.entityRefs);
    const timestampValid =
      typeof event.timestamp === "string" &&
      new Date(event.timestamp).toISOString() === event.timestamp;
    const actorValid =
      actor &&
      typeof actor.principalId === "string" &&
      (actor.principalId === "prn_system" ||
        actor.principalId === "prn_test" ||
        isEntityId(actor.principalId, "prn")) &&
      ["human", "cli", "deck", "observer", "system"].includes(actor.kind);
    let eventPayloadValid =
      known.has(event.type) &&
      !!payload &&
      typeof payload === "object" &&
      timestampValid &&
      !!actorValid;
    if (event.type === "task.created")
      eventPayloadValid =
        eventPayloadValid &&
        refKeys.length === 1 &&
        refKeys[0] === "taskId" &&
        isEntityId(event.entityRefs.taskId, "tsk") &&
        payload.id === event.entityRefs.taskId &&
        typeof payload.title === "string" &&
        payload.title.length <= 1024 &&
        typeof payload.objective === "string" &&
        payload.objective.length <= 262144 &&
        typeof payload.createdAt === "string" &&
        (!payload.idempotencyKey ||
          (typeof payload.idempotencyKey === "string" &&
            typeof payload.paramsHash === "string" &&
            payload.response !== undefined));
    if (event.type === "task.state_changed")
      eventPayloadValid =
        eventPayloadValid &&
        refKeys.length === 1 &&
        refKeys[0] === "taskId" &&
        isEntityId(event.entityRefs.taskId, "tsk") &&
        typeof payload.to === "string" &&
        taskStates.has(payload.to);
    if (
      event.type === "audit.action" ||
      event.type === "audit.authorization_denied"
    )
      eventPayloadValid =
        eventPayloadValid &&
        refKeys.length === 0 &&
        Object.keys(payload).length === 1 &&
        typeof payload.action === "string" &&
        payload.action.length <= 128;
    if (event.type === "run.created")
      eventPayloadValid =
        eventPayloadValid &&
        typeof payload.taskId === "string" &&
        Number.isSafeInteger(payload.assignmentGeneration) &&
        Number(payload.assignmentGeneration) >= 1;
    if (event.type === "result.published") {
      const result = payload.result as Record<string, unknown> | undefined;
      eventPayloadValid =
        eventPayloadValid &&
        typeof payload.taskId === "string" &&
        typeof payload.resultId === "string" &&
        !!result &&
        result.schemaVersion === 1 &&
        ["succeeded", "failed", "cancelled"].includes(String(result.status)) &&
        typeof result.summary === "string";
    }
    if (event.type === "idempotency.record")
      eventPayloadValid =
        eventPayloadValid &&
        typeof payload.key === "string" &&
        typeof payload.principalId === "string" &&
        typeof payload.method === "string";
    if (!eventPayloadValid)
      throw new OrchestratorError(
        "STATE_CORRUPT",
        `Event payload is invalid for ${event.type}.`,
      );
    if (
      !event ||
      event.schemaVersion !== 1 ||
      !Number.isSafeInteger(event.seq) ||
      typeof event.id !== "string" ||
      typeof event.timestamp !== "string" ||
      typeof event.type !== "string" ||
      !actor ||
      typeof actor.principalId !== "string" ||
      typeof actor.kind !== "string" ||
      !event.entityRefs ||
      typeof event.entityRefs !== "object" ||
      event.payload === undefined ||
      !/^[0-9a-f]{64}$/.test(event.prevHash) ||
      !/^[0-9a-f]{64}$/.test(event.hash) ||
      event.seq !== (previous?.seq ?? 0) + 1 ||
      event.prevHash !== (previous?.hash ?? "0".repeat(64)) ||
      event.hash !== sha256(canonicalJson({ ...event, hash: undefined }))
    )
      throw new OrchestratorError(
        "STATE_CORRUPT",
        `Event chain is invalid at sequence ${event.seq}.`,
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
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  const directory = await open(dirname(path), "r");
  await directory.sync();
  await directory.close();
  await chmod(path, 0o600);
}
