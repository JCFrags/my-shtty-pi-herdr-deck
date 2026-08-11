import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import {
  brokerProcessRecordCompanionPath,
  createBrokerProcessRecord,
  type BrokerProcessRecord,
} from "../../src/broker/process-record.js";
import {
  BrokerLock,
  lockCompanionPath,
  type LockRecord,
} from "../../src/broker/lock.js";

function processStart(): string {
  const text = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const end = text.lastIndexOf(") ");
  if (end < 0) throw new Error("missing process identity");
  return text
    .slice(end + 2)
    .trim()
    .split(/\s+/)[19]!;
}
function synced(path: string, value: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function receipt(value: object, code: number): never {
  writeSync(1, `${JSON.stringify(value)}\n`);
  process.exit(code);
}

const [mode, path, sessionKey, socket] = process.argv.slice(2);
if (!mode || !path || !sessionKey || !socket)
  throw new Error("missing arguments");
const startIdentity = processStart();
if (mode.startsWith("process-")) {
  const record: BrokerProcessRecord = {
    version: 1,
    nonce: mode.endsWith("before") ? "1".repeat(32) : "2".repeat(32),
    pid: process.pid,
    startIdentity,
    sessionKey,
    brokerSocket: socket,
  };
  if (mode === "process-owned") {
    const owned = await createBrokerProcessRecord(path, sessionKey, socket);
    receipt({ mode, path, record: owned.record }, 83);
  }
  const companion = brokerProcessRecordCompanionPath(path, record);
  synced(companion, `${JSON.stringify(record)}\n`);
  if (mode === "process-boundary") linkSync(companion, path);
  receipt(
    { mode, path, companion, record },
    mode === "process-before" ? 81 : 82,
  );
}
if (mode.startsWith("lock-dead-guard-")) {
  const main = new BrokerLock(path, socket);
  await main.acquire();
  const recovery = `${path}.recovery`;
  if (mode === "lock-dead-guard-owned") {
    const guard = new BrokerLock(recovery, recovery);
    await guard.acquire();
    receipt({ mode, path, recovery }, 87);
  }
  const guardRecord: LockRecord = {
    pid: process.pid,
    nonce: "5".repeat(32),
    startIdentity,
    expectedSocket: recovery,
  };
  const guardCompanion = lockCompanionPath(recovery, guardRecord);
  synced(guardCompanion, `${JSON.stringify(guardRecord)}\n`);
  linkSync(guardCompanion, recovery);
  receipt({ mode, path, recovery, guardCompanion }, 88);
}
const record: LockRecord = {
  pid: process.pid,
  nonce: mode.endsWith("before") ? "3".repeat(32) : "4".repeat(32),
  startIdentity,
  expectedSocket: socket,
};
if (mode === "lock-owned") {
  const lock = new BrokerLock(path, socket);
  await lock.acquire();
  receipt({ mode, path, record }, 86);
}
const companion = lockCompanionPath(path, record);
synced(companion, `${JSON.stringify(record)}\n`);
if (mode === "lock-boundary") linkSync(companion, path);
receipt({ mode, path, companion, record }, mode === "lock-before" ? 84 : 85);
