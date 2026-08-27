import { spawn, type ChildProcess } from "node:child_process";
import {
  constants,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BrokerRequestTimeoutError, brokerRequest } from "../cli/client.js";
import { validateDoctorReport } from "./doctor.js";
import { readPrivateRegular } from "../shared/private-fs.js";
import {
  ensurePrivateDirectory,
  revalidateHerdrSocket,
  resolveHerdrPaths,
  type HerdrSocketIdentity,
  type CanonicalResolvedPaths,
} from "../shared/paths.js";
import { safeStaleSocket } from "./broker.js";
import {
  brokerProcessAlive,
  readBrokerProcessRecord,
  removeBrokerProcessRecord,
} from "./process-record.js";
import { BrokerLock } from "./lock.js";
import {
  authoritativeHerdrBinary,
  revalidateHerdrBinary,
} from "../herdr/binary.js";

const NOFOLLOW =
  (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const READY_TIMEOUT_MS = 15_000;
const RETRY_MS = 75;

export interface StartupRecord {
  version: 1;
  nonce: string;
  pid: number;
  startIdentity: string;
  sessionKey: string;
  brokerSocket: string;
  commandPath: string;
  commandDev: number;
  commandIno: number;
}
export interface RecordIdentity {
  dev: number;
  ino: number;
  uid: number;
}
export interface CompanionIdentity {
  path: string;
  identity: RecordIdentity;
}
interface StartupObservation {
  record: StartupRecord;
  identity: RecordIdentity;
  companion?: CompanionIdentity;
}

export function linuxProcessStart(pid: number): string | undefined {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = value.lastIndexOf(") ");
    if (end < 0) return undefined;
    return value
      .slice(end + 2)
      .trim()
      .split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

function currentStart(): string {
  const value = linuxProcessStart(process.pid);
  if (!value) throw new Error("Linux process-start identity is unavailable.");
  return value;
}

function exactRecord(value: unknown): value is StartupRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 9 &&
    [
      "version",
      "nonce",
      "pid",
      "startIdentity",
      "sessionKey",
      "brokerSocket",
      "commandPath",
      "commandDev",
      "commandIno",
    ].every((key) => Object.hasOwn(record, key)) &&
    record.version === 1 &&
    typeof record.nonce === "string" &&
    /^[0-9a-f]{32}$/u.test(record.nonce) &&
    Number.isSafeInteger(record.pid) &&
    Number(record.pid) > 0 &&
    typeof record.startIdentity === "string" &&
    /^[0-9]+$/u.test(record.startIdentity) &&
    typeof record.sessionKey === "string" &&
    /^[0-9a-f]{24}$/u.test(record.sessionKey) &&
    typeof record.brokerSocket === "string" &&
    record.brokerSocket.startsWith("/") &&
    typeof record.commandPath === "string" &&
    record.commandPath.startsWith("/") &&
    Number.isSafeInteger(record.commandDev) &&
    Number.isSafeInteger(record.commandIno)
  );
}

function missingStartupDuringInspection(): NodeJS.ErrnoException {
  const error = new Error(
    "Broker startup record disappeared during inspection.",
  ) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

async function requireMissingStartupPath(path: string): Promise<never> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw missingStartupDuringInspection();
    throw error;
  }
  throw new Error("Broker startup record changed during inspection.");
}

