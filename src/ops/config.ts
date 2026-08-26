import { readFile } from "node:fs/promises";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  validateModelSelection,
  type ModelPolicyConfig,
} from "../broker/model-policy.js";
import {
  validateEndpointPolicyConfig,
  type EndpointLimit,
  type ModelIntelligenceConfig,
} from "../broker/endpoint-policy.js";
import type { SchedulerLimits } from "../scheduler/types.js";

export type OrchSchedulerConfig = Partial<SchedulerLimits> & {
  endpoints?: Record<string, EndpointLimit>;
};

export interface OrchConfig {
  version: 1;
  scheduler?: OrchSchedulerConfig;
  timeouts?: Record<string, number>;
  retention?: Record<string, number | boolean>;
  security?: Record<string, number | boolean>;
  modelPolicy?: ModelPolicyConfig;
  modelIntelligence?: ModelIntelligenceConfig;
  lifecyclePolicy?: { autoCloseCompletedTemporary?: boolean };
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
    "modelPolicy",
    "modelIntelligence",
    "lifecyclePolicy",
    "ui",
    "logging",
  ]);
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      throw new Error(`Unknown configuration field: ${key}.`);
  walkSafe(value);
  const lifecyclePolicy = value.lifecyclePolicy;
  if (lifecyclePolicy !== undefined) {
    if (
      !isObject(lifecyclePolicy) ||
      Object.keys(lifecyclePolicy).some(
        (key) => key !== "autoCloseCompletedTemporary",
      ) ||
      (lifecyclePolicy.autoCloseCompletedTemporary !== undefined &&
        typeof lifecyclePolicy.autoCloseCompletedTemporary !== "boolean")
    )
      throw new Error("lifecyclePolicy is invalid.");
  }
  const modelPolicy = value.modelPolicy;
  if (modelPolicy !== undefined) {
    if (!isObject(modelPolicy))
      throw new Error("modelPolicy must be an object.");
    const allowedModelKeys = new Set([
      "defaults",
      "profiles",
      "allowlist",
      "compatibility",
    ]);
    if (Object.keys(modelPolicy).some((key) => !allowedModelKeys.has(key)))
      throw new Error("modelPolicy contains an unknown field.");
    if (modelPolicy.defaults !== undefined) {
      if (!isObject(modelPolicy.defaults))
        throw new Error("modelPolicy.defaults is invalid.");
      const defaults = modelPolicy.defaults;
      if (
        Object.keys(defaults).some(
          (key) => !["global", "roles", "projects"].includes(key),
        )
      )
        throw new Error("modelPolicy.defaults contains an unknown field.");
      if (defaults.global !== undefined)
        validateModelSelection(defaults.global);
      for (const scope of ["roles", "projects"] as const) {
        if (defaults[scope] !== undefined && !isObject(defaults[scope]))
          throw new Error(`modelPolicy.defaults.${scope} is invalid.`);
        for (const [key, selection] of Object.entries(defaults[scope] ?? {})) {
          const validKey =
            scope === "roles"
              ? /^[a-z][a-z0-9_-]{0,63}$/u.test(key)
              : key.startsWith("/") &&
                key.length <= 4096 &&
                !/[\u0000-\u001f\u007f]/u.test(key);
          if (!validKey)
            throw new Error(
              `modelPolicy.defaults.${scope} has an invalid key.`,
            );
          validateModelSelection(selection);
        }
      }
    }
    if (modelPolicy.profiles !== undefined) {
      if (
        !isObject(modelPolicy.profiles) ||
        Object.keys(modelPolicy.profiles).some(
          (key) => key !== "manager" && key !== "subagent",
        )
      )
        throw new Error("modelPolicy.profiles is invalid.");
      for (const selection of Object.values(modelPolicy.profiles))
        validateModelSelection(selection);
    }
    if (
      modelPolicy.allowlist !== undefined &&
      (!Array.isArray(modelPolicy.allowlist) ||
        modelPolicy.allowlist.length < 1 ||
        modelPolicy.allowlist.length > 64)
    )
      throw new Error("modelPolicy.allowlist is invalid.");
    for (const selection of modelPolicy.allowlist ?? [])
      validateModelSelection(selection);
    if (modelPolicy.compatibility !== undefined) {
      if (!isObject(modelPolicy.compatibility))
        throw new Error("modelPolicy.compatibility is invalid.");
      for (const [profile, compatible] of Object.entries(
        modelPolicy.compatibility,
      ))
        if (
          !/^[a-z][a-z0-9_-]{0,63}$/u.test(profile) ||
          !Array.isArray(compatible) ||
          compatible.length < 1 ||
          compatible.some((item) => item !== "manager" && item !== "subagent")
        )
          throw new Error("modelPolicy.compatibility is invalid.");
    }
  }
  const scheduler = value.scheduler;
  if (scheduler !== undefined) {
    if (!isObject(scheduler)) throw new Error("scheduler must be an object.");
    const scalarScheduler = Object.fromEntries(
      Object.entries(scheduler).filter(([key]) => key !== "endpoints"),
    );
    checkNumbers(scalarScheduler, "scheduler");
  }
  validateEndpointPolicyConfig(
    isObject(scheduler) ? scheduler.endpoints : undefined,
    value.modelIntelligence,
  );
  for (const section of [
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

export function scalarSchedulerLimits(
  scheduler: OrchSchedulerConfig | undefined,
): Partial<SchedulerLimits> | undefined {
  if (!scheduler) return undefined;
  const { endpoints: _endpoints, ...limits } = scheduler;
  return Object.keys(limits).length ? limits : undefined;
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
