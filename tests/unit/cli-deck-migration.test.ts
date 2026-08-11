import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const timeoutMilliseconds = 10_000;

async function doesNotExist(path: string): Promise<void> {
  await assert.rejects(access(path), { code: "ENOENT" });
}

function waitForEntry(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => finish(new Error("Deck entry timed out.")),
      timeoutMilliseconds,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (error?: Error): void => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      const line = output.slice(0, newline);
      if (line !== "deck-entered")
        finish(new Error(`Unexpected deck entry signal: ${line}`));
      else finish();
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (): void =>
      finish(new Error("Deck process closed before its entry signal."));

    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

interface CloseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

type CloseOutcome =
  | { status: "fulfilled"; result: CloseResult }
  | { status: "rejected"; error: unknown };

function waitForClose(
  child: ChildProcessWithoutNullStreams,
): Promise<CloseResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Deck process exit timed out."));
    }, timeoutMilliseconds);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      resolve({ code, signal });
    };

    child.once("error", onError);
    child.once("close", onClose);
  });
}

test("production deck command awaits delegation without creating broker roots", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "orch-cli-deck-"));
  const mirrorRoot = join(temporaryRoot, "package");
  const stateRoot = join(temporaryRoot, "state-root");
  const runtimeRoot = join(temporaryRoot, "runtime-root");
  let child: ChildProcessWithoutNullStreams | undefined;
  let closeOutcomePromise: Promise<CloseOutcome> | undefined;
  let bodyFailed = false;
  let bodyError: unknown;
  let stdout = "";
  let stderr = "";
  const collectStdout = (chunk: Buffer): void => {
    stdout += chunk.toString("utf8");
  };
  const collectStderr = (chunk: Buffer): void => {
    stderr += chunk.toString("utf8");
  };

  try {
    await mkdir(join(mirrorRoot, "bin"), { recursive: true });
    await cp(join(repositoryRoot, "dist"), join(mirrorRoot, "dist"), {
      recursive: true,
    });
    await cp(
      join(repositoryRoot, "bin", "pi-herdr-orchestrator"),
      join(mirrorRoot, "bin", "pi-herdr-orchestrator"),
    );
    await cp(
      join(repositoryRoot, "package.json"),
      join(mirrorRoot, "package.json"),
    );
    await writeFile(
      join(mirrorRoot, "dist", "src", "deck", "main.js"),
      [
        'import { once } from "node:events";',
        'import { createInterface } from "node:readline";',
        "export async function main() {",
        '  process.stdout.write("deck-entered\\n");',
        "  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });",
        "  try {",
        '    const [line] = await once(lines, "line");',
        '    if (line !== "release") throw new Error("Unexpected release signal.");',
        "  } finally {",
        "    lines.close();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    child = spawn(
      process.execPath,
      [join(mirrorRoot, "bin", "pi-herdr-orchestrator"), "deck"],
      {
        cwd: mirrorRoot,
        env: {
          ...process.env,
          PI_HERDR_ORCH_STATE_ROOT: stateRoot,
          PI_HERDR_ORCH_RUNTIME_ROOT: runtimeRoot,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", collectStdout);
    child.stderr.on("data", collectStderr);
    closeOutcomePromise = waitForClose(child).then(
      (result): CloseOutcome => ({ status: "fulfilled", result }),
      (error: unknown): CloseOutcome => ({ status: "rejected", error }),
    );

    await waitForEntry(child);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    await doesNotExist(stateRoot);
    await doesNotExist(runtimeRoot);

    child.stdin.end("release\n");
    const closeOutcome = await closeOutcomePromise;
    if (closeOutcome.status === "rejected") throw closeOutcome.error;
    assert.deepEqual(closeOutcome.result, { code: 0, signal: null });
    assert.equal(stdout, "deck-entered\n");
    assert.equal(stderr, "");
    await doesNotExist(stateRoot);
    await doesNotExist(runtimeRoot);
  } catch (error: unknown) {
    bodyFailed = true;
    bodyError = error;
  } finally {
    const teardownErrors: unknown[] = [];
    if (child) {
      child.stdout.off("data", collectStdout);
      child.stderr.off("data", collectStderr);
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      if (closeOutcomePromise) {
        const closeOutcome = await closeOutcomePromise;
        if (closeOutcome.status === "rejected")
          teardownErrors.push(closeOutcome.error);
      }
      child.stdout.destroy();
      child.stderr.destroy();
    }
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error: unknown) {
      teardownErrors.push(error);
    }

    const errors = bodyFailed ? [bodyError, ...teardownErrors] : teardownErrors;
    const distinctErrors = errors.filter(
      (error, index) => errors.indexOf(error) === index,
    );
    if (distinctErrors.length === 1) throw distinctErrors[0];
    if (distinctErrors.length > 1)
      throw new AggregateError(
        distinctErrors,
        "Deck production-entry test and teardown failed.",
      );
  }
});

test("legacy binary prints one deprecation notice and launches the new deck target", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "orch-deck-shim-"));
  try {
    const binDirectory = join(temporaryRoot, "bin");
    const deckDirectory = join(temporaryRoot, "dist", "src", "deck");
    await mkdir(binDirectory, { recursive: true });
    await mkdir(deckDirectory, { recursive: true });

    const shim = await readFile(
      join(repositoryRoot, "bin", "pi-herdr-deck"),
      "utf8",
    );
    const shimPath = join(binDirectory, "pi-herdr-deck");
    await writeFile(shimPath, shim, { mode: 0o755 });
    await writeFile(
      join(deckDirectory, "main.js"),
      'export async function main() { process.stdout.write("new-deck-main\\n"); }\n',
    );

    const result = spawnSync(process.execPath, [shimPath], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: timeoutMilliseconds,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.error, undefined);
    assert.equal(result.stdout, "new-deck-main\n");
    assert.equal(
      result.stderr,
      "pi-herdr-deck is deprecated and retained for one release; use pi-herdr-orchestrator deck.\n",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
