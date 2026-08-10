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
}
export class SnapshotStore {
  constructor(readonly path: string) {}
  async write(state: OrchestrationState): Promise<void> {
    const base = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      lastEventSeq: state.lastEventSeq,
      lastEventHash: state.lastEventHash,
      state,
    };
    await writeSnapshot(this.path, {
      ...base,
      checksum: sha256(canonicalJson(base)),
    });
  }
  async read(): Promise<Snapshot | undefined> {
    try {
      const value = JSON.parse(await readPrivateRegular(this.path)) as Snapshot;
      const { checksum, ...base } = value;
      if (
        value.schemaVersion !== 1 ||
        !value.state ||
        checksum !== sha256(canonicalJson(base)) ||
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
