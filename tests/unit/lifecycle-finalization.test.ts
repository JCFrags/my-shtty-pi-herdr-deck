import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createBrokerProcessRecord,
  finalizeBrokerProcessRecordRemovalSync,
  finalizeUnpublishedBrokerProcessRecordRemovalSync,
  readBrokerProcessRecord,
} from "../../src/broker/process-record.js";
import {
  finalizeLockRemovalSync,
  finalizeLockTeardown,
  type LockPathIdentity,
  type LockRecord,
} from "../../src/broker/lock.js";
import {
  Broker,
  finalizeStaleSocketRemovalSync,
} from "../../src/broker/broker.js";

const replacement = "held replacement must survive\n";
async function fixture(t: TestContext, label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `orch-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function missing(path: string): Promise<void> {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}
function identity(stat: {
  dev: number;
  ino: number;
  uid: number;
}): LockPathIdentity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}

for (const creationFailure of [false, true]) {
  test(`process-record ${creationFailure ? "creation-failure" : "normal"} finalizer preserves a post-open quarantine replacement`, async (t) => {
    const root = await fixture(t, "pid-held");
    const path = join(root, "broker.pid");
    const owned = await createBrokerProcessRecord(
      path,
      "a".repeat(24),
      join(root, "broker.sock"),
    );
    const quarantine = `${path}.held`;
    await rename(path, quarantine);
    await readBrokerProcessRecord(quarantine);
    const retained = `${quarantine}.owned-retained`;
    await rename(quarantine, retained);
    await writeFile(quarantine, replacement, { mode: 0o600 });

    assert.throws(
      () =>
        creationFailure
          ? finalizeUnpublishedBrokerProcessRecordRemovalSync(
              quarantine,
              owned.record,
              owned.identity,
            )
          : finalizeBrokerProcessRecordRemovalSync(
              path,
              quarantine,
              owned.record,
              owned.identity,
            ),
      /identity changed|cleanup/u,
    );
    assert.equal(await readFile(quarantine, "utf8"), replacement);
    assert.equal((await lstat(retained)).ino, owned.identity.ino);
    await missing(path);
  });
}

for (const label of ["release", "stale-recovery", "recovery-guard"] as const) {
  test(`lock ${label} finalizer preserves held quarantine and original replacements`, async (t) => {
    const root = await fixture(t, `lock-${label}`);
    const path = join(root, `${label}.lock`);
    const record: LockRecord = {
      pid: process.pid,
      nonce: "b".repeat(32),
      startIdentity: "1",
      expectedSocket: join(root, "broker.sock"),
    };
    await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const owned = identity(await lstat(path));
    const quarantine = `${path}.held`;
    await rename(path, quarantine);
    const retained = `${quarantine}.owned-retained`;
    await rename(quarantine, retained);
    await writeFile(quarantine, replacement, { mode: 0o600 });
    await writeFile(path, "original replacement\n", { mode: 0o600 });

    assert.throws(
      () => finalizeLockRemovalSync(path, quarantine, record, owned),
      /identity changed|restoration/u,
    );
    assert.equal(await readFile(quarantine, "utf8"), replacement);
    assert.equal(await readFile(path, "utf8"), "original replacement\n");
    assert.equal((await lstat(retained)).ino, owned.ino);
  });
}

test("lock teardown reports owned handle-close and finalization failures together", async (t) => {
  const root = await fixture(t, "lock-close-errors");
  const path = join(root, "broker.lock");
  const quarantine = `${path}.release`;
  const retained = `${quarantine}.owned-retained`;
  const record: LockRecord = {
    pid: process.pid,
    nonce: "c".repeat(32),
    startIdentity: "1",
    expectedSocket: join(root, "broker.sock"),
  };
  await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const owned = identity(await lstat(path));
  await rename(path, quarantine);
  await rename(quarantine, retained);
  await writeFile(quarantine, replacement, { mode: 0o600 });
  const failingHandle = {
    async close(): Promise<void> {
      throw new Error("owned handle close failed");
    },
  };

  await assert.rejects(
    finalizeLockTeardown(failingHandle, path, quarantine, record, owned),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[0]), /owned handle close failed/u);
      assert.ok(error.errors[1] instanceof AggregateError);
      assert.match(
        error.errors[1].errors.map(String).join("\n"),
        /identity changed[\s\S]*identity changed/u,
      );
      return true;
    },
  );
  assert.equal(await readFile(quarantine, "utf8"), replacement);
  assert.equal((await lstat(retained)).ino, owned.ino);
});

async function staleSocket(
  root: string,
  name: string,
): Promise<{
  path: string;
  identity: { dev: number; ino: number; uid: number };
}> {
  const path = join(root, name);
  const server = createServer();
  await new Promise<void>((resolve, reject) =>
    server.once("error", reject).listen(path, resolve),
  );
  const stat = await lstat(path);
  const retained = `${path}.stale`;
  await rename(path, retained);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return {
    path: retained,
    identity: { dev: stat.dev, ino: stat.ino, uid: stat.uid },
  };
}

for (const label of ["startup-stale", "shutdown-quarantine"] as const) {
  test(`${label} socket finalizer preserves a held regular replacement`, async (t) => {
    const root = await fixture(t, label);
    const original = join(root, "broker.sock");
    const stale = await staleSocket(root, "source.sock");
    await rename(stale.path, `${stale.path}.owned-retained`);
    await writeFile(stale.path, replacement, { mode: 0o600 });
    assert.throws(
      () =>
        finalizeStaleSocketRemovalSync(original, stale.path, stale.identity),
      /identity changed/u,
    );
    assert.equal(await readFile(stale.path, "utf8"), replacement);
    assert.equal(
      (await lstat(`${stale.path}.owned-retained`)).ino,
      stale.identity.ino,
    );
  });
}

test("broker shutdown quarantine preserves a regular replacement path", async (t) => {
  const root = await fixture(t, "shutdown-regular");
  const broker = new Broker({
    root,
    runtime: join(root, "runtime"),
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(root, "broker.lock"),
    socket: join(root, "broker.sock"),
    secret: join(root, "secret"),
  });
  await broker.start();
  await unlink(broker.paths.socket);
  await writeFile(broker.paths.socket, replacement, { mode: 0o600 });
  await assert.rejects(broker.stop(), /identity/u);
  assert.equal(await readFile(broker.paths.socket, "utf8"), replacement);
});

test("stale socket finalizer preserves a held replacement socket", async (t) => {
  const root = await fixture(t, "socket-replacement");
  const original = join(root, "broker.sock");
  const stale = await staleSocket(root, "quarantine.sock");
  const retained = `${stale.path}.owned-retained`;
  await rename(stale.path, retained);
  const replacementServer = createServer();
  await new Promise<void>((resolve, reject) =>
    replacementServer.once("error", reject).listen(stale.path, resolve),
  );
  try {
    assert.throws(
      () =>
        finalizeStaleSocketRemovalSync(original, stale.path, stale.identity),
      /identity changed/u,
    );
    assert.equal((await lstat(stale.path)).isSocket(), true);
    assert.equal((await lstat(retained)).ino, stale.identity.ino);
  } finally {
    await new Promise<void>((resolve) =>
      replacementServer.close(() => resolve()),
    );
  }
});
