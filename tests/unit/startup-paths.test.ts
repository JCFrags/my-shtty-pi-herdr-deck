import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalHerdrSocket,
  revalidateHerdrSocket,
  resolvePaths,
  sessionKey,
} from "../../src/shared/paths.js";

function listen(path: string): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("canonical Herdr socket bytes derive one session and cross-session paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orch-canonical-session-"));
  const firstPath = join(root, "first.sock");
  const secondPath = join(root, "second.sock");
  const first = await listen(firstPath);
  const second = await listen(secondPath);
  t.after(async () => {
    await close(first);
    await close(second);
    await rm(root, { recursive: true, force: true });
  });
  await chmod(firstPath, 0o600);
  await chmod(secondPath, 0o600);
  const identity = await canonicalHerdrSocket(firstPath);
  const paths = resolvePaths(identity.path);
  assert.equal(paths.sessionKey, sessionKey(Buffer.from(firstPath).toString()));
  assert.equal(paths.herdrSocket, firstPath);
  assert.notEqual(paths.socket, firstPath);
  assert.notEqual(resolvePaths(secondPath).runtime, paths.runtime);
  await revalidateHerdrSocket(identity);
});

test("canonical Herdr socket rejects wrong type, mode, symlink, and replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orch-canonical-reject-"));
  const regular = join(root, "regular");
  await writeFile(regular, "not a socket", { mode: 0o600 });
  await assert.rejects(
    canonicalHerdrSocket(regular),
    /owner-only Unix socket/u,
  );

  const socketPath = join(root, "real.sock");
  let server = await listen(socketPath);
  t.after(async () => {
    if (server.listening) await close(server);
    await rm(root, { recursive: true, force: true });
  });
  await chmod(socketPath, 0o660);
  await assert.rejects(
    canonicalHerdrSocket(socketPath),
    /owner-only Unix socket/u,
  );
  await chmod(socketPath, 0o600);
  const link = join(root, "link.sock");
  await symlink(socketPath, link);
  await assert.rejects(canonicalHerdrSocket(link), /symlink|noncanonical/u);

  const identity = await canonicalHerdrSocket(socketPath);
  await close(server);
  server = await listen(socketPath);
  await chmod(socketPath, 0o600);
  await assert.rejects(
    revalidateHerdrSocket(identity),
    /changed after session resolution/u,
  );
  await assert.rejects(
    canonicalHerdrSocket("relative.sock"),
    /canonical absolute/u,
  );
});