async function readStartup(
  path: string,
  companionOverride?: string,
): Promise<StartupObservation> {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (stat.nlink === 0) await requireMissingStartupPath(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.nlink !== 1 && stat.nlink !== 2) ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 2 ||
      stat.size > 4096
    )
      throw new Error("Broker startup record is unsafe or malformed.");
    let value: unknown;
    try {
      value = JSON.parse(await handle.readFile("utf8")) as unknown;
    } catch {
      throw new Error("Broker startup record is unsafe or malformed.");
    }
    if (!exactRecord(value))
      throw new Error("Broker startup record is unsafe or malformed.");
    let companion: CompanionIdentity | undefined;
    const companionPath = companionOverride ?? `${path}.create.${value.nonce}`;
    if (stat.nlink === 2) {
      try {
        const temporary = await lstat(companionPath);
        if (
          !temporary.isFile() ||
          temporary.isSymbolicLink() ||
          temporary.dev !== stat.dev ||
          temporary.ino !== stat.ino ||
          temporary.uid !== stat.uid ||
          (temporary.mode & 0o077) !== 0
        )
          throw new Error("Broker startup record is unsafe or malformed.");
        companion = {
          path: companionPath,
          identity: {
            dev: temporary.dev,
            ino: temporary.ino,
            uid: temporary.uid,
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const refreshed = await handle.stat();
        if (refreshed.nlink === 0) await requireMissingStartupPath(path);
        if (refreshed.nlink !== 1)
          throw new Error("Broker startup record is unsafe or malformed.");
      }
    } else {
      try {
        await lstat(companionPath);
        throw new Error("Broker startup companion is replaced.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return {
      record: value,
      identity: { dev: stat.dev, ino: stat.ino, uid: stat.uid },
      ...(companion ? { companion } : {}),
    };
  } finally {
    await handle.close();
  }
}

function sameRecord(left: StartupRecord, right: StartupRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameIdentity(left: RecordIdentity, right: RecordIdentity): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
  );
}

function privateIdentitySync(
  path: string,
  expected: RecordIdentity,
  expectedLinks?: number,
): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    !sameIdentity({ dev: stat.dev, ino: stat.ino, uid: stat.uid }, expected) ||
    (expectedLinks !== undefined && stat.nlink !== expectedLinks)
  )
    throw new Error(`Private path identity changed before removal: ${path}`);
}

