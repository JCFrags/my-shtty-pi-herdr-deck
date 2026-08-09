import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { BridgeServer, recoverStaleSocket, runtimeDirectoryFor, socketLocationForPane } from "../../src/bridge/server.js";
import { FakeController } from "../helpers.js";

test("socket location uses XDG_RUNTIME_DIR fallback, sanitized pane ID, and bounded path", () => {
  assert.equal(runtimeDirectoryFor(123, { XDG_RUNTIME_DIR: "/run/user/123" }), "/run/user/123/pi-herdr-deck-123");
  assert.equal(runtimeDirectoryFor(123, {}), join(tmpdir(), "pi-herdr-deck-123"));
  const location = socketLocationForPane("workspace 1/pane:2?", { runtimeDirectory: "/tmp/pi-deck-test" });
  assert.match(location.sanitizedPaneId, /^workspace-1-pane-2-[a-f0-9]{12}$/);
  assert.equal(basename(location.socketPath), `${location.sanitizedPaneId}.sock`);
  assert.ok(Buffer.byteLength(location.socketPath) <= 103);
});

test("bridge creates runtime directory 0700 and socket 0600, then unlinks on close", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-deck-socket-"));
  const runtimeDirectory = join(root, "runtime");
  const server = new BridgeServer({ controller: new FakeController(), runtimeDirectory });
  await server.start();
  const directoryStat = await lstat(runtimeDirectory);
  const socketStat = await lstat(server.socketPath);
  assert.equal(directoryStat.mode & 0o777, 0o700);
  assert.equal(socketStat.isSocket(), true);
  assert.equal(socketStat.mode & 0o777, 0o600);
  await server.close();
  await assert.rejects(lstat(server.socketPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("concurrent bridge starts leave one owner and reject the other", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-deck-concurrent-"));
  const first = new BridgeServer({ controller: new FakeController(), runtimeDirectory: root });
  const second = new BridgeServer({ controller: new FakeController(), runtimeDirectory: root });
  const results = await Promise.allSettled([first.start(), second.start()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  await first.close();
  await second.close();
});

test("stale socket recovery verifies no listener before unlinking", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-deck-stale-"));
  await chmod(root, 0o700);
  const stalePath = join(root, "stale.sock");
  const result = spawnSync("python3", ["-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])", stalePath]);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal((await lstat(stalePath)).isSocket(), true);
  assert.equal(await recoverStaleSocket(stalePath), "removed");
  await assert.rejects(lstat(stalePath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("live sockets and non-socket paths are never removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-deck-live-"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const livePath = join(root, "live.sock");
  const live = createServer();
  await new Promise<void>((resolve, reject) => {
    live.once("error", reject);
    live.listen(livePath, resolve);
  });
  await assert.rejects(recoverStaleSocket(livePath), /already listening/);
  assert.equal((await lstat(livePath)).isSocket(), true);
  await new Promise<void>((resolve) => live.close(() => resolve()));

  const regularPath = join(root, "not-a-socket.sock");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(regularPath, "do not delete"));
  await assert.rejects(recoverStaleSocket(regularPath), /Refusing to remove non-socket/);
  assert.equal((await lstat(regularPath)).isFile(), true);
});
