import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  finalizeStartupPublicationSync,
  finalizeStartupRemovalSync,
  type CompanionIdentity,
  type RecordIdentity,
  type StartupRecord,
} from "../../src/broker/startup.js";

function record(root: string, nonce: string): StartupRecord {
  return {
    version: 1,
    nonce,
    pid: 2_147_483_647,
    startIdentity: "1",
    sessionKey: "a".repeat(24),
    brokerSocket: join(root, "broker.sock"),
    commandPath: join(root, "pi-herdr-orchestrator"),
    commandDev: 1,
    commandIno: 1,
  };
}

async function identity(path: string): Promise<RecordIdentity> {
  const stat = await lstat(path);
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "startup-finalize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const replacement = "held replacement bytes\n";

test("two-link cleanup preserves a held public replacement", async (t) => {
  const root = await fixture(t);
  const path = join(root, "startup.lock");
  const value = record(root, "1".repeat(32));
  const companionPath = `${path}.create.${value.nonce}`;
  await writeFile(companionPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const owned = await identity(companionPath);
  await link(companionPath, path);
  const companion: CompanionIdentity = { path: companionPath, identity: owned };
  const retained = join(root, "owned-public-retained");
  await rename(path, retained);
  await writeFile(path, replacement, { mode: 0o600 });

  assert.throws(
    () => finalizeStartupRemovalSync(path, value, owned, companion),
    /identity changed before removal/u,
  );
  assert.equal(await readFile(path, "utf8"), replacement);
  assert.equal((await lstat(retained)).ino, owned.ino);
  assert.equal((await lstat(companionPath)).ino, owned.ino);
});

test("two-link cleanup preserves a held companion replacement", async (t) => {
  const root = await fixture(t);
  const path = join(root, "startup.lock");
  const value = record(root, "2".repeat(32));
  const companionPath = `${path}.create.${value.nonce}`;
  await writeFile(companionPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const owned = await identity(companionPath);
  await link(companionPath, path);
  const retained = join(root, "owned-companion-retained");
  await rename(companionPath, retained);
  await writeFile(companionPath, replacement, { mode: 0o600 });

  assert.throws(
    () =>
      finalizeStartupRemovalSync(path, value, owned, {
        path: companionPath,
        identity: owned,
      }),
    /identity changed before removal/u,
  );
  assert.equal(await readFile(companionPath, "utf8"), replacement);
  assert.equal((await lstat(path)).ino, owned.ino);
  assert.equal((await lstat(retained)).ino, owned.ino);
});

test("publication preserves a held temporary replacement", async (t) => {
  const root = await fixture(t);
  const path = join(root, "startup.lock");
  const value = record(root, "3".repeat(32));
  const temporary = `${path}.create.${value.nonce}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const owned = await identity(temporary);
  const retained = join(root, "owned-temporary-retained");
  await rename(temporary, retained);
  await writeFile(temporary, replacement, { mode: 0o600 });

  assert.throws(
    () => finalizeStartupPublicationSync(path, temporary, value, owned),
    /identity changed before removal/u,
  );
  await assert.rejects(lstat(path), { code: "ENOENT" });
  assert.equal(await readFile(temporary, "utf8"), replacement);
  assert.equal((await lstat(retained)).ino, owned.ino);
});

test("one-link cleanup preserves a held cleanup-path replacement", async (t) => {
  const root = await fixture(t);
  const path = join(root, "startup.lock");
  const value = record(root, "4".repeat(32));
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const owned = await identity(path);
  const retained = join(root, "owned-one-link-retained");
  await rename(path, retained);
  await writeFile(path, replacement, { mode: 0o600 });

  assert.throws(
    () => finalizeStartupRemovalSync(path, value, owned),
    /identity changed before removal/u,
  );
  assert.equal(await readFile(path, "utf8"), replacement);
  assert.equal((await lstat(retained)).ino, owned.ino);
});
