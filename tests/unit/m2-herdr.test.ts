import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectCapabilities } from "../../src/herdr/capabilities.js";
import { HerdrCli } from "../../src/herdr/cli.js";
import { herdrName, branchSlug, tokenDigest } from "../../src/herdr/names.js";
import { normalizeSnapshot } from "../../src/herdr/normalizers.js";
import { parsePorcelainV2 } from "../../src/git/porcelain.js";
import {
  HerdrProcessError,
  HerdrProcessRunner,
} from "../../src/herdr/runner.js";
import { linuxProcessStart } from "../../src/broker/startup.js";

async function waitExactTestProcessGone(
  pid: number,
  startIdentity: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (linuxProcessStart(pid) === startIdentity) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for exact runner fixture exit.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function terminateExactRunnerFixture(identity: {
  pid: number;
  startIdentity: string;
}): Promise<void> {
  if (linuxProcessStart(identity.pid) !== identity.startIdentity) return;
  try {
    process.kill(identity.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await waitExactTestProcessGone(identity.pid, identity.startIdentity);
}

async function collectRunnerTestOutcome(
  primary: unknown,
  actions: Array<() => void | Promise<void>>,
): Promise<void> {
  const teardownErrors: unknown[] = [];
  for (const action of actions)
    try {
      await action();
    } catch (error) {
      teardownErrors.push(error);
    }
  if (primary !== undefined && teardownErrors.length)
    throw new AggregateError(
      [primary, ...teardownErrors],
      "Runner test body and teardown failed.",
    );
  if (primary !== undefined) throw primary;
  if (teardownErrors.length === 1) throw teardownErrors[0];
  if (teardownErrors.length > 1)
    throw new AggregateError(teardownErrors, "Runner test teardown failed.");
}

test("M2 projects mandatory and optional Herdr capabilities", () => {
  const caps = projectCapabilities({
    methods: ["session.snapshot", "agent.start", "agent.list", "agent.focus"],
  });
  assert.equal(caps.supports("agent.start"), true);
  assert.equal(caps.mandatory["worktree.create"], false);
  assert.equal(caps.optional["agent.interrupt"], false);
  assert.match(caps.schemaHash, /^[0-9a-f]{64}$/);
});
test("M2 projects methods from the official Herdr 0.8 schema envelope", () => {
  const caps = projectCapabilities({
    protocol: 19,
    schema_version: 1,
    schemas: {
      request: {
        oneOf: [
          { properties: { method: { const: "session.snapshot" } } },
          { properties: { method: { const: "workspace.list" } } },
        ],
      },
    },
  });
  assert.equal(caps.supports("session.snapshot"), true);
  assert.equal(caps.supports("workspace.list"), true);
});
test("M2 names are bounded, deterministic, and collision safe", () => {
  const first = herdrName("Code Review", "agt-test", []);
  assert.match(first, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.notEqual(herdrName("Code Review", "agt-test", [first]), first);
  assert.equal(branchSlug("Review / unsafe branch"), "review-unsafe-branch");
  assert.match(tokenDigest("test"), /^[0-9a-f]{64}$/);
});
test("M2 normalizers ignore additive fields", () => {
  const snapshot = normalizeSnapshot({
    sequence: 4,
    workspaces: [{ workspace_id: "w1", future: true }],
    panes: [{ pane_id: "p1", terminal_id: "t1", extra: { ok: true } }],
    future: "ignored",
  });
  assert.equal(snapshot.workspaces[0]?.id, "w1");
  assert.equal(snapshot.panes[0]?.terminalId, "t1");
});
test("official Herdr 0.8 snapshot preserves the exact nested Pi session reference", () => {
  const snapshot = normalizeSnapshot({
    result: {
      snapshot: {
        workspaces: [{ workspace_id: "w1", cwd: "/work" }],
        tabs: [{ tab_id: "tab1", workspace_id: "w1", cwd: "/work" }],
        panes: [
          {
            pane_id: "p1",
            terminal_id: "term1",
            workspace_id: "w1",
            tab_id: "tab1",
            agent: "pi",
          },
        ],
        agents: [
          {
            agent_id: "a1",
            pane_id: "p1",
            terminal_id: "term1",
            workspace_id: "w1",
            tab_id: "tab1",
            agent: "pi",
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "path",
              value: "/home/test/.pi/sessions/exact.jsonl",
            },
          },
        ],
        worktrees: [],
      },
    },
  });
  assert.deepEqual(snapshot.agents[0]?.sessionReference, {
    source: "herdr:pi",
    agent: "pi",
    kind: "path",
    value: "/home/test/.pi/sessions/exact.jsonl",
  });
  assert.equal(snapshot.panes[0]?.terminalId, "term1");
});
test("M2 parses NUL-delimited porcelain records without shell parsing", () => {
  const entries = parsePorcelainV2(
    "1 .M N... 100644 100644 100644 a b c file with spaces.txt\0",
  );
  assert.equal(entries[0]?.path, "file with spaces.txt");
  assert.equal(entries[0]?.worktree, "M");
});

test("M2 process runner uses argv-only execution and a minimal environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-runner-"));
  const script = join(root, "argv-env.mjs");
  const capture = join(root, "capture.json");
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs"; writeFileSync(process.env.HERDR_CONFIG_PATH, JSON.stringify({ argv: process.argv.slice(2), secret: process.env.TEST_SECRET ?? null })); process.stdout.write("ok");`,
  );
  await chmod(script, 0o755);
  const oldCapture = process.env.HERDR_CONFIG_PATH;
  const oldSecret = process.env.TEST_SECRET;
  process.env.HERDR_CONFIG_PATH = capture;
  process.env.TEST_SECRET = "must-not-cross";
  try {
    const result = await new HerdrProcessRunner({
      binary: process.execPath,
    }).run([script, "safe arg", "$(not-shell-expanded)"]);
    assert.equal(result.stdout, "ok");
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), {
      argv: ["safe arg", "$(not-shell-expanded)"],
      secret: null,
    });
  } finally {
    if (oldCapture === undefined) delete process.env.HERDR_CONFIG_PATH;
    else process.env.HERDR_CONFIG_PATH = oldCapture;
    if (oldSecret === undefined) delete process.env.TEST_SECRET;
    else process.env.TEST_SECRET = oldSecret;
  }
});

