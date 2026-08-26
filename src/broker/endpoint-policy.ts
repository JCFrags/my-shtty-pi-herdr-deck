import { createHash } from "node:crypto";
import type { ModelSelection } from "./model-policy.js";

export const DERIVED_ENDPOINT_PREFIX = "derived-v1-";
export const MAX_ENDPOINTS = 64;
export const MAX_ENDPOINT_MAPPINGS = 128;
export const MAX_ENDPOINT_CONCURRENCY = 32;

const ENDPOINT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export interface EndpointLimit {
  readonly maxConcurrentAgents: number;
}

export interface EndpointMapping {
  readonly provider: string;
  readonly modelId?: string;
  readonly endpointId: string;
}

export interface ModelIntelligenceConfig {
  readonly schemaVersion: 1;
  readonly mappings: readonly EndpointMapping[];
}

export interface EndpointPolicyConfig {
  readonly endpoints?: Readonly<Record<string, EndpointLimit>>;
  readonly mappings?: readonly EndpointMapping[];
}

export interface ResolvedEndpoint {
  readonly endpointId: string;
  readonly maxConcurrentAgents: number;
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
        Object.keys(limit).length !== 1 ||
        !Object.hasOwn(limit, "maxConcurrentAgents") ||
        !Number.isSafeInteger(limit.maxConcurrentAgents) ||
        Number(limit.maxConcurrentAgents) < 1 ||
        Number(limit.maxConcurrentAgents) > MAX_ENDPOINT_CONCURRENCY
      )
        throw new Error(
          `scheduler.endpoints.${endpointId}.maxConcurrentAgents is outside its safe bounds.`,
        );
      endpoints[endpointId] = {
        maxConcurrentAgents: Number(limit.maxConcurrentAgents),
      };
    }
  }

  let modelIntelligence: ModelIntelligenceConfig | undefined;
  if (modelIntelligenceValue !== undefined) {
    const input = object(modelIntelligenceValue, "modelIntelligence");
    if (
      Object.keys(input).some(
        (key) => key !== "schemaVersion" && key !== "mappings",
      ) ||
      input.schemaVersion !== 1 ||
      !Array.isArray(input.mappings) ||
      input.mappings.length < 1 ||
      input.mappings.length > MAX_ENDPOINT_MAPPINGS
    )
      throw new Error("modelIntelligence is invalid.");
    if (!endpoints)
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
            key !== "provider" && key !== "modelId" && key !== "endpointId",
        ) ||
        !boundedText(mapping.provider, 128) ||
        (mapping.modelId !== undefined && !boundedText(mapping.modelId, 256)) ||
        !validConfiguredEndpointId(mapping.endpointId) ||
        !endpoints[mapping.endpointId]
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
      });
    }
    modelIntelligence = { schemaVersion: 1, mappings };
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
    mapping: exact ? "exact" : "provider",
  };
}
