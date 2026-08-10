import { chmod, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { constants } from "node:fs";
import {
  createPrivateExclusive,
  readPrivateLines,
} from "../shared/private-fs.js";
import { createId } from "../shared/ids.js";
import { canonicalJson, sha256 } from "../shared/canonical-json.js";
import { OrchestratorError } from "../shared/errors.js";
import { emptyState, reduce } from "./reducer.js";
import type { EventInput, OrchestrationState, StoredEvent } from "./types.js";
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
  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      let index = 0;
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
        this.verifyEvent(event, this.#events.at(-1));
        this.#events.push(event);
        if (this.#events.length > MAX_RETAINED_EVENTS) this.#events.shift();
        this.#lastSeq = event.seq;
        this.#lastHash = event.hash;
        this.#state = reduce(this.#state, event);
      }
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