test("production Herdr service does not construct a direct socket watcher", async () => {
  const source = await readFile(
    join(process.cwd(), "src", "herdr", "service.ts"),
    "utf8",
  );
  const marker = "export async function createProductionHerdrService";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1);
  const productionFactory = source.slice(start);
  assert.match(productionFactory, /new HerdrProcessRunner\(/u);
  assert.match(
    productionFactory,
    /revalidate:\s*\(\)\s*=>\s*revalidateHerdrBinary\(binaryIdentity\)/u,
  );
  assert.doesNotMatch(productionFactory, /new HerdrSocketClient\(/u);
  assert.doesNotMatch(productionFactory, /watcher\s*:/u);
  assert.doesNotMatch(productionFactory, /protocol\s*:/u);
});

test("production startup revalidates retained binary at spawn and return boundaries", async () => {
  const source = await readFile(
    join(process.cwd(), "src", "broker", "startup.ts"),
    "utf8",
  );
  const start = source.indexOf("export async function ensureBroker");
  const end = source.indexOf("export async function brokerStatus", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const ensureSource = source.slice(start, end);
  assert.match(
    ensureSource,
    /await revalidateHerdrBinary\(herdrBinary\);\s*child = spawn\(/u,
  );
  assert.match(
    ensureSource,
    /await waitReady\(paths, herdr, deadline, child\);\s*await revalidateHerdrBinary\(herdrBinary\);/u,
  );
  assert.match(
    ensureSource,
    /primary === undefined &&\s*cleanupErrors\.length > 0[\s\S]*?await stopOwnedChild\(child, childStart\)[\s\S]*?await cleanupFailedChildArtifacts\(paths, child\.pid, childStart\)/u,
  );
  assert.match(
    ensureSource,
    /await revalidateHerdrBinary\(herdrBinary\);\s*\}\s*catch \(error\)[\s\S]*?\}\s*return paths;/u,
  );
  assert.equal(
    ensureSource.match(/await revalidateHerdrBinary\(herdrBinary\);/gu)?.length,
    6,
  );
});

test("production-style runner revalidates focus and interrupt before and after execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-revalidate-"));
  const binary = join(root, "fake-herdr.mjs");
  try {
    await writeFile(binary, "#!/usr/bin/env node\nprocess.exitCode = 0;\n", {
      mode: 0o700,
    });
    let checks = 0;
    const cli = new HerdrCli(
      new HerdrProcessRunner({
        binary,
        revalidate: async () => {
          checks++;
        },
      }),
      projectCapabilities({ methods: ["agent.focus", "agent.interrupt"] }),
    );
    await cli.focusAgent("pane-1");
    await cli.interruptAgent("pane-1");
    assert.equal(checks, 4);

    let replacementChecks = 0;
    const replacementCli = new HerdrCli(
      new HerdrProcessRunner({
        binary,
        revalidate: async () => {
          replacementChecks++;
          if (replacementChecks === 2)
            throw new Error("HERDR_BINARY_REPLACED_AFTER_COMMAND");
        },
      }),
      projectCapabilities({ methods: ["agent.focus"] }),
    );
    await assert.rejects(
      () => replacementCli.focusAgent("pane-1"),
      /HERDR_BINARY_REPLACED_AFTER_COMMAND/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process runner revalidates after command rejection and preserves both failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-revalidate-failure-"));
  const binary = join(root, "failing-herdr.mjs");
  try {
    await writeFile(binary, "#!/usr/bin/env node\nprocess.exitCode = 7;\n", {
      mode: 0o700,
    });
    let checks = 0;
    const commandFailureRunner = new HerdrProcessRunner({
      binary,
      revalidate: async () => {
        checks++;
      },
    });
    await assert.rejects(
      () => commandFailureRunner.run([]),
      (error: unknown) =>
        error instanceof HerdrProcessError &&
        error.code === "HERDR_COMMAND_FAILED" &&
        error.message === "Herdr command failed with exit code 7.",
    );
    assert.equal(checks, 2);

    checks = 0;
    const postFailure = new Error("HERDR_BINARY_REVALIDATION_FAILED");
    const dualFailureRunner = new HerdrProcessRunner({
      binary,
      revalidate: async () => {
        checks++;
        if (checks === 2) throw postFailure;
      },
    });
    await assert.rejects(
      () => dualFailureRunner.run([]),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(
          error.message,
          "Herdr command and retained binary revalidation failed.",
        );
        assert.equal(error.errors.length, 2);
        assert.ok(error.errors[0] instanceof HerdrProcessError);
        assert.equal(error.errors[0].code, "HERDR_COMMAND_FAILED");
        assert.equal(
          error.errors[0].message,
          "Herdr command failed with exit code 7.",
        );
        assert.equal(error.errors[1], postFailure);
        return true;
      },
    );
    assert.equal(checks, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("signal-induced runner failures revalidate only after child close", async () => {
  const cases = [
    { name: "timeout", code: "HERDR_TIMEOUT" as const },
    { name: "abort", code: "HERDR_ABORTED" as const },
    { name: "output", code: "HERDR_OUTPUT_LIMIT" as const },
  ];
  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), `pi-herdr-close-${item.name}-`));
    const script = join(root, "held-child.mjs");
    const receipt = join(root, "pid");
    const outputRelease = join(root, "output-release");
    let processIdentity: { pid: number; startIdentity: string } | undefined;
    let pending: Promise<unknown> | undefined;
    let pendingObserved = false;
    let bodyError: unknown;
    try {
      await writeFile(
        script,
        `import { existsSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(receipt)}, String(process.pid));\n${item.name === "output" ? `while (!existsSync(${JSON.stringify(outputRelease)})) await new Promise((resolve) => setTimeout(resolve, 10));\nprocess.stdout.write("x".repeat(4096));` : ""}\nsetInterval(() => {}, 1000);\n`,
        { mode: 0o700 },
      );
      let checks = 0;
      const postFailure = new Error(`POST_CLOSE_${item.name.toUpperCase()}`);
      const runner = new HerdrProcessRunner({
        binary: process.execPath,
        timeoutMs: item.name === "timeout" ? 3_001 : 10_000,
        ...(item.name === "output" ? { maxOutputBytes: 32 } : {}),
        revalidate: async () => {
          checks++;
          if (checks !== 2) return;
          assert.ok(processIdentity);
          assert.notEqual(
            linuxProcessStart(processIdentity.pid),
            processIdentity.startIdentity,
          );
          throw postFailure;
        },
      });
      const controller = new AbortController();
      pending = runner.run([script], controller.signal);
      const receiptDeadline = Date.now() + 5_000;
      for (;;) {
        try {
          const pid = Number.parseInt(await readFile(receipt, "utf8"), 10);
          assert.ok(Number.isSafeInteger(pid) && pid > 0);
          const startIdentity = linuxProcessStart(pid);
          if (!startIdentity)
            throw new Error("Fixture process identity is unavailable.");
          processIdentity = { pid, startIdentity };
          break;
        } catch (error) {
          if (
            Date.now() >= receiptDeadline ||
            ((error as NodeJS.ErrnoException).code !== "ENOENT" &&
              !(error instanceof SyntaxError))
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (item.name === "abort") controller.abort();
      if (item.name === "output") await writeFile(outputRelease, "release\n");
      pendingObserved = true;
      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(
          error.message,
          "Herdr command and retained binary revalidation failed.",
        );
        assert.equal(error.errors.length, 2);
        assert.ok(error.errors[0] instanceof HerdrProcessError);
        assert.equal(error.errors[0].code, item.code);
        assert.equal(error.errors[1], postFailure);
        return true;
      });
      assert.equal(checks, 2);
    } catch (error) {
      bodyError = error;
    } finally {
      await collectRunnerTestOutcome(bodyError, [
        () =>
          processIdentity
            ? terminateExactRunnerFixture(processIdentity)
            : undefined,
        async () => {
          if (!pending || pendingObserved) return;
          await pending;
          throw new Error("Runner fixture command unexpectedly succeeded.");
        },
        () => rm(root, { recursive: true, force: true }),
      ]);
    }
  }
});

