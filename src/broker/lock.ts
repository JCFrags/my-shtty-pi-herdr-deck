import { constants, readFileSync } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";

export interface LockIdentity {
  dev: number;
  ino: number;
  uid: number;
  nonce: string;
  pid: number;
  startIdentity: string;
  expectedSocket: string;
}
interface LockRecord {
  pid: number;
  nonce: string;
  startIdentity: string;
  expectedSocket: string;
}
const noFollow =
  (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
function processStart(pid: number): string | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = text.lastIndexOf(") ");
    if (end < 0) return undefined;
    return text
      .slice(end + 2)
      .trim()
      .split(/\s+/)[19];
  } catch {
    return undefined;
  }
}
function currentStart(): string {
  const value = processStart(process.pid);
  if (!value) throw new Error("Linux process-start identity is unavailable.");
  return value;
}
function validRecord(value: unknown): value is LockRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.nonce === "string" &&
    /^[0-9a-f]{32}$/.test(record.nonce) &&
    typeof record.startIdentity === "string" &&
    record.startIdentity !== "unknown" &&
    typeof record.expectedSocket === "string" &&
    record.expectedSocket.length > 0
  );
}
function sameRecord(a: LockRecord, b: LockRecord): boolean {
  return (
    a.pid === b.pid &&
    a.nonce === b.nonce &&
    a.startIdentity === b.startIdentity &&
    a.expectedSocket === b.expectedSocket
  );
}
async function restoreQuarantine(
  original: string,
  quarantine: string,
): Promise<void> {
  try {
    await lstat(original);
    throw new Error(`Preserved replaced lock path at ${quarantine}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(quarantine, original);
}
async function removeExactPath(
  path: string,
  expected: { dev: number; ino: number; uid: number },
): Promise<void> {
  const quarantine = `${path}.remove.${process.pid}.${randomBytes(8).toString("hex")}`;
  await rename(path, quarantine);
  const stat = await lstat(quarantine);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino ||
    stat.uid !== expected.uid
  ) {
    await restoreQuarantine(path, quarantine);
    throw new Error("Lock path identity changed before removal.");
  }
  await unlink(quarantine);
}
async function readRecord(path: string): Promise<{
  record: LockRecord;
  stat: Awaited<ReturnType<FileHandle["stat"]>>;
}> {
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    const record = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0 ||
      !validRecord(record)
    )
      throw new Error("Broker lock record is unsafe.");
    return { record, stat };
  } finally {
    await handle.close();
  }
}
export class BrokerLock {
  #handle: FileHandle | undefined;
  #identity: LockIdentity | undefined;
  readonly #recoveryPath: string;
  constructor(
    readonly path: string,
    readonly expectedSocket = "",
  ) {
    this.#recoveryPath = `${path}.recovery`;
  }
  get identity(): LockIdentity | undefined {
    return this.#identity;
  }
  async acquire(): Promise<void> {
    for (;;) {
      const record: LockRecord = {
        pid: process.pid,
        nonce: randomBytes(16).toString("hex"),
        startIdentity: currentStart(),
        expectedSocket: this.expectedSocket,
      };
      try {
        this.#handle = await open(
          this.path,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow,
          0o600,
        );
        await this.#handle.write(`${JSON.stringify(record)}\n`);
        await this.#handle.sync();
        await this.#handle.chmod(0o600);
        const stat = await this.#handle.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          (process.getuid?.() !== undefined && stat.uid !== process.getuid())
        )
          throw new Error("Unsafe broker lock.");
        const checked = await readRecord(this.path);
        if (
          checked.stat.dev !== stat.dev ||
          checked.stat.ino !== stat.ino ||
          !sameRecord(checked.record, record)
        )
          throw new Error("Broker lock identity changed.");
        this.#identity = {
          dev: stat.dev,
          ino: stat.ino,
          uid: stat.uid,
          nonce: record.nonce,
          pid: record.pid,
          startIdentity: record.startIdentity,
          expectedSocket: record.expectedSocket,
        };
        return;
      } catch (error) {
        await this.#handle?.close().catch(() => undefined);
        this.#handle = undefined;
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const old = await readRecord(this.path);
        const liveStart = processStart(old.record.pid);
        if (liveStart !== undefined && liveStart === old.record.startIdentity)
          throw new Error("Broker lock is held by a live process.");
        if (liveStart === undefined) {
          try {
            process.kill(old.record.pid, 0);
            throw new Error("Broker lock owner is unverifiable.");
          } catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code !== "ESRCH")
              throw probeError;
          }
        }
        const guardNonce = randomBytes(16).toString("hex");
        const guard = await open(
          this.#recoveryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
          0o600,
        );
        const guardStat = await guard.stat();
        try {
          await guard.write(`${guardNonce}\n`);
          await guard.sync();
          const quarantine = `${this.path}.stale.${process.pid}.${randomBytes(8).toString("hex")}`;
          await rename(this.path, quarantine);
          const current = await readRecord(quarantine);
          if (
            current.stat.dev !== old.stat.dev ||
            current.stat.ino !== old.stat.ino ||
            current.stat.uid !== old.stat.uid ||
            !sameRecord(current.record, old.record)
          ) {
            await restoreQuarantine(this.path, quarantine);
            throw new Error("Broker lock changed during recovery.");
          }
          await unlink(quarantine);
        } finally {
          await guard.close();
          await removeExactPath(this.#recoveryPath, guardStat).catch(
            () => undefined,
          );
        }
      }
    }
  }
  async release(): Promise<void> {
    const expected = this.#identity;
    if (!expected) return;
    const quarantine = `${this.path}.release.${process.pid}.${randomBytes(8).toString("hex")}`;
    await rename(this.path, quarantine);
    const current = await readRecord(quarantine);
    if (
      current.stat.dev !== expected.dev ||
      current.stat.ino !== expected.ino ||
      current.stat.uid !== expected.uid ||
      !sameRecord(current.record, {
        pid: expected.pid,
        nonce: expected.nonce,
        startIdentity: expected.startIdentity,
        expectedSocket: expected.expectedSocket,
      })
    ) {
      await restoreQuarantine(this.path, quarantine);
      throw new Error("Broker lock identity changed.");
    }
    await this.#handle?.close();
    this.#handle = undefined;
    this.#identity = undefined;
    await unlink(quarantine);
  }
}
