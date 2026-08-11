import {
  constants,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export interface LockIdentity {
  dev: number;
  ino: number;
  uid: number;
  nonce: string;
  pid: number;
  startIdentity: string;
  expectedSocket: string;
  companionPath?: string;
}
export interface LockRecord {
  pid: number;
  nonce: string;
  startIdentity: string;
  expectedSocket: string;
}
export interface LockPathIdentity {
  dev: number;
  ino: number;
  uid: number;
  companionPath?: string;
}
const noFollow =
  (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const MAX_LOCK_RECORD_BYTES = 4096;
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.nonce === "string" &&
    /^[0-9a-f]{32}$/u.test(record.nonce) &&
    typeof record.startIdentity === "string" &&
    /^[0-9]+$/u.test(record.startIdentity) &&
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
function identityOf(stat: {
  dev: number;
  ino: number;
  uid: number;
}): LockPathIdentity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}
function sameIdentity(a: LockPathIdentity, b: LockPathIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
}
export function lockCompanionPath(path: string, record: LockRecord): string {
  return `${path}.create.${record.pid}.${record.startIdentity}.${record.nonce}`;
}
function absentSync(path: string): void {
  try {
    lstatSync(path);
    throw new Error(`Replacement lock path was preserved at ${path}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
function exactRecordSync(
  path: string,
  record: LockRecord,
  identity: LockPathIdentity,
  links: number,
): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== links ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size < 2 ||
    stat.size > MAX_LOCK_RECORD_BYTES ||
    !sameIdentity(identityOf(stat), identity)
  )
    throw new Error("Lock path identity changed before removal.");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Broker lock record changed before removal.");
  }
  if (!validRecord(value) || !sameRecord(value, record))
    throw new Error("Broker lock record changed before removal.");
}
function restoreSync(
  quarantine: string,
  original: string,
  record: LockRecord,
  identity: LockPathIdentity,
  links: number,
): void {
  try {
    exactRecordSync(quarantine, record, identity, links);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  absentSync(original);
  renameSync(quarantine, original);
  exactRecordSync(original, record, identity, links);
}
export function finalizeLockRemovalSync(
  original: string,
  quarantine: string,
  record: LockRecord,
  identity: LockPathIdentity,
): void {
  const failures: unknown[] = [];
  const links = identity.companionPath ? 2 : 1;
  let companionRemoved = false;
  try {
    exactRecordSync(quarantine, record, identity, links);
    absentSync(original);
    if (identity.companionPath) {
      exactRecordSync(identity.companionPath, record, identity, 2);
      unlinkSync(identity.companionPath);
      companionRemoved = true;
      exactRecordSync(quarantine, record, identity, 1);
      absentSync(original);
      absentSync(identity.companionPath);
    }
    unlinkSync(quarantine);
    return;
  } catch (error) {
    failures.push(error);
  }
  if (companionRemoved)
    failures.push(
      new Error(
        "Exact lock companion removal completed before cleanup failed.",
      ),
    );
  try {
    restoreSync(
      quarantine,
      original,
      record,
      identity,
      companionRemoved ? 1 : links,
    );
  } catch (error) {
    failures.push(error);
  }
  throw failures.length === 1
    ? failures[0]
    : new AggregateError(failures, "Lock cleanup and restoration failed.");
}
export async function finalizeLockTeardown(
  handle: Pick<FileHandle, "close">,
  original: string,
  quarantine: string,
  record: LockRecord,
  identity: LockPathIdentity,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await handle.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    finalizeLockRemovalSync(original, quarantine, record, identity);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Lock handle close and finalization failed.",
    );
}

async function readRecord(
  path: string,
  companionOverride?: string,
): Promise<{
  record: LockRecord;
  stat: Awaited<ReturnType<FileHandle["stat"]>>;
  identity: LockPathIdentity;
}> {
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.nlink !== 1 && stat.nlink !== 2) ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size < 2 ||
      stat.size > MAX_LOCK_RECORD_BYTES
    )
      throw new Error("Broker lock record is unsafe.");
    let record: unknown;
    try {
      record = JSON.parse(await handle.readFile("utf8")) as unknown;
    } catch {
      throw new Error("Broker lock record is unsafe.");
    }
    if (!validRecord(record)) throw new Error("Broker lock record is unsafe.");
    const identity = identityOf(stat);
    if (stat.nlink === 2) {
      const companion = companionOverride ?? lockCompanionPath(path, record);
      const companionStat = lstatSync(companion);
      if (
        !companionStat.isFile() ||
        companionStat.nlink !== 2 ||
        (companionStat.mode & 0o777) !== 0o600 ||
        companionStat.size < 2 ||
        companionStat.size > MAX_LOCK_RECORD_BYTES ||
        !sameIdentity(identityOf(companionStat), identity)
      )
        throw new Error("Broker lock companion is unsafe.");
      identity.companionPath = companion;
    }
    return { record, stat, identity };
  } finally {
    await handle.close();
  }
}
function ownerDead(record: LockRecord): boolean {
  const liveStart = processStart(record.pid);
  if (liveStart !== undefined) return liveStart !== record.startIdentity;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw new Error("Broker lock owner is unverifiable.");
  }
}
function removeUnpublishedSync(
  path: string,
  record: LockRecord,
  identity: LockPathIdentity,
): void {
  const quarantine = `${path}.remove.${process.pid}.${randomBytes(8).toString("hex")}`;
  let renamed = false;
  try {
    exactRecordSync(path, record, identity, 1);
    renameSync(path, quarantine);
    renamed = true;
    exactRecordSync(quarantine, record, identity, 1);
    absentSync(path);
    unlinkSync(quarantine);
  } catch (error) {
    const failures: unknown[] = [error];
    if (renamed)
      try {
        restoreSync(quarantine, path, record, identity, 1);
      } catch (restoreError) {
        failures.push(restoreError);
      }
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Unpublished lock cleanup failed.");
  }
}
async function cleanupDeadCompanions(
  path: string,
  expectedSocket: string,
): Promise<void> {
  const prefix = `${basename(path)}.create.`;
  for (const name of (await readdir(dirname(path))).filter((item) =>
    item.startsWith(prefix),
  )) {
    const candidate = join(dirname(path), name);
    let observed;
    try {
      observed = await readRecord(candidate);
    } catch {
      continue;
    }
    if (
      observed.identity.companionPath ||
      observed.record.expectedSocket !== expectedSocket ||
      lockCompanionPath(path, observed.record) !== candidate ||
      !ownerDead(observed.record)
    )
      continue;
    removeUnpublishedSync(candidate, observed.record, observed.identity);
  }
}
export function finalizeLockPublicationSync(
  path: string,
  temporary: string,
  record: LockRecord,
  identity: LockPathIdentity,
): void {
  exactRecordSync(temporary, record, identity, 1);
  linkSync(temporary, path);
  exactRecordSync(path, record, identity, 2);
  exactRecordSync(temporary, record, identity, 2);
  unlinkSync(temporary);
  exactRecordSync(path, record, identity, 1);
}

async function publishRecord(
  path: string,
  record: LockRecord,
): Promise<{ handle: FileHandle; identity: LockPathIdentity }> {
  await cleanupDeadCompanions(path, record.expectedSocket);
  const temporary = lockCompanionPath(path, record);
  const handle = await open(
    temporary,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  let identity: LockPathIdentity | undefined;
  let published = false;
  const failures: unknown[] = [];
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new Error("Unsafe broker lock.");
    identity = identityOf(stat);
    await handle.write(`${JSON.stringify(record)}\n`);
    await handle.sync();
    await handle.chmod(0o600);
    try {
      finalizeLockPublicationSync(path, temporary, record, identity);
    } catch (error) {
      try {
        exactRecordSync(path, record, identity, 2);
        exactRecordSync(temporary, record, identity, 2);
        published = true;
      } catch {
        published = false;
      }
      throw error;
    }
    return { handle, identity };
  } catch (error) {
    failures.push(error);
    try {
      await handle.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    if (identity)
      try {
        if (published) {
          identity.companionPath = temporary;
          const quarantine = `${path}.remove.${process.pid}.${randomBytes(8).toString("hex")}`;
          renameSync(path, quarantine);
          finalizeLockRemovalSync(path, quarantine, record, identity);
        } else removeUnpublishedSync(temporary, record, identity);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(
          failures,
          "Broker lock publication and cleanup failed.",
        );
  }
}
async function removeExactPath(
  path: string,
  record: LockRecord,
  identity: LockPathIdentity,
): Promise<void> {
  const quarantine = `${path}.remove.${process.pid}.${randomBytes(8).toString("hex")}`;
  exactRecordSync(path, record, identity, identity.companionPath ? 2 : 1);
  renameSync(path, quarantine);
  let primary: unknown;
  try {
    const checked = await readRecord(quarantine, identity.companionPath);
    if (
      !sameRecord(checked.record, record) ||
      !sameIdentity(checked.identity, identity)
    )
      throw new Error("Lock path identity changed before removal.");
    finalizeLockRemovalSync(path, quarantine, record, identity);
    return;
  } catch (error) {
    primary = error;
  }
  const failures: unknown[] = [primary];
  try {
    restoreSync(
      quarantine,
      path,
      record,
      identity,
      identity.companionPath ? 2 : 1,
    );
  } catch (error) {
    failures.push(error);
  }
  throw failures.length === 1
    ? failures[0]
    : new AggregateError(failures, "Lock removal and restoration failed.");
}

async function acquireRecoveryGuard(
  path: string,
  record: LockRecord,
): Promise<{ handle: FileHandle; identity: LockPathIdentity }> {
  for (;;) {
    try {
      return await publishRecord(path, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stale = await readRecord(path);
      if (stale.record.expectedSocket !== path)
        throw new Error("Recovery guard belongs to another lock.");
      if (!ownerDead(stale.record))
        throw new Error("Recovery guard is held by a live process.");
      await removeExactPath(path, stale.record, stale.identity);
    }
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
        const published = await publishRecord(this.path, record);
        this.#handle = published.handle;
        this.#identity = { ...published.identity, ...record };
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const old = await readRecord(this.path);
        if (old.record.expectedSocket !== this.expectedSocket)
          throw new Error("Broker lock belongs to another configured socket.");
        if (!ownerDead(old.record))
          throw new Error("Broker lock is held by a live process.");
        const guardRecord: LockRecord = {
          pid: process.pid,
          nonce: randomBytes(16).toString("hex"),
          startIdentity: currentStart(),
          expectedSocket: this.#recoveryPath,
        };
        let guard:
          { handle: FileHandle; identity: LockPathIdentity } | undefined;
        const failures: unknown[] = [];
        try {
          guard = await acquireRecoveryGuard(this.#recoveryPath, guardRecord);
          const quarantine = `${this.path}.stale.${process.pid}.${randomBytes(8).toString("hex")}`;
          exactRecordSync(
            this.path,
            old.record,
            old.identity,
            old.identity.companionPath ? 2 : 1,
          );
          renameSync(this.path, quarantine);
          const current = await readRecord(
            quarantine,
            old.identity.companionPath,
          );
          if (
            !sameIdentity(current.identity, old.identity) ||
            !sameRecord(current.record, old.record)
          )
            throw new Error("Broker lock changed during recovery.");
          finalizeLockRemovalSync(
            this.path,
            quarantine,
            old.record,
            old.identity,
          );
        } catch (recoveryError) {
          failures.push(recoveryError);
        } finally {
          if (guard) {
            try {
              await guard.handle.close();
            } catch (closeError) {
              failures.push(closeError);
            }
            try {
              await removeExactPath(
                this.#recoveryPath,
                guardRecord,
                guard.identity,
              );
            } catch (cleanupError) {
              failures.push(cleanupError);
            }
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(
            failures,
            "Stale lock recovery and guard teardown failed.",
          );
      }
    }
  }
  async release(): Promise<void> {
    const expected = this.#identity;
    if (!expected) return;
    const record: LockRecord = {
      pid: expected.pid,
      nonce: expected.nonce,
      startIdentity: expected.startIdentity,
      expectedSocket: expected.expectedSocket,
    };
    const quarantine = `${this.path}.release.${process.pid}.${randomBytes(8).toString("hex")}`;
    exactRecordSync(
      this.path,
      record,
      expected,
      expected.companionPath ? 2 : 1,
    );
    renameSync(this.path, quarantine);
    const failures: unknown[] = [];
    try {
      const current = await readRecord(quarantine, expected.companionPath);
      if (
        !sameIdentity(current.identity, expected) ||
        !sameRecord(current.record, record)
      )
        throw new Error("Broker lock identity changed.");
    } catch (error) {
      failures.push(error);
    }
    if (this.#handle)
      try {
        await finalizeLockTeardown(
          this.#handle,
          this.path,
          quarantine,
          record,
          expected,
        );
      } catch (error) {
        failures.push(error);
      }
    else
      try {
        finalizeLockRemovalSync(this.path, quarantine, record, expected);
      } catch (error) {
        failures.push(error);
      }
    this.#handle = undefined;
    if (!failures.length) this.#identity = undefined;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Broker lock release and teardown failed.",
      );
  }
}
