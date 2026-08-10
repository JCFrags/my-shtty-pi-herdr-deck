import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

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
export class HerdrProcessRunner {
  readonly #options: ProcessRunnerOptions;
  constructor(options: ProcessRunnerOptions) {
    this.#options = options;
  }
  run(
    argv: readonly string[],
    signal?: AbortSignal,
  ): Promise<HerdrProcessResult> {
    const timeoutMs = this.#options.timeoutMs ?? 10_000,
      max = this.#options.maxOutputBytes ?? 8 * 1024 * 1024;
    if (!this.#options.binary)
      return Promise.reject(
        new HerdrProcessError(
          "HERDR_UNAVAILABLE",
          "Herdr executable is not configured.",
        ),
      );
    return new Promise((resolve, reject) => {
      const child = spawn(this.#options.binary, [...argv], {
        shell: false,
        cwd: this.#options.cwd,
        env: this.#options.env ?? minimalHerdrEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const out: Buffer[] = [],
        err: Buffer[] = [];
      let size = 0,
        settled = false;
      const finish = (error?: Error, result?: HerdrProcessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result!);
      };
      const append = (target: Buffer[], chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > max) {
          child.kill("SIGKILL");
          finish(
            new HerdrProcessError(
              "HERDR_OUTPUT_LIMIT",
              "Herdr output exceeded its limit.",
            ),
          );
        } else target.push(chunk);
      };
      child.stdout.on("data", (c: Buffer) => append(out, c));
      child.stderr.on("data", (c: Buffer) => append(err, c));
      child.once("error", (e: NodeJS.ErrnoException) =>
        finish(
          new HerdrProcessError(
            e.code === "ENOENT" ? "HERDR_UNAVAILABLE" : "HERDR_COMMAND_FAILED",
            "Herdr command could not run.",
          ),
        ),
      );
      child.once("close", (code) => {
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
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(
          new HerdrProcessError("HERDR_TIMEOUT", "Herdr command timed out."),
        );
      }, timeoutMs);
      timer.unref?.();
      if (signal) {
        if (signal.aborted) {
          child.kill("SIGKILL");
          finish(
            new HerdrProcessError(
              "HERDR_ABORTED",
              "Herdr command was aborted.",
            ),
          );
        } else
          signal.addEventListener(
            "abort",
            () => {
              child.kill("SIGKILL");
              finish(
                new HerdrProcessError(
                  "HERDR_ABORTED",
                  "Herdr command was aborted.",
                ),
              );
            },
            { once: true },
          );
      }
    });
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
