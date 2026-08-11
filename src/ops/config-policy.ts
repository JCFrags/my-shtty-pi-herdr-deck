import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson } from "../shared/canonical-json.js";

export interface Config {
  version: 1;
  scheduler: {
    maxActiveAgents: number;
    maxActivePerParent: number;
    maxQueuedTasks: number;
    maxTasksPerDelegate: number;
    maxDelegationDepth: number;
    maxProvisioning: number;
  };
  timeouts: {
    agentStartMs: number;
    adapterRegisterMs: number;
    assignmentAcceptMs: number;
    defaultTaskMs: number;
    questionMs: number;
    resultRecoveryMs: number;
    stopGraceMs: number;
    externalCommandMs: number;
  };
  retention: {
    eventsDays: number;
    artifactsDays: number;
    logsDays: number;
    cleanWorktreesDays: number;
    retainFinalResults: boolean;
  };
  security: {
    allowProjectProfiles: boolean;
    allowProjectProfileOverrides: boolean;
    allowSharedWrites: boolean;
    allowCoarseHerdrControlFallback: boolean;
    maxProtocolLineBytes: number;
    artifactMaxBytes: number;
  };
  ui: {
    metadataTokens: boolean;
    notificationLevel: "critical" | "normal" | "all" | "none";
  };
  logging: {
    level: "error" | "warn" | "info" | "debug" | "trace";
    maxFileBytes: number;
    maxFiles: number;
  };
}

type Section = keyof Omit<Config, "version">;
type ConfigLayer = Partial<{ [K in Section]: Partial<Config[K]> }>;

export const DEFAULT_CONFIG: Readonly<Config> = {
  version: 1,
  scheduler: {
    maxActiveAgents: 4,
    maxActivePerParent: 4,
    maxQueuedTasks: 32,
    maxTasksPerDelegate: 8,
    maxDelegationDepth: 2,
    maxProvisioning: 2,
  },
  timeouts: {
    agentStartMs: 30_000,
    adapterRegisterMs: 15_000,
    assignmentAcceptMs: 10_000,
    defaultTaskMs: 1_800_000,
    questionMs: 1_800_000,
    resultRecoveryMs: 120_000,
    stopGraceMs: 30_000,
    externalCommandMs: 10_000,
  },
  retention: {
    eventsDays: 30,
    artifactsDays: 14,
    logsDays: 7,
    cleanWorktreesDays: 7,
    retainFinalResults: true,
  },
  security: {
    allowProjectProfiles: true,
    allowProjectProfileOverrides: false,
    allowSharedWrites: false,
    allowCoarseHerdrControlFallback: false,
    maxProtocolLineBytes: 1_048_576,
    artifactMaxBytes: 16_777_216,
  },
  ui: { metadataTokens: true, notificationLevel: "normal" },
  logging: { level: "info", maxFileBytes: 10_485_760, maxFiles: 5 },
};

const HARD_MAX: Record<string, number> = {
  "scheduler.maxActiveAgents": 32,
  "scheduler.maxActivePerParent": 16,
  "scheduler.maxQueuedTasks": 1_000,
  "scheduler.maxTasksPerDelegate": 32,
  "scheduler.maxDelegationDepth": 4,
  "scheduler.maxProvisioning": 8,
  "timeouts.agentStartMs": 300_000,
  "timeouts.adapterRegisterMs": 300_000,
  "timeouts.assignmentAcceptMs": 60_000,
  "timeouts.defaultTaskMs": 86_400_000,
  "timeouts.questionMs": 86_400_000,
  "timeouts.resultRecoveryMs": 600_000,
  "timeouts.stopGraceMs": 300_000,
  "timeouts.externalCommandMs": 300_000,
  "retention.eventsDays": 3_650,
  "retention.artifactsDays": 3_650,
  "retention.logsDays": 365,
  "retention.cleanWorktreesDays": 3_650,
  "security.maxProtocolLineBytes": 1_048_576,
  "security.artifactMaxBytes": 67_108_864,
  "logging.maxFileBytes": 104_857_600,
  "logging.maxFiles": 50,
};
const MIN_VALUE: Record<string, number> = {
  "scheduler.maxActiveAgents": 1,
  "scheduler.maxActivePerParent": 1,
  "scheduler.maxQueuedTasks": 0,
  "scheduler.maxTasksPerDelegate": 1,
  "scheduler.maxDelegationDepth": 0,
  "scheduler.maxProvisioning": 1,
  "timeouts.agentStartMs": 3_001,
  "timeouts.adapterRegisterMs": 1_000,
  "timeouts.assignmentAcceptMs": 1_000,
  "timeouts.defaultTaskMs": 10_000,
  "timeouts.questionMs": 10_000,
  "timeouts.resultRecoveryMs": 10_000,
  "timeouts.stopGraceMs": 1_000,
  "timeouts.externalCommandMs": 1_000,
  "retention.eventsDays": 1,
  "retention.artifactsDays": 1,
  "retention.logsDays": 1,
  "retention.cleanWorktreesDays": 0,
  "security.maxProtocolLineBytes": 65_536,
  "security.artifactMaxBytes": 1_024,
  "logging.maxFileBytes": 1_048_576,
  "logging.maxFiles": 1,
};
const SECRET_KEY =
  /(?:token|secret|password|api[_-]?key|credential|authorization)/iu;
