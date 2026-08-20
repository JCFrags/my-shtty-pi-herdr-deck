import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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
  minimalBrokerEnvironment,
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

test("broker startup forwards only the exact compact rollback switch", () => {
  const prior = process.env.PI_HERDR_COMPACT_DELEGATION;
  const identity = {
    path: "/run/user/1000/herdr.sock",
    dev: 1n,
    ino: 2n,
    uid: BigInt(process.getuid?.() ?? 1000),
    ctimeNs: 3n,
    birthtimeNs: 4n,
  };
  try {
    process.env.PI_HERDR_COMPACT_DELEGATION = "0";
    assert.equal(
      minimalBrokerEnvironment(identity, "/usr/bin/herdr")
        .PI_HERDR_COMPACT_DELEGATION,
      "0",
    );
    process.env.PI_HERDR_COMPACT_DELEGATION = "1";
    assert.equal(
      minimalBrokerEnvironment(identity, "/usr/bin/herdr")
        .PI_HERDR_COMPACT_DELEGATION,
      undefined,
    );
    process.env.PI_HERDR_COMPACT_DELEGATION = "unexpected";
    assert.equal(
      minimalBrokerEnvironment(identity, "/usr/bin/herdr")
        .PI_HERDR_COMPACT_DELEGATION,
      undefined,
    );
  } finally {
    if (prior === undefined) delete process.env.PI_HERDR_COMPACT_DELEGATION;
    else process.env.PI_HERDR_COMPACT_DELEGATION = prior;
  }
});

interface MutationEvent {
  mask: number;
  name: string;
}

function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out.`)),
      5_000,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function startMutationWatcher(root: string): Promise<{
  child: ChildProcess;
  events: Promise<MutationEvent[]>;
}> {
  const script = String.raw`
import ctypes, json, os, select, struct, sys, time
IN_MOVED_FROM = 0x40
IN_MOVED_TO = 0x80
IN_DELETE = 0x200
libc = ctypes.CDLL(None, use_errno=True)
fd = libc.inotify_init1(os.O_CLOEXEC)
if fd < 0:
    raise OSError(ctypes.get_errno(), "inotify_init1")
if libc.inotify_add_watch(fd, os.fsencode(sys.argv[1]), IN_MOVED_FROM | IN_MOVED_TO | IN_DELETE) < 0:
    raise OSError(ctypes.get_errno(), "inotify_add_watch")
print("READY", flush=True)
events = []
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    readable, _, _ = select.select([fd], [], [], max(0, deadline - time.monotonic()))
    if not readable:
        break
    data = os.read(fd, 65536)
    offset = 0
    while offset < len(data):
        _, mask, _, length = struct.unpack_from("iIII", data, offset)
        offset += 16
        name = data[offset:offset + length].split(b"\0", 1)[0].decode()
        offset += length
        if name:
            events.append({"mask": mask, "name": name})
    if any((event["mask"] & IN_DELETE) and ".remove." in event["name"] for event in events):
        print(json.dumps(events), flush=True)
        os.close(fd)
        sys.exit(0)
raise TimeoutError("owned mutation events did not complete")
`;
  const child = spawn("python3", ["-u", "-c", script, root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  let eventsResolve!: (events: MutationEvent[]) => void;
  let eventsReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const events = new Promise<MutationEvent[]>((resolve, reject) => {
    eventsResolve = resolve;
    eventsReject = reject;
  });
  let readyDone = false;
  let eventsDone = false;
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString("utf8");
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    for (;;) {
      const newline = output.indexOf("\n");
      if (newline < 0) break;
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      if (line === "READY" && !readyDone) {
        readyDone = true;
        readyResolve();
      } else if (line.startsWith("[") && !eventsDone) {
        eventsDone = true;
        eventsResolve(JSON.parse(line) as MutationEvent[]);
      }
    }
  });
  child.once("error", (error) => {
    if (!readyDone) {
      readyDone = true;
      readyReject(error);
    }
    if (!eventsDone) {
      eventsDone = true;
      eventsReject(error);
    }
  });
  child.once("exit", (code, signal) => {
    const failure = new Error(
      `inotify watcher exited before evidence (${code ?? signal ?? "unknown"}): ${errors}`,
    );
    if (!readyDone) {
      readyDone = true;
      readyReject(failure);
    }
    if (!eventsDone) {
      eventsDone = true;
      eventsReject(failure);
    }
  });
  await bounded(ready, "inotify watcher readiness");
  return { child, events: bounded(events, "inotify mutation evidence") };
}

async function stopWatcher(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await bounded(exited, "inotify watcher cleanup");
}

test("two-link cleanup removes the companion before public quarantine", async (t) => {
  const root = await fixture(t);
  const path = join(root, "startup.lock");
  const value = record(root, "0".repeat(32));
  const companionPath = `${path}.create.${value.nonce}`;
  await writeFile(companionPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const owned = await identity(companionPath);
  await link(companionPath, path);
  const watcher = await startMutationWatcher(root);
  try {
    finalizeStartupRemovalSync(path, value, owned, {
      path: companionPath,
      identity: owned,
    });
    const events = await watcher.events;
    const companionDeletes = events
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          event.name === "startup.lock.create." + value.nonce &&
          (event.mask & 0x200) !== 0,
      );
    const publicMoves = events
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          event.name === "startup.lock" && (event.mask & 0x40) !== 0,
      );
    assert.equal(companionDeletes.length, 1);
    assert.equal(publicMoves.length, 1);
    assert.ok(companionDeletes[0]!.index < publicMoves[0]!.index);
    assert.equal(
      events.filter(
        (event) =>
          event.name === "startup.lock.create." + value.nonce &&
          (event.mask & 0x40) !== 0,
      ).length,
      0,
    );
    await assert.rejects(lstat(path), { code: "ENOENT" });
    await assert.rejects(lstat(companionPath), { code: "ENOENT" });
  } finally {
    await stopWatcher(watcher.child);
  }
});

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
