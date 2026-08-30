import { createHash } from "node:crypto";
import type { ModelSelection } from "./model-policy.js";

export const DERIVED_ENDPOINT_PREFIX = "derived-v1-";
export const MAX_ENDPOINTS = 64;
export const MAX_ENDPOINT_MAPPINGS = 128;
export const MAX_ENDPOINT_CONCURRENCY = 32;
export const MAX_FOUNDATION_MODELS = 64;
export const MAX_FOUNDATION_PROFILES = 32;
export const MAX_FOUNDATION_REQUESTS = 32;
export const MAX_FOUNDATION_RECORDS_PER_REFRESH = 256;
export const MAX_MODEL_RANKING_PROFILES = 32;
export const PPM_TOTAL = 1_000_000;

export type ArtificialAnalysisMetric = "coding" | "intelligence" | "agentic";
export type ModelRoutingMode =
  "current_default" | "advisory" | "rated_auto" | "explicit_required";

export interface ModelRankingWeightsPpm {
  readonly taskCapability: number;
  readonly protocolReliability: number;
  readonly speed: number;
  readonly effectiveCost: number;
  readonly humanPreference: number;
}

export interface ModelRankingProfileConfig {
  readonly weightsPpm: ModelRankingWeightsPpm;
  readonly uncertaintyPenaltyPpm: number;
  readonly tieBandPpm: number;
}

export interface ArtificialAnalysisModelMapping {
  readonly canonicalModelId: string;
  readonly slug: string;
}

export interface ArtificialAnalysisSourceConfig {
  readonly enabled: boolean;
  readonly refreshHours: number;
  readonly maxRequestsPerRefresh: number;
  readonly profileMetrics: Readonly<Record<string, ArtificialAnalysisMetric>>;
  readonly models: readonly ArtificialAnalysisModelMapping[];
}

export interface ModelFoundationSourcesConfig {
  readonly artificialAnalysis?: ArtificialAnalysisSourceConfig;
}

const ENDPOINT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export type EndpointResourceClass = "local_compute" | "remote_service";

export interface EndpointLimit {
  readonly maxConcurrentAgents: number;
  readonly resourceClass?: EndpointResourceClass;
}

export interface EndpointMapping {
  readonly provider: string;
  readonly modelId?: string;
  readonly endpointId: string;
  readonly canonicalModelId?: string;
  readonly quantization?: string;
}

export interface ModelIntelligenceConfig {
  readonly schemaVersion: 1;
  readonly routingMode?: ModelRoutingMode;
  readonly mappings: readonly EndpointMapping[];
  readonly profiles?: Readonly<Record<string, ModelRankingProfileConfig>>;
  readonly sources?: ModelFoundationSourcesConfig;
}

export interface EndpointPolicyConfig {
  readonly endpoints?: Readonly<Record<string, EndpointLimit>>;
  readonly mappings?: readonly EndpointMapping[];
}

