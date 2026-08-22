import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  doctor,
  unavailableDoctorReport,
  validateDoctorReport,
} from "../../src/broker/doctor.js";
import { main } from "../../src/cli/main.js";

const healthy = {
  version: "0.1.0",
  platform: "linux",
  node: "22.19.0",
  checks: [
    {
      name: "herdr",
      available: true,
      mandatory: true,
      detail: "available",
    },
  ],
  ok: true,
};

test("doctor report validation preserves the frozen response shape", () => {
  assert.deepEqual(validateDoctorReport(healthy), healthy);
  assert.deepEqual(Object.keys(unavailableDoctorReport()), [
    "version",
    "platform",
    "node",
    "checks",
    "ok",
  ]);
});

test("a safe doctor report never exposes its retained binary path", async () => {
  const report = await doctor({
    herdrBinary: process.execPath,
    schema: { methods: [] },
  });
  const encoded = JSON.stringify(report);
  assert.equal(encoded.includes(process.execPath), false);
  assert.equal(
    report.checks.find((check) => check.name === "herdr-binary")?.detail,
    "Authoritative Herdr binary is executable.",
  );
  assert.deepEqual(
    report.checks.find(
      (check) => check.name === "provider-projection-contracts",
    ),
    {
      name: "provider-projection-contracts",
      available: true,
      mandatory: false,
      detail:
        "Agent Board and Todo event adapters are installed. Providers are optional.",
    },
  );
});

test("doctor report validation rejects malformed and secret-bearing reports without echo", () => {
  const privateValue = "private-session-key-value";
  for (const report of [
    { ...healthy, secret: privateValue },
    { ...healthy, ok: false },
    {
      ...healthy,
      checks: [{ ...healthy.checks[0], detail: privateValue.repeat(100) }],
    },
  ])
    assert.throws(
      () => validateDoctorReport(report),
      (error: unknown) =>
        error instanceof Error && !error.message.includes(privateValue),
    );
});

test("CLI doctor ignores an ambient Herdr binary and keeps private input bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-ambient-binary-"));
  const binary = join(root, "ambient-herdr");
  const receipt = join(root, "ambient-executed");
  const privateInput = "private-ambient-doctor-input";
  await writeFile(
    binary,
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(receipt)}, "executed");\nprocess.stdout.write(${JSON.stringify(privateInput)});\n`,
    { mode: 0o700 },
  );
  const previous = {
    binary: process.env.HERDR_BIN_PATH,
    socket: process.env.HERDR_SOCKET_PATH,
    runtime: process.env.PI_HERDR_ORCH_RUNTIME_ROOT,
    state: process.env.PI_HERDR_ORCH_STATE_ROOT,
    exitCode: process.exitCode,
  };
  const output: string[] = [];
  const originalLog = console.log;
  process.env.HERDR_BIN_PATH = binary;
  process.env.HERDR_SOCKET_PATH = join(root, "absent-herdr.sock");
  process.env.PI_HERDR_ORCH_RUNTIME_ROOT = join(root, "runtime");
  process.env.PI_HERDR_ORCH_STATE_ROOT = join(root, "state");
  process.exitCode = undefined;
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  let bodyError: unknown;
  try {
    await main(["doctor", "--json"]);
    assert.equal(process.exitCode, 1);
    assert.equal(output.length, 1);
    assert.equal(output[0]!.includes(privateInput), false);
    assert.equal(output[0]!.includes(binary), false);
    await assert.rejects(readFile(receipt), { code: "ENOENT" });
    assert.equal(validateDoctorReport(JSON.parse(output[0]!)).ok, false);
  } catch (error) {
    bodyError = error;
  } finally {
    const teardownErrors: unknown[] = [];
    console.log = originalLog;
    if (previous.binary === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = previous.binary;
    if (previous.socket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previous.socket;
    if (previous.runtime === undefined)
      delete process.env.PI_HERDR_ORCH_RUNTIME_ROOT;
    else process.env.PI_HERDR_ORCH_RUNTIME_ROOT = previous.runtime;
    if (previous.state === undefined)
      delete process.env.PI_HERDR_ORCH_STATE_ROOT;
    else process.env.PI_HERDR_ORCH_STATE_ROOT = previous.state;
    process.exitCode = previous.exitCode;
    await rm(root, { recursive: true, force: true }).catch((error) =>
      teardownErrors.push(error),
    );
    if (bodyError !== undefined || teardownErrors.length)
      throw new AggregateError(
        [bodyError, ...teardownErrors].filter((value) => value !== undefined),
        "Ambient doctor body or teardown failed.",
      );
  }
});

test("ordinary attach-only doctor returns bounded JSON and exit 1 when broker is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-fallback-"));
  const herdrSocket = join(root, "herdr.sock");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(herdrSocket, resolve);
  });
  await chmod(herdrSocket, 0o600);
  const previous = {
    binary: process.env.HERDR_BIN_PATH,
    socket: process.env.HERDR_SOCKET_PATH,
    runtime: process.env.PI_HERDR_ORCH_RUNTIME_ROOT,
    state: process.env.PI_HERDR_ORCH_STATE_ROOT,
    exitCode: process.exitCode,
  };
  const output: string[] = [];
  const originalLog = console.log;
  delete process.env.HERDR_BIN_PATH;
  process.env.HERDR_SOCKET_PATH = herdrSocket;
  process.env.PI_HERDR_ORCH_RUNTIME_ROOT = join(root, "runtime");
  process.env.PI_HERDR_ORCH_STATE_ROOT = join(root, "state");
  process.exitCode = undefined;
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  let bodyError: unknown;
  try {
    await main(["doctor", "--json"]);
    assert.equal(process.exitCode, 1);
    assert.equal(output.length, 1);
    const report = validateDoctorReport(JSON.parse(output[0]!));
    assert.equal(report.ok, false);
    assert.equal(report.checks[0]?.name, "broker");
    assert.equal(output[0]!.includes("secret"), false);
    assert.ok(Buffer.byteLength(output[0]!, "utf8") < 1024);
  } catch (error) {
    bodyError = error;
  } finally {
    const teardownErrors: unknown[] = [];
    console.log = originalLog;
    if (previous.binary === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = previous.binary;
    if (previous.socket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previous.socket;
    if (previous.runtime === undefined)
      delete process.env.PI_HERDR_ORCH_RUNTIME_ROOT;
    else process.env.PI_HERDR_ORCH_RUNTIME_ROOT = previous.runtime;
    if (previous.state === undefined)
      delete process.env.PI_HERDR_ORCH_STATE_ROOT;
    else process.env.PI_HERDR_ORCH_STATE_ROOT = previous.state;
    process.exitCode = previous.exitCode;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ).catch((error) => teardownErrors.push(error));
    await rm(root, { recursive: true, force: true }).catch((error) =>
      teardownErrors.push(error),
    );
    if (bodyError !== undefined || teardownErrors.length > 0)
      throw new AggregateError(
        [bodyError, ...teardownErrors].filter((value) => value !== undefined),
        "Doctor fallback body or teardown failed.",
      );
  }
});
