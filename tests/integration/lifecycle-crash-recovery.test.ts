import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createBrokerProcessRecord,
  removeBrokerProcessRecord,
} from "../../src/broker/process-record.js";
import { BrokerLock } from "../../src/broker/lock.js";

const projectRoot = process.cwd();
const childModule = join(
  projectRoot,
  "dist",
  "tests",
  "helpers",
  "lifecycle-crash-child.js",
);
async function runCrash(
  mode: string,
  path: string,
  sessionKey: string,
  socket: string,
): Promise<Record<string, unknown>> {
  const result = await new Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [childModule, mode, path, sessionKey, socket],
      { cwd: projectRoot, shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Lifecycle crash child timed out in ${mode}.`));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
  const expected = new Map([
    ["process-before", 81],
    ["process-boundary", 82],
    ["process-owned", 83],
    ["lock-before", 84],
    ["lock-boundary", 85],
    ["lock-owned", 86],
    ["lock-dead-guard-owned", 87],
    ["lock-dead-guard-boundary", 88],
  ]).get(mode);
  assert.equal(result.code, expected, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
async function missing(path: string): Promise<void> {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

test("separate process-record crashes converge through publication and exact dead-owner recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orch-pid-crash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "broker.pid");
  const socket = join(root, "broker.sock");
  const sessionKey = "a".repeat(24);

  for (const mode of ["process-before", "process-boundary", "process-owned"]) {
    const receipt = await runCrash(mode, path, sessionKey, socket);
    const recovered = await createBrokerProcessRecord(path, sessionKey, socket);
    assert.equal(recovered.record.pid, process.pid);
    if (typeof receipt.companion === "string") await missing(receipt.companion);
    await removeBrokerProcessRecord(path, recovered);
    await missing(path);
    assert.deepEqual(await readdir(root), []);
  }

  const malformed = "malformed public replacement\n";
  await writeFile(path, malformed, { mode: 0o600 });
  await assert.rejects(
    createBrokerProcessRecord(path, sessionKey, socket),
    /unsafe/u,
  );
  assert.equal(await readFile(path, "utf8"), malformed);
});

test("separate lifetime-lock crashes converge and leave zero receipt-owned remnants", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orch-lock-crash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "broker.lock");
  const socket = join(root, "broker.sock");
  const sessionKey = "b".repeat(24);

  for (const mode of ["lock-before", "lock-boundary", "lock-owned"]) {
    const receipt = await runCrash(mode, path, sessionKey, socket);
    const lock = new BrokerLock(path, socket);
    await lock.acquire();
    if (typeof receipt.companion === "string") await missing(receipt.companion);
    await lock.release();
    await missing(path);
    await missing(`${path}.recovery`);
    assert.deepEqual(await readdir(root), []);
  }

  for (const mode of ["lock-dead-guard-owned", "lock-dead-guard-boundary"]) {
    const receipt = await runCrash(mode, path, sessionKey, socket);
    const lock = new BrokerLock(path, socket);
    await lock.acquire();
    await lock.release();
    await missing(path);
    await missing(`${path}.recovery`);
    if (typeof receipt.guardCompanion === "string")
      await missing(receipt.guardCompanion);
    assert.deepEqual(await readdir(root), []);
  }

  const replacement = "malformed lock replacement\n";
  await writeFile(path, replacement, { mode: 0o600 });
  const refused = new BrokerLock(path, socket);
  await assert.rejects(refused.acquire(), /unsafe/u);
  assert.equal(await readFile(path, "utf8"), replacement);
});

test("stale lifetime-lock recovery preserves another configured socket record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orch-lock-socket-mismatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "broker.lock");
  const firstSocket = join(root, "first.sock");
  const secondSocket = join(root, "second.sock");

  await runCrash("lock-owned", path, "c".repeat(24), firstSocket);
  const before = await readFile(path, "utf8");
  await assert.rejects(
    new BrokerLock(path, secondSocket).acquire(),
    /another configured socket/u,
  );
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(await readdir(root), ["broker.lock"]);

  const cleanup = new BrokerLock(path, firstSocket);
  await cleanup.acquire();
  await cleanup.release();
  assert.deepEqual(await readdir(root), []);
});

test("stale lifetime-lock recovery preserves a wrong-mode public record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orch-lock-wrong-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "broker.lock");
  const socket = join(root, "broker.sock");

  await runCrash("lock-owned", path, "d".repeat(24), socket);
  await chmod(path, 0o700);
  const before = await readFile(path, "utf8");
  await assert.rejects(new BrokerLock(path, socket).acquire(), /unsafe/u);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal((await lstat(path)).mode & 0o777, 0o700);

  await chmod(path, 0o600);
  const cleanup = new BrokerLock(path, socket);
  await cleanup.acquire();
  await cleanup.release();
  assert.deepEqual(await readdir(root), []);
});

test("lifetime-lock admission bounds a public record before whole-file parsing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orch-lock-oversized-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "broker.lock");
  const socket = join(root, "broker.sock");
  const oversized = "x".repeat(4097);

  await writeFile(path, oversized, { mode: 0o600 });
  await assert.rejects(new BrokerLock(path, socket).acquire(), /unsafe/u);
  assert.equal(await readFile(path, "utf8"), oversized);
  assert.deepEqual(await readdir(root), ["broker.lock"]);
  await rm(path);
  assert.deepEqual(await readdir(root), []);
});
