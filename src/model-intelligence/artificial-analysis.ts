import type {
  ArtificialAnalysisMetric,
  ArtificialAnalysisSourceConfig,
  EndpointMapping,
  ModelIntelligenceConfig,
} from "../broker/endpoint-policy.js";
import type { ModelPolicyConfig } from "../broker/model-policy.js";
import type { PiCapabilitySnapshot } from "../pi/model-capabilities.js";
import { canonicalJson, sha256 } from "../shared/canonical-json.js";
import {
  normalizeModelEvidence,
  type ModelEvidenceRecord,
} from "./model-evidence.js";

export const ARTIFICIAL_ANALYSIS_SOURCE_NAME = "artificial-analysis-v2";
export const ARTIFICIAL_ANALYSIS_CREDENTIAL_FILE =
  ".config/pi-herdr-orchestrator/artificial-analysis.key";
const API_ROOT = "https://artificialanalysis.ai/api/v2/language/models";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_ATTEMPTS_PER_MODEL = 3;
const FUTURE_SKEW_MS = 5 * 60_000;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MODEL_KEYS = new Set([
  "id",
  "name",
  "slug",
  "release_date",
  "model_creator",
  "country",
  "reasoning_model",
  "evaluations",
  "artificial_analysis_intelligence_index_cost",
  "cost_per_task",
  "artificial_analysis_intelligence_index_token_counts",
  "pricing",
  "performance",
  "context_window_tokens",
  "parameters",
  "modalities",
  "licensing",
  "evaluation_token_counts",
  "aa_omniscience_breakdown",
  "artificial_analysis_openness_index_breakdown",
  "providers",
]);
const EVALUATION_KEYS = new Set([
  "artificial_analysis_intelligence_index",
  "artificial_analysis_coding_index",
  "artificial_analysis_agentic_index",
  "tau2_telecom",
  "tau_banking",
  "terminalbench_hard",
  "terminalbench_v2_1",
  "scicode",
  "aa_lcr",
  "aa_omniscience_index",
  "aa_omniscience_accuracy",
  "aa_omniscience_non_hallucination_rate",
  "ifbench",
  "hle",
  "gpqa_diamond",
  "critpt",
  "gdpval_aa_elo",
  "gdpval_aa_normalized",
  "mmmu_pro",
  "artificial_analysis_openness_index",
  "artificial_analysis_multilingual_index",
]);

export type FoundationRefreshErrorCode =
  | "missing_credential"
  | "request_budget"
  | "unauthorized"
  | "entitlement_required"
  | "rate_limited"
  | "unknown_model"
  | "source_unavailable"
  | "response_too_large"
  | "malformed_response"
  | "partial_response"
  | "future_dated"
  | "aborted";

export class FoundationRefreshError extends Error {
  constructor(
    readonly code: FoundationRefreshErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "FoundationRefreshError";
  }
}

export interface ScopedFoundationModel {
  readonly canonicalModelId: string;
  readonly slug: string;
  readonly runtimeMappings: readonly EndpointMapping[];
}

export interface ArtificialAnalysisRefreshResult {
  readonly sourceName: typeof ARTIFICIAL_ANALYSIS_SOURCE_NAME;
  readonly observedAt: string;
  readonly records: readonly ModelEvidenceRecord[];
  readonly canonicalModelIds: readonly string[];
  readonly requestCount: number;
  readonly attribution: "Artificial Analysis";
}

