import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";

const TERMINATION_DRAIN_TIMEOUT_MS = 1_500;
const TERMINATION_FAILURE_MESSAGE = "Herdr command termination did not close.";

export type HerdrErrorCode =
  | "HERDR_UNAVAILABLE"
  | "HERDR_TIMEOUT"
  | "HERDR_ABORTED"
  | "HERDR_OUTPUT_LIMIT"
  | "HERDR_INVALID_OUTPUT"
  | "HERDR_COMMAND_FAILED";
export class HerdrProcessError extends Error {
  readonly code: HerdrErrorCode;
  readonly stderrDigest?: string;
  constructor(code: HerdrErrorCode, message: string, stderr?: string) {
    super(message);
    this.name = "HerdrProcessError";
    this.code = code;
    if (stderr)
      this.stderrDigest = createHash("sha256").update(stderr).digest("hex");
  }
}
export interface ProcessRunnerOptions {
  binary: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  revalidate?: () => Promise<void>;
}
export interface HerdrProcessResult {
  exitCode: number;
  stdout: string;
  stderrDigest?: string;
}
export function minimalHerdrEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "HERDR_CONFIG_PATH",
    "HERDR_SESSION",
    "HERDR_SOCKET_PATH",
  ])
    if (source[key] !== undefined) out[key] = source[key];
  return out;
}
function terminate(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (process.platform === "linux" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* process already exited */
    }
  }
  child.kill(signal);
}
export class HerdrProcessRunner {
  readonly #options: ProcessRunnerOptions;
  constructor(options: ProcessRunnerOptions) {
    this.#options = options;
  }
  run(
    argv: readonly string[],
    signal?: AbortSignal,
  ): Promise<HerdrProcessResult> {
    const timeoutMs = this.#options.timeoutMs ?? 30_000,
      max = this.#options.maxOutputBytes ?? 8 * 1024 * 1024;
    if (this.#options.env)
      throw new HerdrProcessError(
        "HERDR_COMMAND_FAILED",
        "Caller environment overrides are not allowed.",
      );
    if (!this.#options.binary)
      throw new HerdrProcessError(
        "HERDR_UNAVAILABLE",
        "Herdr executable is not configured.",
      );
    return (async () => {
      if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 3_001 ||
        timeoutMs > 300_000
      )
        throw new HerdrProcessError(
          "HERDR_COMMAND_FAILED",
          "Herdr timeout must be 3001-300000 ms.",
        );
      await this.#options.revalidate?.();
      let result: HerdrProcessResult | undefined;
      let commandFailed = false;
      let commandError: unknown;
      try {
        result = await new Promise<HerdrProcessResult>((resolve, reject) => {
          const child = spawn(this.#options.binary, [...argv], {
            shell: false,
            cwd: this.#options.cwd,
            env: minimalHerdrEnvironment(),
            detached: process.platform === "linux",
            stdio: ["ignore", "pipe", "pipe"],
          });
          const out: Buffer[] = [],
            err: Buffer[] = [];
          let size = 0,
            settled = false,
            signalFailure: HerdrProcessError | undefined,
            drainTimer: NodeJS.Timeout | undefined;
          const abort = () =>
            requestSignalFailure(
              new HerdrProcessError(
                "HERDR_ABORTED",
                "Herdr command was aborted.",
              ),
            );
          const finish = (error?: Error, result?: HerdrProcessResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (drainTimer) clearTimeout(drainTimer);
            signal?.removeEventListener("abort", abort);
            if (error) reject(error);
            else resolve(result!);
          };
          const requestSignalFailure = (error: HerdrProcessError) => {
            if (settled || signalFailure) return;
            signalFailure = error;
            terminate(child, "SIGKILL");
            drainTimer = setTimeout(() => {
              terminate(child, "SIGKILL");
              child.stdout.destroy();
              child.stderr.destroy();
              child.unref();
              finish(
                new AggregateError(
                  [
                    error,
                    new HerdrProcessError(
                      "HERDR_COMMAND_FAILED",
                      TERMINATION_FAILURE_MESSAGE,
                    ),
                  ],
                  "Herdr command and termination cleanup failed.",
                ),
              );
            }, TERMINATION_DRAIN_TIMEOUT_MS);
          };
          const timer = setTimeout(
            () =>
              requestSignalFailure(
                new HerdrProcessError(
                  "HERDR_TIMEOUT",
                  "Herdr command timed out.",
                ),
              ),
            timeoutMs,
          );
          timer.unref?.();
          const append = (target: Buffer[], chunk: Buffer) => {
            if (signalFailure) return;
            size += chunk.byteLength;
            if (size > max)
              requestSignalFailure(
                new HerdrProcessError(
                  "HERDR_OUTPUT_LIMIT",
                  "Herdr output exceeded its limit.",
                ),
              );
            else target.push(chunk);
          };
          child.stdout.on("data", (c: Buffer) => append(out, c));
          child.stderr.on("data", (c: Buffer) => append(err, c));
          child.once("error", (e: NodeJS.ErrnoException) => {
            if (signalFailure) return;
            finish(
              new HerdrProcessError(
                e.code === "ENOENT"
                  ? "HERDR_UNAVAILABLE"
                  : "HERDR_COMMAND_FAILED",
                "Herdr command could not run.",
              ),
            );
          });
          child.once("close", (code) => {
            if (signalFailure) {
              finish(signalFailure);
              return;
            }
            const stderr = Buffer.concat(err).toString("utf8");
            if (code !== 0)
              finish(
                new HerdrProcessError(
                  "HERDR_COMMAND_FAILED",
                  `Herdr command failed with exit code ${code ?? 1}.`,
                  stderr,
                ),
              );
            else
              finish(undefined, {
                exitCode: 0,
                stdout: Buffer.concat(out).toString("utf8"),
                ...(stderr
                  ? {
                      stderrDigest: createHash("sha256")
                        .update(stderr)
                        .digest("hex"),
                    }
                  : {}),
              });
          });
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      } catch (error) {
        commandFailed = true;
        commandError = error;
      }
      let revalidationFailed = false;
      let revalidationError: unknown;
      try {
        await this.#options.revalidate?.();
      } catch (error) {
        revalidationFailed = true;
        revalidationError = error;
      }
      if (commandFailed && revalidationFailed) {
        const commandErrors =
          commandError instanceof AggregateError &&
          commandError.message ===
            "Herdr command and termination cleanup failed."
            ? commandError.errors
            : [commandError];
        throw new AggregateError(
          [...commandErrors, revalidationError],
          "Herdr command and retained binary revalidation failed.",
        );
      }
      if (commandFailed) throw commandError;
      if (revalidationFailed) throw revalidationError;
      return result!;
    })();
  }
  async json<T>(argv: readonly string[], signal?: AbortSignal): Promise<T> {
    const result = await this.run(argv, signal);
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new HerdrProcessError(
        "HERDR_INVALID_OUTPUT",
        "Herdr returned invalid JSON.",
      );
    }
  }
}
