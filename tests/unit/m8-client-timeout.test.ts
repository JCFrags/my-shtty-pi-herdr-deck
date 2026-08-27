import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BrokerRequestTimeoutError,
  brokerRequest,
} from "../../src/cli/client.js";

const listen = (server: ReturnType<typeof createServer>, path: string) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });

const close = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

test("broker request timeout identifies method, phase, elapsed time, and bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-m8-timeout-"));
  const socketPath = join(root, "broker.sock");
  const secretPath = join(root, "client.secret");
  await writeFile(secretPath, `${"a".repeat(43)}\n`);
  await chmod(secretPath, 0o600);
  const connections = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  try {
    await listen(server, socketPath);
    await assert.rejects(
      () =>
        brokerRequest(socketPath, secretPath, "system.status", {}, undefined, {
          timeoutMs: 25,
        }),
      (error: unknown) => {
        if (!(error instanceof BrokerRequestTimeoutError)) return false;
        assert.equal(error.method, "system.status");
        assert.equal(error.phase, "response");
        assert.equal(error.timeoutMs, 25);
        assert.ok(error.elapsedMs >= 20);
        assert.match(error.message, /system\.status/u);
        assert.match(error.message, /response/u);
        return true;
      },
    );
  } finally {
    for (const socket of connections) socket.destroy();
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("startup retries only the known timeout inside its existing readiness bound", async () => {
  const source = await readFile(
    join(process.cwd(), "src", "broker", "startup.ts"),
    "utf8",
  );
  const pingStart = source.indexOf("async function authenticatedPing");
  const pingEnd = source.indexOf("async function validateRetainedBrokerBinary");
  const waitStart = source.indexOf("async function waitReady");
  const waitEnd = source.indexOf("function waitForChildExit", waitStart);
  const statusStart = source.indexOf("export async function brokerStatus");
  const statusEnd = source.indexOf("async function exists", statusStart);
  assert.ok(pingStart >= 0 && pingEnd > pingStart);
  assert.ok(waitStart >= 0 && waitEnd > waitStart);
  assert.ok(statusStart >= 0 && statusEnd > statusStart);
  const ping = source.slice(pingStart, pingEnd);
  const wait = source.slice(waitStart, waitEnd);
  const status = source.slice(statusStart, statusEnd);
  assert.match(
    ping,
    /options\.timeoutIsTransient\s*&&\s*error instanceof BrokerRequestTimeoutError/u,
  );
  assert.match(wait, /timeoutIsTransient:\s*true/u);
  assert.match(wait, /timeoutMs:\s*Math\.min\(5_000, remainingMs\)/u);
  assert.match(status, /timeoutMs:\s*READY_TIMEOUT_MS/u);
});
