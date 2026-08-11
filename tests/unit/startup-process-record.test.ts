import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  rename,
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

function key(value = "a"): string {
  return value.repeat(24);
}

test("broker process record recovers an exact dead owner and removes its own record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orch-process-record-dead-"));
  const path = join(root, "broker.pid");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path,
    `${JSON.stringify({
      version: 1,
      nonce: "b".repeat(32),
      pid: 2_147_483_647,
      startIdentity: "1",
      sessionKey: key(),
      brokerSocket: join(root, "broker.sock"),
    })}\n`,
    { mode: 0o600 },
  );
  const owned = await createBrokerProcessRecord(
    path,
    key(),
    join(root, "broker.sock"),
  );
  assert.equal(owned.record.pid, process.pid);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  await removeBrokerProcessRecord(path, owned);
  await assert.rejects(lstat(path), { code: "ENOENT" });
});

test("broker process record cleanup preserves a replacement path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orch-process-record-replace-"));
  const path = join(root, "broker.pid");
  const original = join(root, "original.pid");
  t.after(() => rm(root, { recursive: true, force: true }));
  const owned = await createBrokerProcessRecord(
    path,
    key(),
    join(root, "broker.sock"),
  );
  await rename(path, original);
  const replacement = `${JSON.stringify({
    ...owned.record,
    nonce: "c".repeat(32),
  })}\n`;
  await writeFile(path, replacement, { mode: 0o600 });
  await assert.rejects(
    removeBrokerProcessRecord(path, owned),
    /changed before removal/u,
  );
  assert.equal(await readFile(path, "utf8"), replacement);
  assert.equal((await lstat(original)).ino, owned.identity.ino);
});

test("broker process record rejects a stale record from another session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orch-process-record-session-"));
  const path = join(root, "broker.pid");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path,
    `${JSON.stringify({
      version: 1,
      nonce: "d".repeat(32),
      pid: 2_147_483_647,
      startIdentity: "1",
      sessionKey: key("e"),
      brokerSocket: join(root, "other.sock"),
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    createBrokerProcessRecord(path, key(), join(root, "broker.sock")),
    /belongs to another session/u,
  );
});