export interface ResolvedEndpoint {
  readonly endpointId: string;
  readonly maxConcurrentAgents: number;
  readonly resourceClass?: EndpointResourceClass;
  readonly mapping: "exact" | "provider" | "derived";
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object.`);
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function validConfiguredEndpointId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ENDPOINT_ID_PATTERN.test(value) &&
    !value.startsWith(DERIVED_ENDPOINT_PREFIX)
  );
}

export function derivedEndpointId(provider: string): string {
  return `${DERIVED_ENDPOINT_PREFIX}${createHash("sha256")
    .update(provider)
    .digest("hex")
    .slice(0, 24)}`;
}

export function validateEndpointPolicyConfig(
  endpointsValue: unknown,
  modelIntelligenceValue: unknown,
): {
  endpoints?: Record<string, EndpointLimit>;
  modelIntelligence?: ModelIntelligenceConfig;
} {
  let endpoints: Record<string, EndpointLimit> | undefined;
  if (endpointsValue !== undefined) {
    const input = object(endpointsValue, "scheduler.endpoints");
    const entries = Object.entries(input);
    if (entries.length < 1 || entries.length > MAX_ENDPOINTS)
      throw new Error("scheduler.endpoints must contain 1 to 64 endpoints.");
    endpoints = {};
    for (const [endpointId, rawLimit] of entries) {
      if (!validConfiguredEndpointId(endpointId))
        throw new Error("scheduler.endpoints has an invalid endpoint ID.");
      const limit = object(rawLimit, `scheduler.endpoints.${endpointId}`);
      if (
        Object.keys(limit).some(
          (key) => key !== "maxConcurrentAgents" && key !== "resourceClass",
        ) ||
        !Object.hasOwn(limit, "maxConcurrentAgents") ||
        !Number.isSafeInteger(limit.maxConcurrentAgents) ||
        Number(limit.maxConcurrentAgents) < 1 ||
        Number(limit.maxConcurrentAgents) > MAX_ENDPOINT_CONCURRENCY ||
        (limit.resourceClass !== undefined &&
          limit.resourceClass !== "local_compute" &&
          limit.resourceClass !== "remote_service")
      )
        throw new Error(
          `scheduler.endpoints.${endpointId} is outside its safe bounds.`,
        );
      endpoints[endpointId] = {
        maxConcurrentAgents: Number(limit.maxConcurrentAgents),
        ...(limit.resourceClass !== undefined
          ? { resourceClass: limit.resourceClass as EndpointResourceClass }
          : {}),
      };
    }
  }

  let modelIntelligence: ModelIntelligenceConfig | undefined;
  if (modelIntelligenceValue !== undefined) {
    const input = object(modelIntelligenceValue, "modelIntelligence");
    if (
      Object.keys(input).some(
        (key) =>
          key !== "schemaVersion" &&
          key !== "routingMode" &&
          key !== "mappings" &&
          key !== "profiles" &&
          key !== "sources",
      ) ||
      input.schemaVersion !== 1 ||
      (input.routingMode !== undefined &&
        ![
          "current_default",
          "advisory",
          "rated_auto",
          "explicit_required",
        ].includes(String(input.routingMode))) ||
      !Array.isArray(input.mappings) ||
      input.mappings.length > MAX_ENDPOINT_MAPPINGS
    )
      throw new Error("modelIntelligence is invalid.");
    if (input.mappings.length > 0 && !endpoints)
      throw new Error(
        "modelIntelligence mappings require scheduler.endpoints.",
      );
    const mappings: EndpointMapping[] = [];
    const mappingKeys = new Set<string>();
    for (const [index, rawMapping] of input.mappings.entries()) {
      const mapping = object(
        rawMapping,
        `modelIntelligence.mappings[${index}]`,
      );
      if (
        Object.keys(mapping).some(
          (key) =>
            key !== "provider" &&
            key !== "modelId" &&
            key !== "endpointId" &&
            key !== "canonicalModelId" &&
            key !== "quantization",
        ) ||
        !boundedText(mapping.provider, 128) ||
        (mapping.modelId !== undefined && !boundedText(mapping.modelId, 256)) ||
        (mapping.canonicalModelId !== undefined &&
          (typeof mapping.canonicalModelId !== "string" ||
            !/^[a-z0-9][a-z0-9._/-]{0,255}$/u.test(
              mapping.canonicalModelId,
            ))) ||
        (mapping.quantization !== undefined &&
          !boundedText(mapping.quantization, 64)) ||
        ((mapping.canonicalModelId !== undefined ||
          mapping.quantization !== undefined) &&
          mapping.modelId === undefined) ||
        !validConfiguredEndpointId(mapping.endpointId) ||
        !endpoints?.[mapping.endpointId]
      )
        throw new Error(`modelIntelligence.mappings[${index}] is invalid.`);
      const key = `${mapping.provider}\u0000${mapping.modelId ?? ""}`;
      if (mappingKeys.has(key))
        throw new Error("modelIntelligence contains a duplicate mapping.");
      mappingKeys.add(key);
      mappings.push({
        provider: mapping.provider,
        ...(mapping.modelId !== undefined ? { modelId: mapping.modelId } : {}),
        endpointId: mapping.endpointId,
        ...(mapping.canonicalModelId !== undefined
          ? { canonicalModelId: mapping.canonicalModelId }
          : {}),
        ...(mapping.quantization !== undefined
          ? { quantization: mapping.quantization }
          : {}),
      });
    }
    let profiles: Record<string, ModelRankingProfileConfig> | undefined;
    if (input.profiles !== undefined) {
      const profileInput = object(input.profiles, "modelIntelligence.profiles");
      const entries = Object.entries(profileInput);
      if (entries.length < 1 || entries.length > MAX_MODEL_RANKING_PROFILES)
        throw new Error("modelIntelligence.profiles is invalid.");
      profiles = {};
      for (const [profileId, rawProfile] of entries) {
        if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(profileId))
          throw new Error("modelIntelligence.profiles is invalid.");
        const profile = object(
          rawProfile,
          `modelIntelligence.profiles.${profileId}`,
        );
        const weights = object(
          profile.weightsPpm,
          `modelIntelligence.profiles.${profileId}.weightsPpm`,
        );
        const weightKeys = [
          "taskCapability",
          "protocolReliability",
          "speed",
          "effectiveCost",
          "humanPreference",
        ] as const;
        if (
          Object.keys(profile).some(
            (key) =>
              !["weightsPpm", "uncertaintyPenaltyPpm", "tieBandPpm"].includes(
                key,
              ),
          ) ||
          Object.keys(weights).length !== weightKeys.length ||
          Object.keys(weights).some(
            (key) => !weightKeys.includes(key as (typeof weightKeys)[number]),
          ) ||
          !weightKeys.every(
            (key) =>
              Number.isSafeInteger(weights[key]) &&
              Number(weights[key]) >= 0 &&
              Number(weights[key]) <= PPM_TOTAL,
          ) ||
          weightKeys.reduce((sum, key) => sum + Number(weights[key]), 0) !==
            PPM_TOTAL ||
          !Number.isSafeInteger(profile.uncertaintyPenaltyPpm) ||
          Number(profile.uncertaintyPenaltyPpm) < 0 ||
          Number(profile.uncertaintyPenaltyPpm) > PPM_TOTAL ||
          !Number.isSafeInteger(profile.tieBandPpm) ||
          Number(profile.tieBandPpm) < 0 ||
          Number(profile.tieBandPpm) > PPM_TOTAL
        )
          throw new Error(
            `modelIntelligence.profiles.${profileId} is invalid.`,
          );
        profiles[profileId] = {
          weightsPpm: {
            taskCapability: Number(weights.taskCapability),
            protocolReliability: Number(weights.protocolReliability),
            speed: Number(weights.speed),
            effectiveCost: Number(weights.effectiveCost),
            humanPreference: Number(weights.humanPreference),
          },
          uncertaintyPenaltyPpm: Number(profile.uncertaintyPenaltyPpm),
          tieBandPpm: Number(profile.tieBandPpm),
        };
      }
    }
    let sources: ModelFoundationSourcesConfig | undefined;
    if (input.sources !== undefined) {
      const sourceInput = object(input.sources, "modelIntelligence.sources");
      if (Object.keys(sourceInput).some((key) => key !== "artificialAnalysis"))
        throw new Error("modelIntelligence.sources is invalid.");
      if (sourceInput.artificialAnalysis !== undefined) {
        const raw = object(
          sourceInput.artificialAnalysis,
          "modelIntelligence.sources.artificialAnalysis",
        );
        if (
          Object.keys(raw).some(
            (key) =>
              ![
                "enabled",
                "refreshHours",
                "maxRequestsPerRefresh",
                "profileMetrics",
                "models",
              ].includes(key),
          ) ||
          typeof raw.enabled !== "boolean" ||
          !Number.isSafeInteger(raw.refreshHours) ||
          Number(raw.refreshHours) < 1 ||
          Number(raw.refreshHours) > 8_760 ||
          !Number.isSafeInteger(raw.maxRequestsPerRefresh) ||
          Number(raw.maxRequestsPerRefresh) < 1 ||
          Number(raw.maxRequestsPerRefresh) > MAX_FOUNDATION_REQUESTS
        )
          throw new Error(
            "modelIntelligence.sources.artificialAnalysis is invalid.",
          );
        const profileInput = object(
          raw.profileMetrics,
          "modelIntelligence.sources.artificialAnalysis.profileMetrics",
        );
        const profileEntries = Object.entries(profileInput);
        if (
          profileEntries.length < 1 ||
          profileEntries.length > MAX_FOUNDATION_PROFILES ||
          profileEntries.length * Number(raw.maxRequestsPerRefresh) >
            MAX_FOUNDATION_RECORDS_PER_REFRESH
        )
          throw new Error(
            "modelIntelligence.sources.artificialAnalysis.profileMetrics is invalid.",
          );
        const profileMetrics: Record<string, ArtificialAnalysisMetric> = {};
        for (const [profile, metric] of profileEntries) {
          if (
            !/^[a-z][a-z0-9_-]{0,63}$/u.test(profile) ||
            !["coding", "intelligence", "agentic"].includes(String(metric))
          )
            throw new Error(
              "modelIntelligence.sources.artificialAnalysis.profileMetrics is invalid.",
            );
          profileMetrics[profile] = metric as ArtificialAnalysisMetric;
        }
        if (
          !Array.isArray(raw.models) ||
          raw.models.length < 1 ||
          raw.models.length > MAX_FOUNDATION_MODELS
        )
          throw new Error(
            "modelIntelligence.sources.artificialAnalysis.models is invalid.",
          );
        const models: ArtificialAnalysisModelMapping[] = [];
        const canonicalIds = new Set<string>();
        const slugs = new Set<string>();
        const configuredCanonicalIds = new Set(
          mappings
            .map((mapping) => mapping.canonicalModelId)
            .filter((value): value is string => value !== undefined),
        );
        for (const [index, rawModel] of raw.models.entries()) {
          const model = object(
            rawModel,
            `modelIntelligence.sources.artificialAnalysis.models[${index}]`,
          );
          if (
            Object.keys(model).some(
              (key) => key !== "canonicalModelId" && key !== "slug",
            ) ||
            typeof model.canonicalModelId !== "string" ||
            !/^[a-z0-9][a-z0-9._/-]{0,255}$/u.test(model.canonicalModelId) ||
            typeof model.slug !== "string" ||
            !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(model.slug) ||
            !configuredCanonicalIds.has(model.canonicalModelId) ||
            canonicalIds.has(model.canonicalModelId) ||
            slugs.has(model.slug)
          )
            throw new Error(
              `modelIntelligence.sources.artificialAnalysis.models[${index}] is invalid.`,
            );
          canonicalIds.add(model.canonicalModelId);
          slugs.add(model.slug);
          models.push({
            canonicalModelId: model.canonicalModelId,
            slug: model.slug,
          });
        }
        sources = {
          artificialAnalysis: {
            enabled: raw.enabled,
            refreshHours: Number(raw.refreshHours),
            maxRequestsPerRefresh: Number(raw.maxRequestsPerRefresh),
            profileMetrics,
            models,
          },
        };
      }
    }
    modelIntelligence = {
      schemaVersion: 1,
      routingMode: (input.routingMode ?? "current_default") as ModelRoutingMode,
      mappings,
      ...(profiles ? { profiles } : {}),
      ...(sources ? { sources } : {}),
    };
  }
  return {
    ...(endpoints ? { endpoints } : {}),
    ...(modelIntelligence ? { modelIntelligence } : {}),
  };
}

export function resolveEndpoint(
  model: Pick<ModelSelection, "provider" | "modelId">,
  policy: EndpointPolicyConfig,
  fallbackLimit: number,
): ResolvedEndpoint {
  const exact = policy.mappings?.find(
    (mapping) =>
      mapping.provider === model.provider && mapping.modelId === model.modelId,
  );
  const provider = policy.mappings?.find(
    (mapping) =>
      mapping.provider === model.provider && mapping.modelId === undefined,
  );
  const mapping = exact ?? provider;
  if (!mapping)
    return {
      endpointId: derivedEndpointId(model.provider),
      maxConcurrentAgents: fallbackLimit,
      mapping: "derived",
    };
  const limit = policy.endpoints?.[mapping.endpointId];
  if (!limit)
    throw new Error(
      `Endpoint mapping references unknown endpoint: ${mapping.endpointId}.`,
    );
  return {
    endpointId: mapping.endpointId,
    maxConcurrentAgents: limit.maxConcurrentAgents,
    ...(limit.resourceClass !== undefined
      ? { resourceClass: limit.resourceClass }
      : {}),
    mapping: exact ? "exact" : "provider",
  };
}
