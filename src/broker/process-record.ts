import {
  constants,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { open, readdir } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
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
  companionPath?: string;
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
function same(left: BrokerProcessRecord, right: BrokerProcessRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function identityOf(stat: {
  dev: number;
  ino: number;
  uid: number;
}): BrokerProcessRecordIdentity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}
function sameIdentity(
  left: BrokerProcessRecordIdentity,
  right: BrokerProcessRecordIdentity,
): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
  );
}
export function brokerProcessRecordCompanionPath(
  path: string,
  record: BrokerProcessRecord,
): string {
  return `${path}.create.${record.pid}.${record.startIdentity}.${record.nonce}`;
}
function absentSync(path: string): void {
  try {
    lstatSync(path);
    throw new Error(`Replacement was preserved at ${path}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
function exactRecordSync(
  path: string,
  expected: BrokerProcessRecord,
  identity: BrokerProcessRecordIdentity,
  links: number,
): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== links ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size < 2 ||
    stat.size > 4096 ||
    !sameIdentity(identityOf(stat), identity)
  )
    throw new Error("Broker process record identity changed before removal.");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Broker process record changed before removal.");
  }
  if (!valid(value) || !same(value, expected))
    throw new Error("Broker process record changed before removal.");
}
function restoreExactSync(
  quarantine: string,
  original: string,
  expected: BrokerProcessRecord,
  identity: BrokerProcessRecordIdentity,
  links: number,
): void {
  try {
    exactRecordSync(quarantine, expected, identity, links);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  absentSync(original);
  renameSync(quarantine, original);
  exactRecordSync(original, expected, identity, links);
}

export async function readBrokerProcessRecord(
  path: string,
  companionOverride?: string,
): Promise<{
  record: BrokerProcessRecord;
  identity: BrokerProcessRecordIdentity;
}> {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.nlink !== 1 && stat.nlink !== 2) ||
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
    const identity = identityOf(stat);
    if (stat.nlink === 2) {
      const companion =
        companionOverride ?? brokerProcessRecordCompanionPath(path, record);
      const companionStat = lstatSync(companion);
      if (
        !companionStat.isFile() ||
        companionStat.nlink !== 2 ||
        (companionStat.mode & 0o077) !== 0 ||
        !sameIdentity(identityOf(companionStat), identity)
      )
        throw new Error("Broker process record companion is unsafe.");
      identity.companionPath = companion;
    }
    return { record, identity };
  } finally {
    await handle.close();
  }
}

export function finalizeBrokerProcessRecordRemovalSync(
  original: string,
  quarantine: string,
  expected: BrokerProcessRecord,
  identity: BrokerProcessRecordIdentity,
): void {
  const failures: unknown[] = [];
  let companionRemoved = false;
  const links = identity.companionPath ? 2 : 1;
  try {
    exactRecordSync(quarantine, expected, identity, links);
    absentSync(original);
    if (identity.companionPath) {
      exactRecordSync(identity.companionPath, expected, identity, 2);
      unlinkSync(identity.companionPath);
      companionRemoved = true;
      exactRecordSync(quarantine, expected, identity, 1);
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
        "Exact process-record companion removal completed before cleanup failed.",
      ),
    );
  try {
    restoreExactSync(
      quarantine,
      original,
      expected,
      identity,
      companionRemoved ? 1 : links,
    );
  } catch (error) {
    failures.push(error);
  }
  throw failures.length === 1
    ? failures[0]
    : new AggregateError(
        failures,
        "Broker process record cleanup and restoration failed.",
      );
}

async function removeExact(
  path: string,
  expected: BrokerProcessRecord,
  identity: BrokerProcessRecordIdentity,
): Promise<void> {
  const quarantine = `${path}.remove.${process.pid}.${randomBytes(8).toString("hex")}`;
  exactRecordSync(path, expected, identity, identity.companionPath ? 2 : 1);
  renameSync(path, quarantine);
  let primary: unknown;
  try {
    const current = await readBrokerProcessRecord(
      quarantine,
      identity.companionPath,
    );
    if (
      !sameIdentity(current.identity, identity) ||
      !same(current.record, expected)
    )
      throw new Error("Broker process record changed before removal.");
    finalizeBrokerProcessRecordRemovalSync(
      path,
      quarantine,
      expected,
      identity,
    );
    return;
  } catch (error) {
    primary = error;
  }
  const failures: unknown[] = [primary];
  try {
    restoreExactSync(
      quarantine,
      path,
      expected,
      identity,
      identity.companionPath ? 2 : 1,
    );
  } catch (error) {
    failures.push(error);
  }
  throw failures.length === 1
    ? failures[0]
    : new AggregateError(
        failures,
        "Broker process record changed before removal; cleanup and restoration failed.",
      );
}

export function finalizeUnpublishedBrokerProcessRecordRemovalSync(
  path: string,
  expected: BrokerProcessRecord,
  identity: BrokerProcessRecordIdentity,
): void {
  const quarantine = `${path}.remove.${process.pid}.${randomBytes(8).toString("hex")}`;
  let renamed = false;
  try {
    exactRecordSync(path, expected, identity, 1);
    renameSync(path, quarantine);
    renamed = true;
    exactRecordSync(quarantine, expected, identity, 1);
    absentSync(path);
    unlinkSync(quarantine);
  } catch (error) {
    const failures: unknown[] = [error];
    if (renamed)
      try {
        restoreExactSync(quarantine, path, expected, identity, 1);
      } catch (restoreError) {
        failures.push(restoreError);
      }
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(
          failures,
          "Unpublished process record cleanup failed.",
        );
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
async function cleanupDeadCompanions(
  path: string,
  sessionKey: string,
  brokerSocket: string,
): Promise<void> {
  const prefix = `${basename(path)}.create.`;
  const names = (await readdir(dirname(path))).filter((name) =>
    name.startsWith(prefix),
  );
  for (const name of names) {
    const candidate = join(dirname(path), name);
    let observed;
    try {
      observed = await readBrokerProcessRecord(candidate);
    } catch {
      continue;
    }
    if (
      observed.identity.companionPath ||
      observed.record.sessionKey !== sessionKey ||
      observed.record.brokerSocket !== brokerSocket ||
      brokerProcessRecordCompanionPath(path, observed.record) !== candidate ||
      !dead(observed.record)
    )
      continue;
    finalizeUnpublishedBrokerProcessRecordRemovalSync(
      candidate,
      observed.record,
      observed.identity,
    );
  }
}

export function finalizeBrokerProcessRecordPublicationSync(
  path: string,
  temporary: string,
  record: BrokerProcessRecord,
  identity: BrokerProcessRecordIdentity,
): void {
  exactRecordSync(temporary, record, identity, 1);
  linkSync(temporary, path);
  exactRecordSync(path, record, identity, 2);
  exactRecordSync(temporary, record, identity, 2);
  unlinkSync(temporary);
  exactRecordSync(path, record, identity, 1);
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
    await cleanupDeadCompanions(path, sessionKey, brokerSocket);
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
    const temporary = brokerProcessRecordCompanionPath(path, record);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let identity: BrokerProcessRecordIdentity | undefined;
    let published = false;
    let primary: unknown;
    const teardown: unknown[] = [];
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
        0o600,
      );
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      )
        throw new Error("Broker process record creation was unsafe.");
      identity = identityOf(stat);
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        finalizeBrokerProcessRecordPublicationSync(
          path,
          temporary,
          record,
          identity,
        );
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
      return { record, identity };
    } catch (error) {
      primary = error;
      if (handle)
        try {
          await handle.close();
        } catch (closeError) {
          teardown.push(closeError);
        }
      if (identity)
        try {
          if (published) {
            identity.companionPath = temporary;
            await removeExact(path, record, identity);
          } else {
            try {
              finalizeUnpublishedBrokerProcessRecordRemovalSync(
                temporary,
                record,
                identity,
              );
            } catch (cleanupError) {
              teardown.push(cleanupError);
            }
          }
        } catch (cleanupError) {
          teardown.push(cleanupError);
        }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (teardown.length)
          throw new AggregateError(
            [primary, ...teardown],
            "Broker process record creation and cleanup failed.",
          );
        throw error;
      }
      if (teardown.length)
        throw new AggregateError(
          [primary, ...teardown],
          "Broker process record admission and cleanup failed.",
        );
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
  owned: { record: BrokerProcessRecord; identity: BrokerProcessRecordIdentity },
): Promise<void> {
  await removeExact(path, owned.record, owned.identity);
}
