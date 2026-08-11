import { spawn } from "node:child_process";
import type { HerdrAgentInfo } from "./context.js";

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class HerdrApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrApiError";
    this.code = code;
  }
}

export interface HerdrCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type HerdrRunner = (
  argv: readonly string[],
) => Promise<HerdrCommandResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function minimalHerdrEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
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
    "HERDR_CONFIG",
    "HERDR_STATE_DIR",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export function schemaSupportsMethod(schema: unknown, method: string): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 32 || value === null || value === undefined || seen.has(value))
      return false;
    if (Array.isArray(value)) {
      seen.add(value);
      return value.some((item) => visit(item, depth + 1));
    }
    if (!isRecord(value)) return false;
    seen.add(value);
    if (
      Array.isArray(value.methods) &&
      value.methods.every((item) => typeof item === "string")
    )
      return value.methods.includes(method);
    if (isRecord(value.schemas))
      for (const schema of Object.values(value.schemas))
        if (visit(schema, depth + 1)) return true;
    const methodProperty = isRecord(value.properties)
      ? value.properties.method
      : undefined;
    if (isRecord(methodProperty)) {
      if (methodProperty.const === method) return true;
      if (
        Array.isArray(methodProperty.enum) &&
        methodProperty.enum.includes(method)
      )
        return true;
    }
    for (const key of [
      "oneOf",
      "anyOf",
      "allOf",
      "items",
      "$defs",
      "definitions",
    ]) {
      if (key in value && visit(value[key], depth + 1)) return true;
    }
    return false;
  };
  return visit(schema, 0);
}

export function createHerdrRunner(
  binaryPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): HerdrRunner {
  if (!binaryPath)
    throw new HerdrApiError(
      "missing_binary",
      "HERDR_BIN_PATH is not available.",
    );
  return async (argv) =>
    await new Promise<HerdrCommandResult>((resolve, reject) => {
      const child = spawn(binaryPath, [...argv], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: minimalHerdrEnvironment(),
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (error?: Error, result?: HerdrCommandResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result!);
      };
      const append = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          finish(
            new HerdrApiError(
              "output_too_large",
              "Herdr CLI output exceeded 8 MiB.",
            ),
          );
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
      child.once("error", (error) => finish(error));
      child.once("close", (code) =>
        finish(undefined, {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: code ?? 1,
        }),
      );
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(
          new HerdrApiError(
            "timeout",
            `Herdr CLI command timed out: ${argv.join(" ")}`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
    });
}

function parseJsonOutput(result: HerdrCommandResult, command: string): unknown {
  if (result.exitCode !== 0) {
    throw new HerdrApiError(
      "cli_failed",
      `${command} failed (exit code ${result.exitCode}).`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new HerdrApiError(
      "invalid_json",
      `${command} did not return valid JSON.`,
    );
  }
}

function normalizeAgent(value: unknown): HerdrAgentInfo | undefined {
  if (!isRecord(value)) return undefined;
  const paneId = optionalString(value.pane_id ?? value.paneId);
  const terminalId = optionalString(value.terminal_id ?? value.terminalId);
  if (!paneId || !terminalId) return undefined;
  const agent: HerdrAgentInfo = {
    paneId,
    terminalId,
    focused: value.focused === true,
  };
  const name = optionalString(value.name);
  const agentLabel = optionalString(value.agent);
  const displayAgent = optionalString(
    value.display_agent ?? value.displayAgent,
  );
  const title = optionalString(value.title);
  const status = optionalString(value.agent_status ?? value.agentStatus);
  const cwd = optionalString(
    value.foreground_cwd ?? value.foregroundCwd ?? value.cwd,
  );
  if (name) agent.name = name;
  if (agentLabel) agent.agent = agentLabel;
  if (displayAgent) agent.displayAgent = displayAgent;
  if (title) agent.title = title;
  if (status) agent.status = status;
  if (cwd) agent.cwd = cwd;
  return agent;
}

export class HerdrApi {
  readonly #run: HerdrRunner;
  #schema: unknown;

  constructor(options: { binaryPath?: string; runner?: HerdrRunner }) {
    if (options.runner) this.#run = options.runner;
    else
      this.#run = createHerdrRunner(
        options.binaryPath ?? process.env.HERDR_BIN_PATH ?? "",
      );
  }

  get schema(): unknown {
    return this.#schema;
  }

  async readSchema(): Promise<unknown> {
    const result = await this.#run(["api", "schema", "--json"]);
    this.#schema = parseJsonOutput(result, "herdr api schema --json");
    return this.#schema;
  }

  supports(method: string): boolean {
    if (this.#schema === undefined)
      throw new HerdrApiError(
        "schema_not_loaded",
        "Herdr API schema has not been loaded.",
      );
    return schemaSupportsMethod(this.#schema, method);
  }

  requireMethods(methods: readonly string[]): void {
    const missing = methods.filter((method) => !this.supports(method));
    if (missing.length > 0) {
      throw new HerdrApiError(
        "unsupported_api",
        `Installed Herdr schema is missing required methods: ${missing.join(", ")}.`,
      );
    }
  }

  async listAgents(): Promise<HerdrAgentInfo[]> {
    this.requireMethods(["agent.list"]);
    const result = parseJsonOutput(
      await this.#run(["agent", "list"]),
      "herdr agent list",
    );
    const root =
      isRecord(result) && isRecord(result.result) ? result.result : result;
    const candidates = Array.isArray(root)
      ? root
      : isRecord(root) && Array.isArray(root.agents)
        ? root.agents
        : [];
    return candidates.flatMap((item) => {
      const agent = normalizeAgent(item);
      return agent ? [agent] : [];
    });
  }

  async focusPane(paneId: string): Promise<void> {
    this.requireMethods(["agent.focus"]);
    const result = await this.#run(["agent", "focus", paneId]);
    if (result.exitCode !== 0) {
      throw new HerdrApiError("cli_failed", "herdr agent focus failed.");
    }
  }
}