const SECRET_VALUE =
  /(?:-----BEGIN .*PRIVATE KEY-----|\bsk-[A-Za-z0-9]|Bearer\s+)/u;
const LAYER_KEYS = new Set([
  "version",
  "scheduler",
  "timeouts",
  "retention",
  "security",
  "ui",
  "logging",
]);
const SECTION_KEYS: Record<Section, readonly string[]> = {
  scheduler: Object.keys(DEFAULT_CONFIG.scheduler),
  timeouts: Object.keys(DEFAULT_CONFIG.timeouts),
  retention: Object.keys(DEFAULT_CONFIG.retention),
  security: Object.keys(DEFAULT_CONFIG.security),
  ui: Object.keys(DEFAULT_CONFIG.ui),
  logging: Object.keys(DEFAULT_CONFIG.logging),
};
const ENV_KEYS = new Set([
  "PI_HERDR_ORCH_CONFIG_PATH",
  "PI_HERDR_ORCH_STATE_ROOT",
  "PI_HERDR_ORCH_RUNTIME_ROOT",
  "PI_HERDR_ORCH_LOG_LEVEL",
]);

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object.`);
  return value as Record<string, unknown>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      freeze(child);
    Object.freeze(value);
  }
  return value;
}
function validateLayer(value: unknown, source: string): ConfigLayer {
  const input = object(value, source);
  if (input.version !== undefined && input.version !== 1)
    throw new Error(`${source}.version must be 1.`);
  for (const key of Object.keys(input)) {
    if (key !== "version" && !LAYER_KEYS.has(key))
      throw new Error(`Unknown configuration field: ${source}.${key}.`);
    if (SECRET_KEY.test(key))
      throw new Error(`Forbidden configuration field: ${source}.${key}.`);
  }
  for (const section of Object.keys(SECTION_KEYS) as Section[]) {
    const candidate = input[section];
    if (candidate === undefined) continue;
    const sectionObject = object(candidate, `${source}.${section}`);
    for (const key of Object.keys(sectionObject)) {
      if (!SECTION_KEYS[section].includes(key))
        throw new Error(
          `Unknown configuration field: ${source}.${section}.${key}.`,
        );
      const item = sectionObject[key];
      if (
        SECRET_KEY.test(key) ||
        (typeof item === "string" && SECRET_VALUE.test(item))
      )
        throw new Error(
          `Secret-like configuration is not allowed at ${source}.${section}.${key}.`,
        );
      const path = `${section}.${key}`;
      if (typeof item === "number") {
        const minimum = MIN_VALUE[path];
        const maximum = HARD_MAX[path];
        if (
          minimum === undefined ||
          maximum === undefined ||
          !Number.isSafeInteger(item) ||
          item < minimum ||
          item > maximum
        )
          throw new Error(`${source}.${path} is outside its safe bounds.`);
      } else if (
        (section === "retention" && key === "retainFinalResults") ||
        (section === "security" && typeof item === "boolean") ||
        (section === "ui" && key === "metadataTokens")
      ) {
        if (typeof item !== "boolean")
          throw new Error(`${source}.${path} must be a boolean.`);
      } else if (section === "ui" && key === "notificationLevel") {
        if (
          !(["critical", "normal", "all", "none"] as const).includes(
            item as never,
          )
        )
          throw new Error(`${source}.${path} has an invalid value.`);
      } else if (section === "logging" && key === "level") {
        if (
          !(["error", "warn", "info", "debug", "trace"] as const).includes(
            item as never,
          )
        )
          throw new Error(`${source}.${path} has an invalid value.`);
      } else throw new Error(`${source}.${path} has an invalid type.`);
    }
  }
  return input as ConfigLayer;
}
function cloneConfig(config: Config): Config {
  return JSON.parse(JSON.stringify(config)) as Config;
}
function mergeInto(base: Config, layer: ConfigLayer): void {
  for (const section of Object.keys(SECTION_KEYS) as Section[]) {
    const values = layer[section];
    if (values) Object.assign(base[section], values);
  }
}
function assertNarrowing(
  before: Config,
  after: Config,
  source: "project" | "request",
): void {
  for (const section of Object.keys(SECTION_KEYS) as Section[]) {
    for (const key of SECTION_KEYS[section]) {
      const oldValue = before[section][key as keyof Config[typeof section]];
      const newValue = after[section][key as keyof Config[typeof section]];
      if (
        typeof oldValue === "number" &&
        typeof newValue === "number" &&
        newValue > oldValue
      )
        throw new Error(
          `${source} configuration may only narrow ${section}.${key}.`,
        );
      if (
        typeof oldValue === "boolean" &&
        oldValue === false &&
        newValue === true
      )
        throw new Error(
          `${source} configuration may not enable ${section}.${key}.`,
        );
    }
  }
}

export interface EffectiveSnapshot {
  readonly generation: number;
  readonly hash: string;
  readonly config: Readonly<Config>;
  readonly sources: readonly string[];
}
export interface LayerOptions {
  readonly trustedProject?: boolean;
  readonly requestFields?: readonly string[];
}
export interface ConfigLayers {
  readonly user?: unknown;
  readonly project?: unknown;
  readonly request?: unknown;
}

export function effectiveConfig(
  layers: ConfigLayers = {},
  options: LayerOptions = {},
  previousGeneration = 0,
): EffectiveSnapshot {
  const user =
    layers.user === undefined ? {} : validateLayer(layers.user, "user");
  const config = cloneConfig(DEFAULT_CONFIG);
  mergeInto(config, user);
  const sources = ["built-in"];
  if (layers.user !== undefined) sources.push("user");
  if (layers.project !== undefined) {
    if (options.trustedProject !== true)
      throw new Error(
        "Project configuration requires trusted-project confirmation.",
      );
    const project = validateLayer(layers.project, "project");
    assertNarrowing(config, cloneWith(config, project), "project");
    mergeInto(config, project);
    sources.push("trusted-project");
  }
  if (layers.request !== undefined) {
    const request = validateLayer(layers.request, "request");
    const allowed = new Set(options.requestFields ?? []);
    for (const section of Object.keys(SECTION_KEYS) as Section[])
      for (const key of Object.keys(request[section] ?? {}))
        if (!allowed.has(`${section}.${key}`))
          throw new Error(
            `Request field is not permitted by profile: ${section}.${key}.`,
          );
    const next = cloneWith(config, request);
    assertNarrowing(config, next, "request");
    mergeInto(config, request);
    sources.push("request");
  }
  const canonical = canonicalJson(config);
  const hash = createHash("sha256").update(canonical).digest("hex");
  return freeze({
    generation: previousGeneration + 1,
    hash,
    config: freeze(config),
    sources: Object.freeze(sources),
  });
}
function cloneWith(base: Config, layer: ConfigLayer): Config {
  const next = cloneConfig(base);
  mergeInto(next, layer);
  return next;
}

export class ConfigPolicy {
  #snapshot: EffectiveSnapshot;
  constructor(layers: ConfigLayers = {}, options: LayerOptions = {}) {
    this.#snapshot = effectiveConfig(layers, options);
  }
  get snapshot(): EffectiveSnapshot {
    return this.#snapshot;
  }
  reload(
    layers: ConfigLayers,
    options: LayerOptions = {},
  ): { accepted: boolean; snapshot: EffectiveSnapshot; error?: string } {
    try {
      const candidate = effectiveConfig(
        layers,
        options,
        this.#snapshot.generation,
      );
      if (candidate.hash !== this.#snapshot.hash) this.#snapshot = candidate;
      return { accepted: true, snapshot: this.#snapshot };
    } catch (error) {
      return {
        accepted: false,
        snapshot: this.#snapshot,
        error:
          error instanceof Error ? error.message : "Invalid configuration.",
      };
    }
  }
}

export function allowedEnvironmentOverrides(
  env: Record<string, string | undefined> = process.env,
): { logLevel?: Config["logging"]["level"] } {
  for (const key of Object.keys(env))
    if (key.startsWith("PI_HERDR_ORCH_") && !ENV_KEYS.has(key))
      throw new Error(
        `Unsupported configuration environment variable: ${key}.`,
      );
  const value = env.PI_HERDR_ORCH_LOG_LEVEL;
  if (value === undefined) return {};
  if (
    !(["error", "warn", "info", "debug", "trace"] as const).includes(
      value as never,
    )
  )
    throw new Error("PI_HERDR_ORCH_LOG_LEVEL is invalid.");
  return { logLevel: value as Config["logging"]["level"] };
}

export async function assertTrustedProjectConfigPath(
  projectRoot: string,
  configPath: string,
): Promise<void> {
  const root = resolve(projectRoot);
  const expected = resolve(root, ".pi", "orchestrator", "config.json");
  if (resolve(configPath) !== expected)
    throw new Error(
      "Project configuration path is outside the trusted project config location.",
    );
  const paths = [
    root,
    resolve(root, ".pi"),
    resolve(root, ".pi", "orchestrator"),
  ];
  const directoryStats = await Promise.all(paths.map((path) => lstat(path)));
  const fileStat = await lstat(expected);
  const uid = process.getuid?.();
  if (
    directoryStats.some(
      (stat) =>
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (uid !== undefined && stat.uid !== uid) ||
        (stat.mode & 0o022) !== 0,
    ) ||
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    fileStat.nlink !== 1 ||
    (uid !== undefined && fileStat.uid !== uid) ||
    (fileStat.mode & 0o022) !== 0
  )
    throw new Error("Trusted project configuration path is unsafe.");
}

export function validateConfigPolicy(
  value: unknown,
  source = "config",
): ConfigLayer {
  return validateLayer(value, source);
}
