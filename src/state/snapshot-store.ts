import { createHmac, timingSafeEqual } from "node:crypto";
import { readPrivateRegular } from "../shared/private-fs.js";
import { canonicalJson, sha256 } from "../shared/canonical-json.js";
import { writeSnapshot } from "./event-store.js";
import type { OrchestrationState } from "./types.js";
export interface Snapshot {
  schemaVersion: 1;
  generatedAt: string;
  lastEventSeq: number;
  lastEventHash: string;
  state: OrchestrationState;
  checksum: string;
  authentication: string;
}
function authenticate(value: unknown, key: string): string {
  if (Buffer.byteLength(key) < 32)
    throw new Error("Snapshot authentication key is invalid.");
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex");
}
function equalDigest(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right))
    return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
export class SnapshotStore {
  constructor(readonly path: string) {}
  async write(state: OrchestrationState, key: string): Promise<void> {
    const base = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      lastEventSeq: state.lastEventSeq,
      lastEventHash: state.lastEventHash,
      state,
    };
    const checked = { ...base, checksum: sha256(canonicalJson(base)) };
    await writeSnapshot(this.path, {
      ...checked,
      authentication: authenticate(checked, key),
    });
  }
  async read(key: string): Promise<Snapshot | undefined> {
    try {
      const value = JSON.parse(await readPrivateRegular(this.path)) as Snapshot;
      const { authentication, checksum, ...base } = value;
      const keys = Object.keys(value as unknown as Record<string, unknown>);
      const expectedKeys = [
        "schemaVersion",
        "generatedAt",
        "lastEventSeq",
        "lastEventHash",
        "state",
        "checksum",
        "authentication",
      ];
      const generated = Date.parse(value.generatedAt);
      const checked = { ...base, checksum };
      if (
        keys.length !== expectedKeys.length ||
        keys.some((field) => !expectedKeys.includes(field)) ||
        value.schemaVersion !== 1 ||
        !Number.isSafeInteger(value.lastEventSeq) ||
        value.lastEventSeq < 0 ||
        !/^[0-9a-f]{64}$/.test(value.lastEventHash) ||
        !Number.isFinite(generated) ||
        new Date(generated).toISOString() !== value.generatedAt ||
        !value.state ||
        value.state.schemaVersion !== 1 ||
        !equalDigest(checksum, sha256(canonicalJson(base))) ||
        !equalDigest(authentication, authenticate(checked, key)) ||
        value.lastEventSeq !== value.state.lastEventSeq ||
        value.lastEventHash !== value.state.lastEventHash
      )
        throw new Error("Snapshot verification failed.");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