function absentSync(path: string): void {
  try {
    lstatSync(path);
    throw new Error(`Replacement was preserved at ${path}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function startupRecordSync(
  path: string,
  expected: StartupRecord,
  identity: RecordIdentity,
  companion?: CompanionIdentity,
): void {
  privateIdentitySync(path, identity, companion ? 2 : 1);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Broker startup record changed before removal.");
  }
  if (!exactRecord(value) || !sameRecord(value, expected))
    throw new Error("Broker startup record changed before removal.");
  const companionPath = companion?.path ?? `${path}.create.${expected.nonce}`;
  if (companion) privateIdentitySync(companion.path, companion.identity, 2);
  else absentSync(companionPath);
}

function restoreQuarantineSync(
  quarantine: string,
  original: string,
  expected: RecordIdentity,
): void {
  try {
    privateIdentitySync(quarantine, expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  absentSync(original);
  renameSync(quarantine, original);
  privateIdentitySync(original, expected);
}

export function finalizeStartupRemovalSync(
  path: string,
  expected: StartupRecord,
  identity: RecordIdentity,
  companion?: CompanionIdentity,
): void {
  const suffix = `${process.pid}.${randomBytes(8).toString("hex")}`;
  const quarantine = `${path}.remove.${suffix}`;
  const companionPath = companion?.path ?? `${path}.create.${expected.nonce}`;
  let publicRenamed = false;
  let companionRemoved = false;
  try {
    startupRecordSync(path, expected, identity, companion);
    if (companion) {
      privateIdentitySync(path, identity, 2);
      privateIdentitySync(companion.path, companion.identity, 2);
      unlinkSync(companion.path);
      companionRemoved = true;
      startupRecordSync(path, expected, identity);
    }
    renameSync(path, quarantine);
    publicRenamed = true;
    startupRecordSync(quarantine, expected, identity);
    absentSync(path);
    absentSync(companionPath);
    unlinkSync(quarantine);
    publicRenamed = false;
  } catch (error) {
    const failures: unknown[] = [error];
    if (companionRemoved)
      failures.push(
        new Error(
          "Exact startup companion removal completed before cleanup failed.",
        ),
      );
    if (publicRenamed)
      try {
        restoreQuarantineSync(quarantine, path, identity);
      } catch (restoreError) {
        failures.push(restoreError);
      }
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Startup link cleanup failed.");
  }
}

async function removeExactStartup(
  path: string,
  expected: StartupRecord,
  identity: RecordIdentity,
  companion?: CompanionIdentity,
): Promise<void> {
  finalizeStartupRemovalSync(path, expected, identity, companion);
}

export function finalizeOwnedStartupRemovalSync(
  path: string,
  identity: RecordIdentity,
): void {
  const quarantine = `${path}.remove.${process.pid}.${randomBytes(8).toString("hex")}`;
  let renamed = false;
  try {
    privateIdentitySync(path, identity);
    renameSync(path, quarantine);
    renamed = true;
    privateIdentitySync(quarantine, identity);
    absentSync(path);
    unlinkSync(quarantine);
    renamed = false;
  } catch (error) {
    const failures: unknown[] = [error];
    if (renamed)
      try {
        restoreQuarantineSync(quarantine, path, identity);
      } catch (restoreError) {
        failures.push(restoreError);
      }
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Startup record identity cleanup failed.");
  }
}

async function removeOwnedStartupIdentity(
  path: string,
  identity: RecordIdentity,
): Promise<void> {
  finalizeOwnedStartupRemovalSync(path, identity);
}

async function packageCommand(): Promise<{
  path: string;
  dev: number;
  ino: number;
}> {
  const path = fileURLToPath(
    new URL("../../../bin/pi-herdr-orchestrator", import.meta.url),
  );
  const canonical = await realpath(path).catch(() => "");
  const stat = await lstat(path).catch(() => undefined);
  if (
    canonical !== path ||
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o111) === 0
  )
    throw new Error(
      "The packaged broker executable is missing or unsafe. Rebuild the installed package.",
    );
  return { path, dev: stat.dev, ino: stat.ino };
}

export function minimalBrokerEnvironment(
  identity: HerdrSocketIdentity,
  herdrBinary: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_TERMINAL_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    "HERDR_BIN_PATH",
    "HERDR_CONFIG_PATH",
    "PI_HERDR_ORCH_CONFIG_PATH",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  env.HERDR_SOCKET_PATH = identity.path;
  env.HERDR_BIN_PATH = herdrBinary;
  if (process.env.PI_HERDR_ORCH_RUNTIME_ROOT)
    env.PI_HERDR_ORCH_RUNTIME_ROOT = process.env.PI_HERDR_ORCH_RUNTIME_ROOT;
  if (process.env.PI_HERDR_ORCH_STATE_ROOT)
    env.PI_HERDR_ORCH_STATE_ROOT = process.env.PI_HERDR_ORCH_STATE_ROOT;
  if (process.env.PI_HERDR_COMPACT_DELEGATION === "0")
    env.PI_HERDR_COMPACT_DELEGATION = "0";
  return env;
}

export function finalizeStartupPublicationSync(
  path: string,
  temporaryPath: string,
  record: StartupRecord,
  identity: RecordIdentity,
): StartupObservation {
  startupRecordSync(temporaryPath, record, identity);
  linkSync(temporaryPath, path);
  startupRecordSync(path, record, identity, {
    path: temporaryPath,
    identity,
  });
  return {
    record,
    identity,
    companion: { path: temporaryPath, identity },
  };
}

async function publishStartup(
  path: string,
  record: StartupRecord,
): Promise<StartupObservation> {
  const temporaryPath = `${path}.create.${record.nonce}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryIdentity: RecordIdentity | undefined;
  let published = false;
  let succeeded = false;
  let primary: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    handle = await open(
      temporaryPath,
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
      throw new Error("Broker startup record creation was unsafe.");
    temporaryIdentity = { dev: stat.dev, ino: stat.ino, uid: stat.uid };
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    let checked: StartupObservation;
    try {
      checked = finalizeStartupPublicationSync(
        path,
        temporaryPath,
        record,
        temporaryIdentity,
      );
      published = true;
    } catch (error) {
      try {
        privateIdentitySync(path, temporaryIdentity, 2);
        privateIdentitySync(temporaryPath, temporaryIdentity, 2);
        published = true;
      } catch {
        published = false;
      }
      throw error;
    }
    temporaryIdentity = undefined;
    succeeded = true;
    return checked;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    if (handle)
      try {
        await handle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    if (!succeeded && published && temporaryIdentity) {
      try {
        await removeExactStartup(path, record, temporaryIdentity, {
          path: temporaryPath,
          identity: temporaryIdentity,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
      temporaryIdentity = undefined;
    }
    if (temporaryIdentity)
      try {
        await removeOwnedStartupIdentity(temporaryPath, temporaryIdentity);
      } catch (error) {
        cleanupErrors.push(error);
      }
    if (cleanupErrors.length) {
      const errors = primary ? [primary, ...cleanupErrors] : cleanupErrors;
      throw new AggregateError(
        errors,
        "Startup record publication cleanup failed.",
      );
    }
  }
}

async function secureLog(path: string) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW,
    0o600,
  );
  const stat = await handle.stat();
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    await handle.close();
    throw new Error("Broker log path is unsafe.");
  }
  return handle;
}

async function authenticatedPing(
  paths: CanonicalResolvedPaths,
  options: { timeoutMs?: number; timeoutIsTransient?: boolean } = {},
): Promise<boolean> {
  try {
    const secret = await readPrivateRegular(paths.secret);
    if (!/^[A-Za-z0-9_-]{43}\n$/u.test(secret))
      throw new Error("Broker client secret is malformed.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  let result: Record<string, unknown>;
  try {
    result = (await brokerRequest(
      paths.socket,
      paths.secret,
      "system.ping",
      {},
      paths.sessionKey,
      { timeoutMs: options.timeoutMs ?? 5_000 },
    )) as Record<string, unknown>;
  } catch (error) {
    if (
      options.timeoutIsTransient &&
      error instanceof BrokerRequestTimeoutError
    )
      return false;
    if (
      ["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return false;
    throw error;
  }
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !Object.keys(result).every((key) =>
      ["status", "lastEventSeq", "corruption"].includes(key),
    ) ||
    !["healthy", "read_only_recovery"].includes(String(result.status)) ||
    !Number.isSafeInteger(result.lastEventSeq) ||
    Number(result.lastEventSeq) < 0 ||
    (result.corruption !== undefined && typeof result.corruption !== "string")
  )
    throw new Error("Broker returned a malformed authenticated ping response.");
  return true;
}

async function validateRetainedBrokerBinary(
  paths: CanonicalResolvedPaths,
): Promise<void> {
  const report = validateDoctorReport(
    await brokerRequest(
      paths.socket,
      paths.secret,
      "system.doctor",
      {},
      paths.sessionKey,
    ),
  );
  if (!report.ok) throw new Error("Running broker failed its doctor checks.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ownerState(record: StartupRecord): "live" | "dead" | "unverifiable" {
  const start = linuxProcessStart(record.pid);
  if (start !== undefined)
    return start === record.startIdentity ? "live" : "dead";
  try {
    process.kill(record.pid, 0);
    return "unverifiable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "dead"
      : "unverifiable";
  }
}

async function waitReady(
  paths: CanonicalResolvedPaths,
  herdr: HerdrSocketIdentity,
  deadline: number,
  child?: ChildProcess,
): Promise<void> {
  let childFailure: Error | undefined;
  child?.once("error", (error) => {
    childFailure = error;
  });
  child?.once("exit", (code, signal) => {
    if (code !== null || signal !== null)
      childFailure = new Error(
        `Broker exited before readiness (${code ?? signal ?? "unknown"}).`,
      );
  });
  while (Date.now() < deadline) {
    await revalidateHerdrSocket(herdr);
    const remainingMs = Math.max(1, deadline - Date.now());
    if (
      await authenticatedPing(paths, {
        timeoutMs: Math.min(5_000, remainingMs),
        timeoutIsTransient: true,
      })
    ) {
      await inspectAuthenticatedStartup(paths);
      return;
    }
    if (childFailure) throw childFailure;
    await delay(Math.min(RETRY_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Broker readiness timed out. Inspect ${paths.log}.`);
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function exactChildStillAlive(pid: number, expectedStart: string): boolean {
  const current = linuxProcessStart(pid);
  if (current !== undefined) return current === expectedStart;
  try {
    process.kill(pid, 0);
    throw new Error("Spawned broker process identity became unverifiable.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function stopOwnedChild(
  child: ChildProcess,
  expectedStart: string,
): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (!exactChildStillAlive(pid, expectedStart)) return;
  if (!child.kill("SIGTERM"))
    throw new Error("Spawned broker process refused the cleanup signal.");
  if (await waitForChildExit(child, 1_500)) return;
  if (!exactChildStillAlive(pid, expectedStart)) return;
  if (!child.kill("SIGKILL"))
    throw new Error(
      "Spawned broker process refused the forced cleanup signal.",
    );
  if (!(await waitForChildExit(child, 3_000)))
    throw new Error(
      "Spawned broker process did not exit after exact cleanup signals.",
    );
}

async function cleanupFailedChildArtifacts(
  paths: CanonicalResolvedPaths,
  childPid: number,
  childStart: string,
): Promise<void> {
  const failures: unknown[] = [];
  if (await exists(paths.pid))
    try {
      const processRecord = await readBrokerProcessRecord(paths.pid);
      if (
        processRecord.record.pid !== childPid ||
        processRecord.record.startIdentity !== childStart ||
        processRecord.record.sessionKey !== paths.sessionKey ||
        processRecord.record.brokerSocket !== paths.socket ||
        brokerProcessAlive(processRecord.record) !== false
      )
        throw new Error(
          "Failed broker process record is replaced or unverifiable.",
        );
      await removeBrokerProcessRecord(paths.pid, processRecord);
    } catch (error) {
      failures.push(error);
    }
  if (await exists(paths.lock)) {
    const lock = new BrokerLock(paths.lock, paths.socket);
    try {
      await lock.acquire();
      await lock.release();
    } catch (error) {
      failures.push(error);
      try {
        await lock.release();
      } catch (releaseError) {
        failures.push(releaseError);
      }
    }
  }
  if (await exists(paths.socket))
    try {
      await safeStaleSocket(paths.socket);
    } catch (error) {
      failures.push(error);
    }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Failed broker artifact cleanup failed.",
    );
}

async function inspectAuthenticatedStartup(
  paths: CanonicalResolvedPaths,
): Promise<void> {
  let observed: Awaited<ReturnType<typeof readStartup>>;
  try {
    observed = await readStartup(paths.startup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const command = await packageCommand();
  if (
    observed.record.sessionKey !== paths.sessionKey ||
    observed.record.brokerSocket !== paths.socket ||
    observed.record.commandPath !== command.path ||
    observed.record.commandDev !== command.dev ||
    observed.record.commandIno !== command.ino
  )
    throw new Error(
      "Broker startup record belongs to another or replaced session.",
    );
  const state = ownerState(observed.record);
  if (state === "unverifiable")
    throw new Error("Broker startup owner is live but cannot be verified.");
  if (state === "dead")
    await removeExactStartup(
      paths.startup,
      observed.record,
      observed.identity,
      observed.companion,
    );
}

export async function ensureBroker(): Promise<CanonicalResolvedPaths> {
  if (process.platform !== "linux")
    throw new Error("Broker startup requires Linux.");
  const { identity: herdr, paths } = await resolveHerdrPaths();
  const herdrBinary = await authoritativeHerdrBinary();
  await ensurePrivateDirectory(paths.root);
  await ensurePrivateDirectory(paths.runtime);
  await revalidateHerdrSocket(herdr);
  if (await authenticatedPing(paths)) {
    await inspectAuthenticatedStartup(paths);
    await revalidateHerdrSocket(herdr);
    await revalidateHerdrBinary(herdrBinary);
    await validateRetainedBrokerBinary(paths);
    return paths;
  }
  const command = await packageCommand();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    await revalidateHerdrSocket(herdr);
    const record: StartupRecord = {
      version: 1,
      nonce: randomBytes(16).toString("hex"),
      pid: process.pid,
      startIdentity: currentStart(),
      sessionKey: paths.sessionKey,
      brokerSocket: paths.socket,
      commandPath: command.path,
      commandDev: command.dev,
      commandIno: command.ino,
    };
    try {
      const startup = await publishStartup(paths.startup, record);
      let log: Awaited<ReturnType<typeof secureLog>>;
      try {
        log = await secureLog(paths.log);
      } catch (error) {
        try {
          await removeExactStartup(
            paths.startup,
            record,
            startup.identity,
            startup.companion,
          );
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Broker startup log and record cleanup failed.",
          );
        }
        throw error;
      }
      let child: ChildProcess | undefined;
      let childStart: string | undefined;
      let primary: unknown;
      const cleanupErrors: unknown[] = [];
      try {
        await revalidateHerdrBinary(herdrBinary);
        child = spawn(process.execPath, [command.path, "broker", "serve"], {
          shell: false,
          detached: true,
          env: minimalBrokerEnvironment(herdr, herdrBinary.path),
          stdio: ["ignore", log.fd, log.fd],
        });
        childStart = child.pid ? linuxProcessStart(child.pid) : undefined;
        if (!childStart)
          throw new Error("Spawned broker process identity is unavailable.");
        child.unref();
        await waitReady(paths, herdr, deadline, child);
        await revalidateHerdrBinary(herdrBinary);
      } catch (error) {
        primary = error;
        if (child && childStart) {
          try {
            await stopOwnedChild(child, childStart);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
          try {
            if (child.pid && !exactChildStillAlive(child.pid, childStart))
              await cleanupFailedChildArtifacts(paths, child.pid, childStart);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
      } finally {
        try {
          await log.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await removeExactStartup(
            paths.startup,
            record,
            startup.identity,
            startup.companion,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (
        primary === undefined &&
        cleanupErrors.length > 0 &&
        child &&
        childStart
      ) {
        try {
          await stopOwnedChild(child, childStart);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        try {
          if (child.pid && !exactChildStillAlive(child.pid, childStart))
            await cleanupFailedChildArtifacts(paths, child.pid, childStart);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (primary !== undefined || cleanupErrors.length) {
        const errors = [
          ...(primary !== undefined ? [primary] : []),
          ...cleanupErrors,
        ];
        throw errors.length === 1
          ? errors[0]
          : new AggregateError(errors, "Broker startup and cleanup failed.");
      }
      try {
        await revalidateHerdrBinary(herdrBinary);
      } catch (error) {
        const errors: unknown[] = [error];
        if (child && childStart) {
          try {
            await stopOwnedChild(child, childStart);
          } catch (cleanupError) {
            errors.push(cleanupError);
          }
          try {
            if (child.pid && !exactChildStillAlive(child.pid, childStart))
              await cleanupFailedChildArtifacts(paths, child.pid, childStart);
          } catch (cleanupError) {
            errors.push(cleanupError);
          }
        }
        throw errors.length === 1
          ? errors[0]
          : new AggregateError(
              errors,
              "Broker startup post-check and cleanup failed.",
            );
      }
      return paths;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let observed: Awaited<ReturnType<typeof readStartup>>;
      try {
        observed = await readStartup(paths.startup);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      if (
        observed.record.sessionKey !== paths.sessionKey ||
        observed.record.brokerSocket !== paths.socket ||
        observed.record.commandPath !== command.path ||
        observed.record.commandDev !== command.dev ||
        observed.record.commandIno !== command.ino
      )
        throw new Error(
          "Broker startup record belongs to another or replaced session.",
        );
      const state = ownerState(observed.record);
      if (state === "unverifiable")
        throw new Error("Broker startup owner is live but cannot be verified.");
      if (state === "live") {
        await waitReady(paths, herdr, deadline);
        await revalidateHerdrBinary(herdrBinary);
        await validateRetainedBrokerBinary(paths);
        return paths;
      }
      if (await authenticatedPing(paths)) {
        await inspectAuthenticatedStartup(paths);
        await revalidateHerdrSocket(herdr);
        await revalidateHerdrBinary(herdrBinary);
        await validateRetainedBrokerBinary(paths);
        return paths;
      }
      await safeStaleSocket(paths.socket);
      await removeExactStartup(
        paths.startup,
        observed.record,
        observed.identity,
        observed.companion,
      );
      if (Date.now() >= deadline)
        throw new Error("Broker startup recovery timed out.");
    }
  }
}

export async function brokerStatus(): Promise<{
  status: "running" | "stopped";
  sessionKey: string;
  result?: unknown;
}> {
  const { identity, paths } = await resolveHerdrPaths();
  await revalidateHerdrSocket(identity);
  if (!(await authenticatedPing(paths)))
    return { status: "stopped", sessionKey: paths.sessionKey };
  await inspectAuthenticatedStartup(paths);
  await revalidateHerdrSocket(identity);
  return {
    status: "running",
    sessionKey: paths.sessionKey,
    result: await brokerRequest(
      paths.socket,
      paths.secret,
      "system.status",
      {},
      paths.sessionKey,
      { timeoutMs: READY_TIMEOUT_MS },
    ),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function stopBroker(): Promise<"stopped" | "already_stopped"> {
  const { identity, paths } = await resolveHerdrPaths();
  await revalidateHerdrSocket(identity);
  const healthy = await authenticatedPing(paths);
  if (!healthy) {
    const remnants = await Promise.all([
      exists(paths.pid),
      exists(paths.lock),
      exists(paths.socket),
      exists(paths.startup),
    ]);
    if (!remnants.some(Boolean)) return "already_stopped";
    if (remnants[0]) {
      const existing = await readBrokerProcessRecord(paths.pid);
      if (
        existing.record.sessionKey !== paths.sessionKey ||
        existing.record.brokerSocket !== paths.socket
      )
        throw new Error("Broker process record belongs to another session.");
      const existingAlive = brokerProcessAlive(existing.record);
      if (existingAlive === undefined)
        throw new Error("Broker process identity is unverifiable.");
      if (existingAlive) {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          await revalidateHerdrSocket(identity);
          const alive = brokerProcessAlive(existing.record);
          let remaining = await Promise.all([
            exists(paths.pid),
            exists(paths.lock),
            exists(paths.socket),
            exists(paths.startup),
          ]);
          if (alive === false && remaining[3]) {
            await inspectAuthenticatedStartup(paths);
            remaining = await Promise.all([
              exists(paths.pid),
              exists(paths.lock),
              exists(paths.socket),
              exists(paths.startup),
            ]);
          }
          if (alive === false && !remaining.some(Boolean)) return "stopped";
          if (alive === undefined)
            throw new Error("Broker process exit became unverifiable.");
          await delay(Math.min(RETRY_MS, Math.max(1, deadline - Date.now())));
        }
        throw new Error("Concurrent broker shutdown timed out.");
      }
    }
    throw new Error(
      "Broker is unavailable; authenticated stop cannot recover it.",
    );
  }
  const processRecord = await readBrokerProcessRecord(paths.pid);
  if (
    processRecord.record.sessionKey !== paths.sessionKey ||
    processRecord.record.brokerSocket !== paths.socket ||
    brokerProcessAlive(processRecord.record) !== true
  )
    throw new Error(
      "Broker process identity is missing, replaced, or unverifiable.",
    );
  await brokerRequest(
    paths.socket,
    paths.secret,
    "system.shutdown",
    {},
    paths.sessionKey,
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await revalidateHerdrSocket(identity);
    const alive = brokerProcessAlive(processRecord.record);
    let remnants = await Promise.all([
      exists(paths.pid),
      exists(paths.lock),
      exists(paths.socket),
      exists(paths.startup),
    ]);
    if (alive === false && remnants[3]) {
      await inspectAuthenticatedStartup(paths);
      remnants = await Promise.all([
        exists(paths.pid),
        exists(paths.lock),
        exists(paths.socket),
        exists(paths.startup),
      ]);
    }
    if (alive === false && !remnants.some(Boolean)) return "stopped";
    if (alive === undefined)
      throw new Error("Broker process exit became unverifiable.");
    await delay(Math.min(RETRY_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error(
    "Broker shutdown timed out; no unrelated process was signaled.",
  );
}
