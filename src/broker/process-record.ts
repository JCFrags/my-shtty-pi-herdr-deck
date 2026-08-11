import { constants, readFileSync } from "node:fs";
import { open, rename, unlink, lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const NOFOLLOW =
  (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
export interface BrokerProcessRecord {
  version: 1;
  nonce: string;
  pid: number;
  startIdentity: string;
  sessionKey: string;
  brokerSocket: string;
}
export interface BrokerProcessRecordIdentity {
  dev: number;
  ino: number;
  uid: number;
}

function processStart(pid: number): string | undefined {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = value.lastIndexOf(") ");
    return end < 0
      ? undefined
      : value
          .slice(end + 2)
          .trim()
          .split(/\s+/)[19];
  } catch {
    return undefined;
  }
}
function valid(value: unknown): value is BrokerProcessRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).length === 6 &&
    item.version === 1 &&
    typeof item.nonce === "string" &&
    /^[0-9a-f]{32}$/u.test(item.nonce) &&
    Number.isSafeInteger(item.pid) &&
    Number(item.pid) > 0 &&
    typeof item.startIdentity === "string" &&
    /^[0-9]+$/u.test(item.startIdentity) &&
    typeof item.sessionKey === "string" &&
    /^[0-9a-f]{24}$/u.test(item.sessionKey) &&
    typeof item.brokerSocket === "string" &&
    item.brokerSocket.startsWith("/")
  );
}
export async function readBrokerProcessRecord(path: string): Promise<{
  record: BrokerProcessRecord;
  identity: BrokerProcessRecordIdentity;
}> {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 2 ||
      stat.size > 4096
    )
      throw new Error("Broker process record is unsafe.");
    let record: unknown;
    try {
      record = JSON.parse(await handle.readFile("utf8")) as unknown;
    } catch {
      throw new Error("Broker process record is unsafe.");
    }
    if (!valid(record)) throw new Error("Broker process record is unsafe.");
    return {
      record,
      identity: { dev: stat.dev, ino: stat.ino, uid: stat.uid },
    };
  } finally {
    await handle.close();
  }
}
function same(left: BrokerProcessRecord, right: BrokerProcessRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
async function removeExact(
  path: string,
  expected: BrokerProcessRecord,
  identity: BrokerProcessRecordIdentity,
): Promise<void> {
  const quarantine = `${path}.remove.${process.pid}.${randomBytes(8).toString("hex")}`;
  await rename(path, quarantine);
  try {
    const current = await readBrokerProcessRecord(quarantine);
    if (
      current.identity.dev !== identity.dev ||
      current.identity.ino !== identity.ino ||
      current.identity.uid !== identity.uid ||
      !same(current.record, expected)
    )
      throw new Error("Broker process record changed before removal.");
    await unlink(quarantine);
  } catch (error) {
    try {
      await lstat(path);
      throw new AggregateError(
        [error],
        `Broker process record replacement was preserved at ${quarantine}.`,
      );
    } catch (pathError) {
      if ((pathError as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await rename(quarantine, path);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "Broker process record cleanup and restoration failed.",
          );
        }
      } else if (pathError !== error)
        throw new AggregateError(
          [error, pathError],
          "Broker process record cleanup failed.",
        );
    }
    throw error;
  }
}
async function removeOwnedIdentity(
  path: string,
  identity: BrokerProcessRecordIdentity,
): Promise<void> {
  const quarantine = `${path}.remove.${process.pid}.${randomBytes(8).toString("hex")}`;
  await rename(path, quarantine);
  try {
    const stat = await lstat(quarantine);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino ||
      stat.uid !== identity.uid
    )
      throw new Error("Broker process record identity changed before cleanup.");
    await unlink(quarantine);
  } catch (error) {
    try {
      await lstat(path);
      throw new AggregateError(
        [error],
        `Broker process record replacement was preserved at ${quarantine}.`,
      );
    } catch (pathError) {
      if ((pathError as NodeJS.ErrnoException).code === "ENOENT")
        await rename(quarantine, path);
      else if (pathError !== error)
        throw new AggregateError(
          [error, pathError],
          "Broker process record identity cleanup failed.",
        );
    }
    throw error;
  }
}

export function brokerProcessAlive(
  record: BrokerProcessRecord,
): boolean | undefined {
  const start = processStart(record.pid);
  if (start !== undefined) return start === record.startIdentity;
  try {
    process.kill(record.pid, 0);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return undefined;
  }
}
function dead(record: BrokerProcessRecord): boolean {
  const start = processStart(record.pid);
  if (start !== undefined) return start !== record.startIdentity;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw new Error("Broker process record owner is unverifiable.");
  }
}
export async function createBrokerProcessRecord(
  path: string,
  sessionKey: string,
  brokerSocket: string,
): Promise<{
  record: BrokerProcessRecord;
  identity: BrokerProcessRecordIdentity;
}> {
  for (;;) {
    const startIdentity = processStart(process.pid);
    if (!startIdentity)
      throw new Error("Linux process-start identity is unavailable.");
    const record: BrokerProcessRecord = {
      version: 1,
      nonce: randomBytes(16).toString("hex"),
      pid: process.pid,
      startIdentity,
      sessionKey,
      brokerSocket,
    };
    let createdIdentity: BrokerProcessRecordIdentity | undefined;
    try {
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
        0o600,
      );
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o077) !== 0
        )
          throw new Error("Broker process record creation was unsafe.");
        createdIdentity = { dev: stat.dev, ino: stat.ino, uid: stat.uid };
        await handle.writeFile(`${JSON.stringify(record)}\n`);
        await handle.sync();
        const result = { record, identity: createdIdentity };
        const checked = await readBrokerProcessRecord(path);
        if (
          checked.identity.dev !== result.identity.dev ||
          checked.identity.ino !== result.identity.ino ||
          !same(checked.record, record)
        )
          throw new Error("Broker process record changed after creation.");
        return result;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (createdIdentity)
          try {
            await removeOwnedIdentity(path, createdIdentity);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Broker process record creation and cleanup failed.",
            );
          }
        throw error;
      }
      const stale = await readBrokerProcessRecord(path);
      if (
        stale.record.sessionKey !== sessionKey ||
        stale.record.brokerSocket !== brokerSocket
      )
        throw new Error("Broker process record belongs to another session.");
      if (!dead(stale.record))
        throw new Error("Broker process record belongs to a live process.");
      await removeExact(path, stale.record, stale.identity);
    }
  }
}
export async function removeBrokerProcessRecord(
  path: string,
  owned: {
    record: BrokerProcessRecord;
    identity: BrokerProcessRecordIdentity;
  },
): Promise<void> {
  await removeExact(path, owned.record, owned.identity);
}
