import { readFile } from "node:fs/promises";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

export interface OrchConfig {
  version: 1;
  scheduler?: Record<string, number>;
  timeouts?: Record<string, number>;
  retention?: Record<string, number | boolean>;
  security?: Record<string, number | boolean>;
  ui?: Record<string, string | boolean>;
  logging?: Record<string, string | number>;
}

const SECRET_KEY =
  /(?:token|secret|password|api[_-]?key|credential|authorization)/iu;
const SECRET_VALUE =
  /(?:-----BEGIN .*PRIVATE KEY-----|\bsk-[A-Za-z0-9]|Bearer\s+)/u;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function walkSafe(value: unknown, path = "$"): void {
  if (typeof value === "string" && SECRET_VALUE.test(value))
    throw new Error(`Configuration contains a secret-like value at ${path}.`);
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && key !== "allowProjectProfiles")
      throw new Error(
        `Configuration contains a forbidden field at ${path}.${key}.`,
      );
    walkSafe(child, `${path}.${key}`);
  }
}
function checkNumbers(section: Record<string, unknown>, path: string): void {
  for (const [key, value] of Object.entries(section)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error(`${path}.${key} must be a non-negative safe integer.`);
  }
}
export function validateConfig(value: unknown): OrchConfig {
  if (!isObject(value) || value.version !== 1)
    throw new Error("Configuration must be an object with version 1.");
  const allowed = new Set([
    "version",
    "scheduler",
    "timeouts",
    "retention",
    "security",
    "ui",
    "logging",
  ]);
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      throw new Error(`Unknown configuration field: ${key}.`);
  walkSafe(value);
  for (const section of [
    "scheduler",
    "timeouts",
    "retention",
    "security",
    "logging",
  ] as const) {
    const candidate = value[section];
    if (candidate !== undefined) {
      if (!isObject(candidate))
        throw new Error(`${section} must be an object.`);
      checkNumbers(candidate, section);
    }
  }
  return value as unknown as OrchConfig;
}
export async function loadConfig(
  path: string,
  options: { trustedProject?: boolean } = {},
): Promise<OrchConfig> {
  const absolute = resolve(path);
  const stat = await lstat(absolute);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (process.getuid?.() !== undefined && stat.uid !== process.getuid()) ||
    (stat.mode & 0o022) !== 0
  )
    throw new Error(
      "Configuration file is not a safe owner-controlled regular file.",
    );
  if (!options.trustedProject && absolute.includes("/.pi/orchestrator/"))
    throw new Error("Project configuration requires a trusted project.");
  return validateConfig(
    JSON.parse(await readFile(absolute, "utf8")) as unknown,
  );
}