export type FoundationFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface ArtificialAnalysisAdapterOptions {
  readonly fetch?: FoundationFetch;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

function activeExactMappings(
  config: ModelIntelligenceConfig,
): EndpointMapping[] {
  return config.mappings.filter(
    (mapping) =>
      mapping.modelId !== undefined && mapping.canonicalModelId !== undefined,
  );
}

export function resolveScopedFoundationModels(input: {
  readonly capabilities: PiCapabilitySnapshot;
  readonly policy: ModelPolicyConfig;
  readonly modelIntelligence: ModelIntelligenceConfig;
}): ScopedFoundationModel[] {
  const source = input.modelIntelligence.sources?.artificialAnalysis;
  if (!source?.enabled) return [];
  const sourceModels = new Map(
    source.models.map((model) => [model.canonicalModelId, model.slug] as const),
  );
  const allowed = input.policy.allowlist;
  const grouped = new Map<string, EndpointMapping[]>();
  for (const mapping of activeExactMappings(input.modelIntelligence)) {
    const installed = input.capabilities.models.find(
      (model) =>
        model.provider === mapping.provider &&
        model.modelId === mapping.modelId,
    );
    if (!installed || !mapping.canonicalModelId) continue;
    const permitted =
      allowed === undefined ||
      allowed.some(
        (selection) =>
          selection.provider === mapping.provider &&
          selection.modelId === mapping.modelId &&
          installed.thinkingLevels.includes(selection.thinkingLevel),
      );
    if (!permitted || !sourceModels.has(mapping.canonicalModelId)) continue;
    const list = grouped.get(mapping.canonicalModelId) ?? [];
    list.push(mapping);
    grouped.set(mapping.canonicalModelId, list);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([canonicalModelId, runtimeMappings]) => ({
      canonicalModelId,
      slug: sourceModels.get(canonicalModelId)!,
      runtimeMappings: [...runtimeMappings].sort((left, right) =>
        `${left.provider}\u0000${left.modelId}`.localeCompare(
          `${right.provider}\u0000${right.modelId}`,
        ),
      ),
    }));
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new FoundationRefreshError(
          "aborted",
          "Foundation refresh was aborted.",
        ),
      );
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(
          new FoundationRefreshError(
            "aborted",
            "Foundation refresh was aborted.",
          ),
        );
      },
      { once: true },
    );
  });
}

async function boundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw new FoundationRefreshError(
      "response_too_large",
      "Foundation response exceeds the size limit.",
    );
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new FoundationRefreshError(
          "response_too_large",
          "Foundation response exceeds the size limit.",
        );
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function responseError(status: number): FoundationRefreshError {
  if (status === 401)
    return new FoundationRefreshError(
      "unauthorized",
      "Foundation credential was rejected.",
    );
  if (status === 403)
    return new FoundationRefreshError(
      "entitlement_required",
      "Foundation source access requires a supported account tier.",
    );
  if (status === 404)
    return new FoundationRefreshError(
      "unknown_model",
      "Foundation source model was not found.",
    );
  if (status === 429)
    return new FoundationRefreshError(
      "rate_limited",
      "Foundation source rate limit was reached.",
      true,
    );
  if (status >= 500)
    return new FoundationRefreshError(
      "source_unavailable",
      "Foundation source is unavailable.",
      true,
    );
  return new FoundationRefreshError(
    "malformed_response",
    "Foundation source returned an unexpected status.",
  );
}

function retryAfterMs(response: Response): number {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, date - Date.now()))
    : 0;
}

function combineSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FoundationRefreshError(
      "malformed_response",
      `${path} is invalid.`,
    );
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw new FoundationRefreshError(
      "malformed_response",
      `${path} shape is invalid.`,
    );
}

function allowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new FoundationRefreshError(
      "malformed_response",
      `${path} shape is invalid.`,
    );
}

function boundedIdentity(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new FoundationRefreshError("partial_response", `${path} is invalid.`);
  return value;
}

function score(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  )
    throw new FoundationRefreshError(
      "partial_response",
      `${path} is missing or invalid.`,
    );
  return Math.round(value * 10_000);
}