test("runner bounds a child-close stall and preserves teardown plus post-check failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-close-stall-"));
  const script = join(root, "close-stall.mjs");
  const receipt = join(root, "pids.json");
  let childIdentity: { pid: number; startIdentity: string } | undefined;
  let drainIdentity: { pid: number; startIdentity: string } | undefined;
  let bodyError: unknown;
  try {
    await writeFile(
      script,
      `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst drain = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", process.stdout, process.stderr] });\ndrain.unref();\nwriteFileSync(${JSON.stringify(receipt)}, JSON.stringify({ child: process.pid, drain: drain.pid }));\nsetInterval(() => {}, 1000);\n`,
      { mode: 0o700 },
    );
    let checks = 0;
    const postFailure = new Error("POST_REVALIDATION_AFTER_CLOSE_STALL");
    const runner = new HerdrProcessRunner({
      binary: process.execPath,
      timeoutMs: 10_000,
      revalidate: async () => {
        checks++;
        if (checks !== 2) return;
        const pids = JSON.parse(await readFile(receipt, "utf8")) as {
          child: number;
          drain: number;
        };
        assert.ok(childIdentity);
        assert.ok(drainIdentity);
        assert.equal(pids.child, childIdentity.pid);
        assert.equal(pids.drain, drainIdentity.pid);
        assert.notEqual(
          linuxProcessStart(childIdentity.pid),
          childIdentity.startIdentity,
        );
        assert.equal(
          linuxProcessStart(drainIdentity.pid),
          drainIdentity.startIdentity,
        );
        throw postFailure;
      },
    });
    const controller = new AbortController();
    const started = Date.now();
    const pending = runner.run([script], controller.signal);
    const receiptDeadline = Date.now() + 5_000;
    for (;;) {
      try {
        const pids = JSON.parse(await readFile(receipt, "utf8")) as {
          child: number;
          drain: number;
        };
        const childStart = linuxProcessStart(pids.child);
        const drainStart = linuxProcessStart(pids.drain);
        assert.ok(childStart);
        assert.ok(drainStart);
        childIdentity = { pid: pids.child, startIdentity: childStart };
        drainIdentity = { pid: pids.drain, startIdentity: drainStart };
        break;
      } catch (error) {
        if (
          Date.now() >= receiptDeadline ||
          ((error as NodeJS.ErrnoException).code !== "ENOENT" &&
            !(error instanceof SyntaxError))
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.message,
        "Herdr command and retained binary revalidation failed.",
      );
      assert.equal(error.errors.length, 3);
      assert.ok(error.errors[0] instanceof HerdrProcessError);
      assert.equal(error.errors[0].code, "HERDR_ABORTED");
      assert.ok(error.errors[1] instanceof HerdrProcessError);
      assert.equal(error.errors[1].code, "HERDR_COMMAND_FAILED");
      assert.equal(
        error.errors[1].message,
        "Herdr command termination did not close.",
      );
      assert.equal(error.errors[2], postFailure);
      return true;
    });
    assert.ok(Date.now() - started < 5_000);
    assert.equal(checks, 2);
  } catch (error) {
    bodyError = error;
  } finally {
    await collectRunnerTestOutcome(bodyError, [
      () =>
        childIdentity ? terminateExactRunnerFixture(childIdentity) : undefined,
      () =>
        drainIdentity ? terminateExactRunnerFixture(drainIdentity) : undefined,
      () => rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("M2 process runner classifies missing executable and malformed JSON deterministically", async () => {
  await assert.rejects(
    () =>
      new HerdrProcessRunner({
        binary: "/no/such/herdr",
        timeoutMs: 3_001,
      }).run([]),
    (error: unknown) =>
      error instanceof HerdrProcessError && error.code === "HERDR_UNAVAILABLE",
  );
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-json-"));
  const script = join(root, "bad-json.mjs");
  await writeFile(script, "process.stdout.write('not-json');");
  const runner = new HerdrProcessRunner({
    binary: process.execPath,
    timeoutMs: 3_001,
  });
  await assert.rejects(
    () => runner.json([script]),
    (error: unknown) =>
      error instanceof HerdrProcessError &&
      error.code === "HERDR_INVALID_OUTPUT",
  );
});
