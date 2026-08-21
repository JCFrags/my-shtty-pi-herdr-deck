import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "../shared/subprocess.js";
import type { ModelSelection, ThinkingLevel } from "../broker/model-policy.js";

export interface PiModelValidator {
  validate(selection: ModelSelection): Promise<void>;
}

export interface PiModelCapability {
  readonly provider: string;
  readonly modelId: string;
  readonly reasoning: boolean;
  readonly thinkingLevels: readonly ThinkingLevel[];
}

export interface PiCapabilitySnapshot {
  readonly models: readonly PiModelCapability[];
  readonly thinkingLevels: readonly ThinkingLevel[];
}

export type PiCapabilityRunner = (
  argv: readonly string[],
) => Promise<{ status: number | null; stdout: string; stderr?: string }>;

function parseThinkingLevels(help: string): ThinkingLevel[] {
  const line = help
    .split(/\r?\n/u)
    .find((candidate) => candidate.includes("--thinking <level>"));
  const values =
    line?.match(/(?:off|minimal|low|medium|high|xhigh|max)/gu) ?? [];
  return [...new Set(values)] as ThinkingLevel[];
}

function parseModels(
  output: string,
): Array<Omit<PiModelCapability, "thinkingLevels">> {
  const lines = output.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const header = lines.findIndex(
    (line) => /\bprovider\b/u.test(line) && /\bmodel\b/u.test(line),
  );
  if (header < 0) throw new Error("PI_MODEL_CATALOG_INVALID");
  const models: Array<Omit<PiModelCapability, "thinkingLevels">> = [];
  for (const line of lines.slice(header + 1)) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 5) continue;
    const [provider, modelId] = columns;
    const reasoning = columns.at(-2);
    if (!provider || !modelId || (reasoning !== "yes" && reasoning !== "no"))
      continue;
    models.push({ provider, modelId, reasoning: reasoning === "yes" });
  }
  if (models.length === 0) throw new Error("PI_MODEL_CATALOG_EMPTY");
  return models;
}

export function parsePiCapabilities(
  help: string,
  modelList: string,
): PiCapabilitySnapshot {
  const thinkingLevels = parseThinkingLevels(help);
  if (thinkingLevels.length === 0)
    throw new Error("PI_THINKING_CAPABILITY_INVALID");
  return {
    models: parseModels(modelList).map((model) => ({
      ...model,
      thinkingLevels: model.reasoning
        ? thinkingLevels.filter((level) => !["xhigh", "max"].includes(level))
        : (["off"] as ThinkingLevel[]),
    })),
    thinkingLevels,
  };
}

type PiAiCatalog = {
  getModel(provider: string, modelId: string): unknown;
  getSupportedThinkingLevels(model: unknown): ThinkingLevel[];
};

async function loadPiAiCatalog(): Promise<PiAiCatalog | undefined> {
  try {
    const codingAgentUrl = import.meta
      .resolve("@earendil-works/pi-coding-agent");
    const codingAgentEntry = fileURLToPath(codingAgentUrl);
    const packageRoot = dirname(dirname(codingAgentEntry));
    const modulePath = join(
      packageRoot,
      "node_modules",
      "@earendil-works",
      "pi-ai",
      "dist",
      "models.js",
    );
    const [codingAgent, piAi] = await Promise.all([
      import(codingAgentUrl) as Promise<{
        ModelRuntime: {
          create(options: {
            refreshOnCreate: boolean;
          }): Promise<{ getModel(provider: string, modelId: string): unknown }>;
        };
      }>,
      import(pathToFileURL(modulePath).href) as Promise<PiAiCatalog>,
    ]);
    const runtime = await codingAgent.ModelRuntime.create({
      refreshOnCreate: false,
    });
    return {
      getModel: (provider, modelId) => runtime.getModel(provider, modelId),
      getSupportedThinkingLevels: piAi.getSupportedThinkingLevels,
    };
  } catch {
    return undefined;
  }
}

async function attestExtendedThinking(
  snapshot: PiCapabilitySnapshot,
): Promise<PiCapabilitySnapshot> {
  const catalog = await loadPiAiCatalog();
  if (!catalog) return snapshot;
  return {
    ...snapshot,
    models: snapshot.models.map((candidate) => {
      try {
        const model = catalog.getModel(candidate.provider, candidate.modelId);
        if (!model) return candidate;
        const levels = catalog
          .getSupportedThinkingLevels(model)
          .filter((level) => snapshot.thinkingLevels.includes(level));
        return { ...candidate, thinkingLevels: levels };
      } catch {
        return candidate;
      }
    }),
  };
}

export class InstalledPiCapabilities {
  readonly #runner: PiCapabilityRunner;
  #snapshot: Promise<PiCapabilitySnapshot> | undefined;

  constructor(
    readonly binary = process.env.PI_BIN_PATH ?? "pi",
    runner?: PiCapabilityRunner,
  ) {
    this.#runner =
      runner ??
      (async (argv) => {
        const result = await runProcess({
          executable: this.binary,
          argv,
          env: process.env,
          timeoutMs: 30_000,
          maxOutputBytes: 8 * 1024 * 1024,
        });
        return result;
      });
  }

  async snapshot(): Promise<PiCapabilitySnapshot> {
    this.#snapshot ??= Promise.all([
      this.#runner(["--help"]),
      this.#runner(["--list-models"]),
    ]).then(([help, models]) => {
      if (help.status !== 0 || models.status !== 0)
        throw new Error("PI_CAPABILITY_DISCOVERY_FAILED");
      return attestExtendedThinking(
        parsePiCapabilities(help.stdout, models.stdout),
      );
    });
    return await this.#snapshot;
  }

  async validate(selection: ModelSelection): Promise<void> {
    const capabilities = await this.snapshot();
    const model = capabilities.models.find(
      (candidate) =>
        candidate.provider === selection.provider &&
        candidate.modelId === selection.modelId,
    );
    if (!model) throw new Error("PI_MODEL_UNAVAILABLE");
    if (!model.thinkingLevels.includes(selection.thinkingLevel))
      throw new Error("PI_THINKING_UNAVAILABLE");
  }

  clear(): void {
    this.#snapshot = undefined;
  }
}