function parseSourceModel(
  value: unknown,
  expectedSlug: string,
  nowMs: number,
): {
  readonly sourceModelId: string;
  readonly slug: string;
  readonly releaseDate: string;
  readonly indexVersion: string;
  readonly values: Readonly<Record<ArtificialAnalysisMetric, number>>;
} {
  const root = object(value, "Artificial Analysis response");
  exactKeys(
    root,
    ["tier", "intelligence_index_version", "data"],
    "Artificial Analysis response",
  );
  const data = object(root.data, "Artificial Analysis model");
  allowedKeys(data, MODEL_KEYS, "Artificial Analysis model");
  if (
    !Object.hasOwn(data, "id") ||
    !Object.hasOwn(data, "name") ||
    !Object.hasOwn(data, "slug") ||
    !Object.hasOwn(data, "release_date") ||
    !Object.hasOwn(data, "model_creator") ||
    !Object.hasOwn(data, "evaluations")
  )
    throw new FoundationRefreshError(
      "partial_response",
      "Foundation model identity is incomplete.",
    );
  if (data.slug !== expectedSlug)
    throw new FoundationRefreshError(
      "unknown_model",
      "Foundation source model identity did not match.",
    );
  if (
    (root.tier !== "pro" && root.tier !== "commercial") ||
    (typeof root.intelligence_index_version !== "number" &&
      typeof root.intelligence_index_version !== "string")
  )
    throw new FoundationRefreshError(
      "partial_response",
      "Foundation response metadata is incomplete.",
    );
  const releaseDate = String(data.release_date ?? "");
  const releaseMs = Date.parse(releaseDate);
  if (!Number.isFinite(releaseMs))
    throw new FoundationRefreshError(
      "partial_response",
      "Foundation release date is invalid.",
    );
  if (releaseMs > nowMs + FUTURE_SKEW_MS)
    throw new FoundationRefreshError(
      "future_dated",
      "Foundation response is future-dated.",
    );
  const sourceModelId = String(data.id);
  if (!UUID.test(sourceModelId))
    throw new FoundationRefreshError(
      "partial_response",
      "Foundation model ID is invalid.",
    );
  boundedIdentity(data.name, "Foundation model name");
  const creator = object(
    data.model_creator,
    "Artificial Analysis model creator",
  );
  exactKeys(creator, ["id", "name"], "Artificial Analysis model creator");
  if (
    typeof creator.id !== "string" ||
    !UUID.test(creator.id) ||
    boundedIdentity(creator.name, "Foundation model creator name").length < 1
  )
    throw new FoundationRefreshError(
      "partial_response",
      "Foundation model creator is invalid.",
    );
  const evaluations = object(
    data.evaluations,
    "Artificial Analysis evaluations",
  );
  allowedKeys(evaluations, EVALUATION_KEYS, "Artificial Analysis evaluations");
  return {
    sourceModelId,
    slug: expectedSlug,
    releaseDate,
    indexVersion: String(root.intelligence_index_version),
    values: {
      coding: score(
        evaluations.artificial_analysis_coding_index,
        "coding index",
      ),
      intelligence: score(
        evaluations.artificial_analysis_intelligence_index,
        "intelligence index",
      ),
      agentic: score(
        evaluations.artificial_analysis_agentic_index,
        "agentic index",
      ),
    },
  };
}

export class ArtificialAnalysisFoundationAdapter {
  readonly #fetch: FoundationFetch;
  readonly #sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;

  constructor(options: ArtificialAnalysisAdapterOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  async refresh(input: {
    readonly credential: string | undefined;
    readonly scope: readonly ScopedFoundationModel[];
    readonly config: ArtificialAnalysisSourceConfig;
    readonly now: number;
    readonly signal?: AbortSignal;
  }): Promise<ArtificialAnalysisRefreshResult> {
    if (!input.credential)
      throw new FoundationRefreshError(
        "missing_credential",
        "Foundation credential is unavailable.",
      );
    if (input.scope.length < 1)
      return {
        sourceName: ARTIFICIAL_ANALYSIS_SOURCE_NAME,
        observedAt: new Date(input.now).toISOString(),
        records: [],
        canonicalModelIds: [],
        requestCount: 0,
        attribution: "Artificial Analysis",
      };
    if (input.scope.length > input.config.maxRequestsPerRefresh)
      throw new FoundationRefreshError(
        "request_budget",
        "Foundation scope exceeds the request budget.",
      );
    let requestCount = 0;
    const models: Array<{
      scope: ScopedFoundationModel;
      source: ReturnType<typeof parseSourceModel>;
    }> = [];
    for (const scoped of input.scope) {
      let completed: ReturnType<typeof parseSourceModel> | undefined;
      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt++) {
        if (requestCount >= input.config.maxRequestsPerRefresh)
          throw new FoundationRefreshError(
            "request_budget",
            "Foundation request budget was exhausted.",
          );
        if (input.signal?.aborted)
          throw new FoundationRefreshError(
            "aborted",
            "Foundation refresh was aborted.",
          );
        requestCount++;
        let response: Response;
        try {
          response = await this.#fetch(
            `${API_ROOT}/${encodeURIComponent(scoped.slug)}`,
            {
              method: "GET",
              headers: {
                accept: "application/json",
                "x-api-key": input.credential,
              },
              redirect: "error",
              signal: combineSignal(input.signal),
            },
          );
        } catch (error) {
          if (input.signal?.aborted || (error as Error).name === "AbortError")
            throw new FoundationRefreshError(
              "aborted",
              "Foundation refresh was aborted.",
            );
          if (attempt + 1 >= MAX_ATTEMPTS_PER_MODEL)
            throw new FoundationRefreshError(
              "source_unavailable",
              "Foundation source request failed.",
              true,
            );
          const delay =
            Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** attempt) +
            Math.floor(this.#random() * 250);
          await this.#sleep(delay, input.signal);
          continue;
        }
        if (!response.ok) {
          const failure = responseError(response.status);
          if (!failure.retryable || attempt + 1 >= MAX_ATTEMPTS_PER_MODEL)
            throw failure;
          const delay =
            Math.max(
              retryAfterMs(response),
              Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** attempt),
            ) + Math.floor(this.#random() * 250);
          await this.#sleep(Math.min(MAX_RETRY_DELAY_MS, delay), input.signal);
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(await boundedBody(response)) as unknown;
        } catch (error) {
          if (error instanceof FoundationRefreshError) throw error;
          throw new FoundationRefreshError(
            "malformed_response",
            "Foundation response is not valid JSON.",
          );
        }
        completed = parseSourceModel(parsed, scoped.slug, input.now);
        break;
      }
      if (!completed)
        throw new FoundationRefreshError(
          "partial_response",
          "Foundation response did not complete.",
        );
      models.push({ scope: scoped, source: completed });
    }
    const observedAt = new Date(input.now).toISOString();
    const expiresAt = new Date(
      input.now + Math.min(365 * 24, input.config.refreshHours * 3) * 3_600_000,
    ).toISOString();
    const records: ModelEvidenceRecord[] = [];
    for (const { scope, source } of models)
      for (const [taskProfile, metric] of Object.entries(
        input.config.profileMetrics,
      ).sort(([left], [right]) => left.localeCompare(right))) {
        const sourceKey = `aa-v2:${sha256(
          canonicalJson({
            canonicalModelId: scope.canonicalModelId,
            sourceModelId: source.sourceModelId,
            slug: source.slug,
            releaseDate: source.releaseDate,
            indexVersion: source.indexVersion,
            metric,
            valuePpm: source.values[metric],
          }),
        )}`;
        records.push(
          normalizeModelEvidence({
            schemaVersion: 1,
            evidenceKind: "score",
            sourceKind: "foundation",
            sourceName: ARTIFICIAL_ANALYSIS_SOURCE_NAME,
            sourceKey,
            taskProfile,
            subject: {
              kind: "canonical",
              canonicalModelId: scope.canonicalModelId,
            },
            sampleCount: 1,
            observedAt,
            expiresAt,
            dimension: "task_capability",
            valuePpm: source.values[metric],
            confidencePpm: 600_000,
          }),
        );
      }
    return {
      sourceName: ARTIFICIAL_ANALYSIS_SOURCE_NAME,
      observedAt,
      records,
      canonicalModelIds: models.map(({ scope }) => scope.canonicalModelId),
      requestCount,
      attribution: "Artificial Analysis",
    };
  }
}
