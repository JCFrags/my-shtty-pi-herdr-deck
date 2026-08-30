import { canonicalJson, sha256 } from "../shared/canonical-json.js";
import {
  resolveEndpoint,
  type EndpointPolicyConfig,
  type ModelIntelligenceConfig,
  type ModelRoutingMode,
  type ModelRankingProfileConfig,
} from "../broker/endpoint-policy.js";
import {
  resolveSpawnPolicy,
  validateModelSelection,
  type AgentPlacement,
  type ModelPolicyConfig,
  type ModelProfileId,
  type ModelSelection,
} from "../broker/model-policy.js";
import type { PiCapabilitySnapshot } from "../pi/model-capabilities.js";
import type { SchedulerSnapshot } from "../scheduler/scheduler.js";
import {
  projectModelEvidence,
  type ModelEvidenceCandidate,
  type ModelEvidenceCandidateProjection,
  type ModelEvidenceState,
} from "./model-evidence.js";

export const MODEL_RANKING_POLICY = Object.freeze({
  schemaVersion: 1 as const,
  scorerVersion: 1 as const,
  weightsPpm: Object.freeze({
    task_capability: 450_000,
    protocol_reliability: 250_000,
    speed: 100_000,
    effective_cost: 50_000,
    preference: 150_000,
  }),
  uncertaintyPenaltyPpm: 100_000,
  tieBandPpm: 20_000,
  maxEligibleCandidates: 256,
  maxReturnedCandidates: 16,
  maxReturnedExclusions: 16,
  maxReceiptAlternatives: 5,
  maxSourceDates: 16,
});

const PPM = 1_000_000;
const DIGEST = /^[a-f0-9]{64}$/u;

export interface ModelCapacityView {
  readonly endpointId: string;
  readonly limit: number;
  readonly active: number;
  readonly queued: number;
  readonly available: number;
}

export interface RankedModelOption {
  readonly rank: number;
  readonly selection: ModelSelection;
  readonly endpoint: ModelCapacityView;
  readonly scorePpm: number;
  readonly utilityPpm: number;
  readonly uncertaintyPenaltyPpm: number;
  readonly confidencePpm: number;
  readonly tiedWithPrevious: boolean;
  readonly components: Readonly<
    Record<
      | "taskCapability"
      | "protocolReliability"
      | "speed"
      | "effectiveCost"
      | "preference",
      number
    >
  >;
  readonly evidenceDigest: string;
}

export interface ModelOptionExclusion {
  readonly selection: ModelSelection;
  readonly reason: "policy_allowlist";
}

export interface ModelSourceDate {
  readonly sourceKind: string;
  readonly sourceName: string;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface ModelOptionsView {
  readonly schemaVersion: 1;
  readonly scorerVersion: 1;
  readonly mode: ModelRoutingMode;
  readonly taskProfile: string;
  readonly asOf: string;
  readonly modelPolicyHash: string;
  readonly scoringPolicyDigest: string;
  readonly evidenceDigest: string;
  readonly rankingDigest: string;
  readonly candidates: readonly RankedModelOption[];
  readonly eligibleCount: number;
  readonly excluded: readonly ModelOptionExclusion[];
  readonly excludedCount: number;
  readonly exclusionsDigest: string;
  readonly sourceDates: readonly ModelSourceDate[];
}

export interface AvailableModelRatingsView {
  readonly overall: string;
  readonly taskFit: string;
  readonly reliability: string;
  readonly speed: string;
  readonly value: string;
}

export interface AvailableThinkingGuideView {
  readonly thinkingLevel: string;
  readonly useFor: string;
}

export interface AvailableModelCapacityView {
  readonly status: "ready" | "will_queue";
  readonly available: number;
  readonly limit: number;
}

export interface AvailableModelThinkingView {
  readonly rank: number;
  readonly thinkingLevel: string;
  readonly recommended: boolean;
  readonly ratings: AvailableModelRatingsView;
}

export interface AvailableModelOptionView {
  readonly rank: number;
  readonly provider: string;
  readonly modelId: string;
  readonly recommended: boolean;
  readonly thinkingLevels: readonly AvailableModelThinkingView[];
  readonly capacity?: AvailableModelCapacityView;
}

export interface AvailableModelOptionsView {
  readonly profileId: string;
  readonly thinkingGuide: readonly AvailableThinkingGuideView[];
  readonly availableModels: readonly AvailableModelOptionView[];
  readonly moreAvailable: number;
}

export interface AdvisoryModelReceipt {
  readonly schemaVersion: 1;
  readonly scorerVersion: 1;
  readonly mode: ModelRoutingMode;
  readonly taskProfile: string;
  readonly asOf: string;
  readonly selectedModel: ModelSelection;
  readonly recommendedModel: ModelSelection;
  readonly selectedRank: number | null;
  readonly selectedEligible: boolean;
  readonly recommendedMatchesSelection: boolean;
  readonly selectionReason:
    | "explicit_override"
    | "current_default"
    | "rated_auto"
    | "insufficient_evidence";
  readonly modelPolicyHash: string;
  readonly scoringPolicyDigest: string;
  readonly evidenceDigest: string;
  readonly rankingDigest: string;
  readonly selectedEndpoint: ModelCapacityView;
  readonly alternatives: readonly RankedModelOption[];
  readonly eligibleCount: number;
  readonly excludedCount: number;
  readonly exclusionsDigest: string;
  readonly sourceDates: readonly ModelSourceDate[];
  readonly receiptDigest: string;
}

export interface BuildModelOptionsInput {
  readonly capabilities: PiCapabilitySnapshot;
  readonly policy: ModelPolicyConfig;
  readonly endpointPolicy: EndpointPolicyConfig;
  readonly modelIntelligence?: ModelIntelligenceConfig;
  readonly evidence?: ModelEvidenceState;
  readonly scheduler: SchedulerSnapshot;
  readonly fallbackEndpointLimit: number;
  readonly taskProfile: string;
  readonly placement?: AgentPlacement;
  readonly modelProfileId?: ModelProfileId;
  readonly projectKey?: string;
  readonly selectedModel?: ModelSelection;
  readonly asOf: string;
  readonly limit?: number;
}

function digest(domain: string, value: unknown): string {
  return sha256(`pi-herdr:${domain}:v1\0${canonicalJson(value)}`);
}

function divideHalfUp(numerator: bigint, denominator: bigint): number {
  return Number((numerator + denominator / 2n) / denominator);
}

function fiveStarDisplay(valuePpm: number): string {
  const bounded = Math.max(0, Math.min(PPM, valuePpm));
  const rating = Math.round((bounded * 5) / PPM);
  return `${"★".repeat(rating)}${"☆".repeat(5 - rating)} ${rating}/5`;
}

const THINKING_GUIDANCE = Object.freeze({
  off: "direct work; no extra reasoning",
  minimal: "tiny edits and lookups",
  low: "small, clear tasks",
  medium: "balanced default",
  high: "complex coding, debugging, or review",
  xhigh: "hard, ambiguous work; slower",
  max: "deepest reasoning; slowest",
} as const);

export function availableModelOptionsView(
  options: ModelOptionsView,
  endpointPolicy: EndpointPolicyConfig,
  limit: number = MODEL_RANKING_POLICY.maxReturnedCandidates,
): AvailableModelOptionsView {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MODEL_RANKING_POLICY.maxReturnedCandidates
  )
    throw new Error("MODEL_OPTIONS_LIMIT_INVALID");
  const groups = new Map<string, AvailableModelOptionView>();
  for (const candidate of options.candidates) {
    const key = [
      candidate.selection.provider,
      candidate.selection.modelId,
    ].join("\u0000");
    const thinking: AvailableModelThinkingView = {
      rank: candidate.rank,
      thinkingLevel: candidate.selection.thinkingLevel,
      recommended: candidate.rank === 1,
      ratings: {
        overall: fiveStarDisplay(candidate.scorePpm),
        taskFit: fiveStarDisplay(candidate.components.taskCapability),
        reliability: fiveStarDisplay(candidate.components.protocolReliability),
        speed: fiveStarDisplay(candidate.components.speed),
        value: fiveStarDisplay(candidate.components.effectiveCost),
      },
    };
    const current = groups.get(key);
    if (current) {
      groups.set(key, {
        ...current,
        recommended: current.recommended || thinking.recommended,
        thinkingLevels: [...current.thinkingLevels, thinking],
      });
      continue;
    }
    const endpoint = endpointPolicy.endpoints?.[candidate.endpoint.endpointId];
    groups.set(key, {
      rank: groups.size + 1,
      provider: candidate.selection.provider,
      modelId: candidate.selection.modelId,
      recommended: thinking.recommended,
      thinkingLevels: [thinking],
      ...(endpoint?.resourceClass === "local_compute"
        ? {
            capacity: {
              status: candidate.endpoint.available > 0 ? "ready" : "will_queue",
              available: candidate.endpoint.available,
              limit: candidate.endpoint.limit,
            } as const,
          }
        : {}),
    });
  }
  const available = [...groups.values()];
  const returned = available.slice(0, limit);
  const presentLevels = new Set(
    returned.flatMap((model) =>
      model.thinkingLevels.map((thinking) => thinking.thinkingLevel),
    ),
  );
  return {
    profileId: options.taskProfile,
    thinkingGuide: Object.entries(THINKING_GUIDANCE)
      .filter(([thinkingLevel]) => presentLevels.has(thinkingLevel))
      .map(([thinkingLevel, useFor]) => ({ thinkingLevel, useFor })),
    availableModels: returned,
    moreAvailable: available.length - returned.length,
  };
}

function selectionKey(selection: ModelSelection): string {
  return [selection.provider, selection.modelId, selection.thinkingLevel].join(
    "\u0000",
  );
}

function candidateKey(candidate: ModelEvidenceCandidate): string {
  return [
    candidate.provider,
    candidate.modelId,
    candidate.thinkingLevel,
    candidate.endpointId ?? "",
  ].join("\u0000");
}

function exactMapping(
  modelIntelligence: ModelIntelligenceConfig | undefined,
  selection: ModelSelection,
) {
  return modelIntelligence?.mappings.find(
    (mapping) =>
      mapping.provider === selection.provider &&
      mapping.modelId === selection.modelId,
  );
}

export function modelCapacityView(
  endpointId: string,
  limit: number,
  scheduler: SchedulerSnapshot,
): ModelCapacityView {
  const active = scheduler.active.filter(
    (task) => task.endpointId === endpointId,
  ).length;
  const queued = scheduler.queued.filter(
    (task) => task.endpointId === endpointId,
  ).length;
  return {
    endpointId,
    limit,
    active,
    queued,
    available: Math.max(0, limit - active),
  };
}

function sourceDates(
  state: ModelEvidenceState | undefined,
  taskProfile: string,
): ModelSourceDate[] {
  if (!state) return [];
  const values = Object.values(state.records)
    .map((stored) => stored.record)
    .filter(
      (record) =>
        record.taskProfile === taskProfile &&
        !Object.hasOwn(state.supersededBy, record.evidenceId),
    )
    .map((record) => ({
      sourceKind: record.sourceKind,
      sourceName: record.sourceName,
      observedAt: record.observedAt,
      expiresAt: record.expiresAt,
    }));
  const unique = new Map(
    values.map((value) => [canonicalJson(value), value] as const),
  );
  return [...unique.values()]
    .sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    )
    .slice(0, MODEL_RANKING_POLICY.maxSourceDates);
}

export function modelRankingProfile(
  modelIntelligence: ModelIntelligenceConfig | undefined,
  taskProfile: string,
): ModelRankingProfileConfig {
  return (
    modelIntelligence?.profiles?.[taskProfile] ?? {
      weightsPpm: {
        taskCapability: MODEL_RANKING_POLICY.weightsPpm.task_capability,
        protocolReliability:
          MODEL_RANKING_POLICY.weightsPpm.protocol_reliability,
        speed: MODEL_RANKING_POLICY.weightsPpm.speed,
        effectiveCost: MODEL_RANKING_POLICY.weightsPpm.effective_cost,
        humanPreference: MODEL_RANKING_POLICY.weightsPpm.preference,
      },
      uncertaintyPenaltyPpm: MODEL_RANKING_POLICY.uncertaintyPenaltyPpm,
      tieBandPpm: MODEL_RANKING_POLICY.tieBandPpm,
    }
  );
}

function scoreProjection(
  projection: ModelEvidenceCandidateProjection,
  endpoint: ModelCapacityView,
  rankingProfile: ModelRankingProfileConfig,
): Omit<RankedModelOption, "rank" | "tiedWithPrevious"> {
  const values = {
    taskCapability: projection.taskCapability.valuePpm,
    protocolReliability: projection.protocolReliability.valuePpm,
    speed: projection.speed.valuePpm,
    effectiveCost: projection.effectiveCost.valuePpm,
    preference: projection.preference.valuePpm,
  };
  const weights = rankingProfile.weightsPpm;
  const utilityPpm = divideHalfUp(
    BigInt(values.taskCapability) * BigInt(weights.taskCapability) +
      BigInt(values.protocolReliability) * BigInt(weights.protocolReliability) +
      BigInt(values.speed) * BigInt(weights.speed) +
      BigInt(values.effectiveCost) * BigInt(weights.effectiveCost) +
      BigInt(values.preference) * BigInt(weights.humanPreference),
    BigInt(PPM),
  );
  const uncertaintyPenaltyPpm = divideHalfUp(
    BigInt(rankingProfile.uncertaintyPenaltyPpm) *
      BigInt(PPM - projection.overallConfidencePpm),
    BigInt(PPM),
  );
  return {
    selection: validateModelSelection({
      provider: projection.candidate.provider,
      modelId: projection.candidate.modelId,
      thinkingLevel: projection.candidate.thinkingLevel,
    }),
    endpoint,
    scorePpm: utilityPpm - uncertaintyPenaltyPpm,
    utilityPpm,
    uncertaintyPenaltyPpm,
    confidencePpm: projection.overallConfidencePpm,
    components: values,
    evidenceDigest: projection.evidenceDigest,
  };
}

export function buildModelOptions(
  input: BuildModelOptionsInput,
): ModelOptionsView {
  const limit = input.limit ?? 10;
  const rankingProfile = modelRankingProfile(
    input.modelIntelligence,
    input.taskProfile,
  );
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MODEL_RANKING_POLICY.maxEligibleCandidates
  )
    throw new Error("MODEL_OPTIONS_LIMIT_INVALID");
  const routingMode = input.modelIntelligence?.routingMode ?? "current_default";
  const policySelection =
    input.selectedModel ??
    (routingMode === "explicit_required"
      ? input.policy.allowlist?.[0]
      : undefined);
  const currentPolicy = resolveSpawnPolicy(
    {
      taskProfileId: input.taskProfile,
      ...(input.placement ? { placement: input.placement } : {}),
      ...(input.modelProfileId ? { modelProfileId: input.modelProfileId } : {}),
      ...(input.projectKey ? { projectKey: input.projectKey } : {}),
      ...(policySelection ? { model: policySelection } : {}),
    },
    input.policy,
  );
  const installed = [
    ...new Map(
      input.capabilities.models
        .flatMap((model) =>
          model.thinkingLevels.map((thinkingLevel) =>
            validateModelSelection({
              provider: model.provider,
              modelId: model.modelId,
              thinkingLevel,
            }),
          ),
        )
        .map((selection) => [selectionKey(selection), selection] as const),
    ).values(),
  ];
  const eligible: ModelSelection[] = [];
  const excluded: ModelOptionExclusion[] = [];
  for (const selection of installed) {
    try {
      resolveSpawnPolicy(
        {
          taskProfileId: input.taskProfile,
          ...(input.placement ? { placement: input.placement } : {}),
          ...(input.modelProfileId
            ? { modelProfileId: input.modelProfileId }
            : {}),
          ...(input.projectKey ? { projectKey: input.projectKey } : {}),
          model: selection,
        },
        input.policy,
      );
      eligible.push(selection);
    } catch {
      excluded.push({ selection, reason: "policy_allowlist" });
    }
  }
  if (eligible.length < 1) throw new Error("MODEL_SCOPE_EMPTY");
  if (eligible.length > MODEL_RANKING_POLICY.maxEligibleCandidates)
    throw new Error("MODEL_SCOPE_TOO_LARGE");
  eligible.sort((left, right) =>
    selectionKey(left).localeCompare(selectionKey(right)),
  );
  const candidates = eligible.map((selection): ModelEvidenceCandidate => {
    const endpoint = resolveEndpoint(
      selection,
      input.endpointPolicy,
      input.fallbackEndpointLimit,
    );
    const mapping = exactMapping(input.modelIntelligence, selection);
    return {
      ...selection,
      endpointId: endpoint.endpointId,
      ...(mapping?.canonicalModelId
        ? { canonicalModelId: mapping.canonicalModelId }
        : {}),
      ...(mapping?.quantization ? { quantization: mapping.quantization } : {}),
    };
  });
  const projection = projectModelEvidence(
    input.evidence,
    candidates,
    input.taskProfile,
    input.asOf,
  );
  const identityOrder = (
    left: Omit<RankedModelOption, "rank" | "tiedWithPrevious">,
    right: Omit<RankedModelOption, "rank" | "tiedWithPrevious">,
  ) =>
    candidateKey({
      ...left.selection,
      endpointId: left.endpoint.endpointId,
    }).localeCompare(
      candidateKey({
        ...right.selection,
        endpointId: right.endpoint.endpointId,
      }),
    );
  const scored = projection.candidates
    .map((candidate) => {
      const endpoint = resolveEndpoint(
        candidate.candidate,
        input.endpointPolicy,
        input.fallbackEndpointLimit,
      );
      return scoreProjection(
        candidate,
        modelCapacityView(
          endpoint.endpointId,
          endpoint.maxConcurrentAgents,
          input.scheduler,
        ),
        rankingProfile,
      );
    })
    .sort(
      (left, right) =>
        right.scorePpm - left.scorePpm || identityOrder(left, right),
    );
  const ordered: typeof scored = [];
  const tieStarts = new Set<number>();
  for (let cursor = 0; cursor < scored.length;) {
    const start = cursor;
    const leader = scored[start]!;
    while (
      cursor < scored.length &&
      leader.scorePpm - scored[cursor]!.scorePpm <= rankingProfile.tieBandPpm
    )
      cursor++;
    tieStarts.add(ordered.length);
    ordered.push(...scored.slice(start, cursor).sort(identityOrder));
  }
  const ranked = ordered.map((candidate, index): RankedModelOption => ({
    ...candidate,
    rank: index + 1,
    tiedWithPrevious: index > 0 && !tieStarts.has(index),
  }));
  const exclusionsDigest = digest("model-option-exclusions", excluded);
  const scoringPolicyDigest = digest("model-ranking-policy", {
    schemaVersion: MODEL_RANKING_POLICY.schemaVersion,
    scorerVersion: MODEL_RANKING_POLICY.scorerVersion,
    ...rankingProfile,
  });
  const rankingPreimage = {
    taskProfile: input.taskProfile,
    asOf: input.asOf,
    modelPolicyHash: currentPolicy.policyHash,
    scoringPolicyDigest,
    evidenceDigest: projection.evidenceDigest,
    candidates: ranked.map(({ endpoint, ...candidate }) => ({
      ...candidate,
      endpointId: endpoint.endpointId,
    })),
    exclusionsDigest,
  };
  return {
    schemaVersion: 1,
    scorerVersion: 1,
    mode: routingMode,
    taskProfile: input.taskProfile,
    asOf: input.asOf,
    modelPolicyHash: currentPolicy.policyHash,
    scoringPolicyDigest,
    evidenceDigest: projection.evidenceDigest,
    rankingDigest: digest("model-ranking", rankingPreimage),
    candidates: ranked.slice(0, limit),
    eligibleCount: ranked.length,
    excluded: excluded.slice(0, MODEL_RANKING_POLICY.maxReturnedExclusions),
    excludedCount: excluded.length,
    exclusionsDigest,
    sourceDates: sourceDates(input.evidence, input.taskProfile),
  };
}

export function ratedAutomaticCandidate(
  options: ModelOptionsView,
): RankedModelOption | undefined {
  if (options.mode !== "rated_auto") return undefined;
  const leader = options.candidates[0];
  const runnerUp = options.candidates[1];
  if (
    !leader ||
    leader.confidencePpm === 0 ||
    runnerUp?.tiedWithPrevious === true
  )
    return undefined;
  return leader;
}

export function createAdvisoryModelReceipt(input: {
  readonly options: ModelOptionsView;
  readonly selectedModel: ModelSelection;
  readonly selectionReason:
    | "explicit_override"
    | "current_default"
    | "rated_auto"
    | "insufficient_evidence";
  readonly selectedEndpoint?: ModelCapacityView;
}): AdvisoryModelReceipt {
  const selectedModel = validateModelSelection(input.selectedModel);
  const selected = input.options.candidates.find(
    (candidate) =>
      selectionKey(candidate.selection) === selectionKey(selectedModel),
  );
  const recommended = input.options.candidates[0];
  if (!recommended || input.options.candidates.length < 1)
    throw new Error("MODEL_SCOPE_EMPTY");
  const selectedEndpoint = selected?.endpoint ?? input.selectedEndpoint;
  if (!selectedEndpoint) throw new Error("MODEL_SELECTED_ENDPOINT_REQUIRED");
  const withoutDigest = {
    schemaVersion: 1 as const,
    scorerVersion: 1 as const,
    mode: input.options.mode,
    taskProfile: input.options.taskProfile,
    asOf: input.options.asOf,
    selectedModel,
    recommendedModel: recommended.selection,
    selectedRank: selected?.rank ?? null,
    selectedEligible: Boolean(selected),
    recommendedMatchesSelection:
      selectionKey(recommended.selection) === selectionKey(selectedModel),
    selectionReason: input.selectionReason,
    modelPolicyHash: input.options.modelPolicyHash,
    scoringPolicyDigest: input.options.scoringPolicyDigest,
    evidenceDigest: input.options.evidenceDigest,
    rankingDigest: input.options.rankingDigest,
    selectedEndpoint,
    alternatives: input.options.candidates.slice(
      0,
      MODEL_RANKING_POLICY.maxReceiptAlternatives,
    ),
    eligibleCount: input.options.eligibleCount,
    excludedCount: input.options.excludedCount,
    exclusionsDigest: input.options.exclusionsDigest,
    sourceDates: input.options.sourceDates,
  };
  return {
    ...withoutDigest,
    receiptDigest: digest("advisory-model-receipt", withoutDigest),
  };
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function validSelection(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  try {
    return (
      exactKeys(selection, ["provider", "modelId", "thinkingLevel"]) &&
      canonicalJson(validateModelSelection(selection)) ===
        canonicalJson(selection)
    );
  } catch {
    return false;
  }
}

function validPpm(value: unknown, allowNegative = false): boolean {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= (allowNegative ? -PPM : 0) &&
    Number(value) <= PPM
  );
}

function validCapacity(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const capacity = value as Record<string, unknown>;
  return (
    exactKeys(capacity, [
      "endpointId",
      "limit",
      "active",
      "queued",
      "available",
    ]) &&
    typeof capacity.endpointId === "string" &&
    /^[a-z][a-z0-9_-]{0,63}$/u.test(capacity.endpointId) &&
    [
      capacity.limit,
      capacity.active,
      capacity.queued,
      capacity.available,
    ].every((item) => Number.isSafeInteger(item) && Number(item) >= 0) &&
    Number(capacity.limit) >= 1 &&
    Number(capacity.available) ===
      Math.max(0, Number(capacity.limit) - Number(capacity.active))
  );
}

function validRankedOption(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const option = value as Record<string, unknown>;
  const components = option.components;
  return (
    exactKeys(option, [
      "selection",
      "endpoint",
      "scorePpm",
      "utilityPpm",
      "uncertaintyPenaltyPpm",
      "confidencePpm",
      "components",
      "evidenceDigest",
      "rank",
      "tiedWithPrevious",
    ]) &&
    validSelection(option.selection) &&
    validCapacity(option.endpoint) &&
    validPpm(option.scorePpm, true) &&
    validPpm(option.utilityPpm) &&
    validPpm(option.uncertaintyPenaltyPpm) &&
    Number(option.uncertaintyPenaltyPpm) <= PPM &&
    validPpm(option.confidencePpm) &&
    Number.isSafeInteger(option.rank) &&
    Number(option.rank) >= 1 &&
    typeof option.tiedWithPrevious === "boolean" &&
    !!components &&
    typeof components === "object" &&
    !Array.isArray(components) &&
    exactKeys(components as Record<string, unknown>, [
      "taskCapability",
      "protocolReliability",
      "speed",
      "effectiveCost",
      "preference",
    ]) &&
    Object.values(components).every((item) => validPpm(item)) &&
    typeof option.evidenceDigest === "string" &&
    DIGEST.test(option.evidenceDigest)
  );
}

function validSourceDate(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  try {
    return (
      exactKeys(source, [
        "sourceKind",
        "sourceName",
        "observedAt",
        "expiresAt",
      ]) &&
      typeof source.sourceKind === "string" &&
      source.sourceKind.length >= 1 &&
      source.sourceKind.length <= 64 &&
      typeof source.sourceName === "string" &&
      source.sourceName.length >= 1 &&
      source.sourceName.length <= 128 &&
      typeof source.observedAt === "string" &&
      new Date(source.observedAt).toISOString() === source.observedAt &&
      typeof source.expiresAt === "string" &&
      new Date(source.expiresAt).toISOString() === source.expiresAt
    );
  } catch {
    return false;
  }
}

export function validateAdvisoryModelReceipt(
  value: unknown,
): AdvisoryModelReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Advisory model receipt is invalid.");
  const receipt = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "scorerVersion",
    "mode",
    "taskProfile",
    "asOf",
    "selectedModel",
    "recommendedModel",
    "selectedRank",
    "selectedEligible",
    "recommendedMatchesSelection",
    "selectionReason",
    "modelPolicyHash",
    "scoringPolicyDigest",
    "evidenceDigest",
    "rankingDigest",
    "selectedEndpoint",
    "alternatives",
    "eligibleCount",
    "excludedCount",
    "exclusionsDigest",
    "sourceDates",
    "receiptDigest",
  ];
  if (
    !exactKeys(receipt, keys) ||
    receipt.schemaVersion !== 1 ||
    receipt.scorerVersion !== 1 ||
    ![
      "current_default",
      "advisory",
      "rated_auto",
      "explicit_required",
    ].includes(String(receipt.mode)) ||
    typeof receipt.taskProfile !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/u.test(receipt.taskProfile) ||
    typeof receipt.asOf !== "string" ||
    new Date(receipt.asOf).toISOString() !== receipt.asOf ||
    (receipt.selectedRank !== null &&
      (!Number.isSafeInteger(receipt.selectedRank) ||
        Number(receipt.selectedRank) < 1)) ||
    typeof receipt.selectedEligible !== "boolean" ||
    receipt.selectedEligible !== (receipt.selectedRank !== null) ||
    typeof receipt.recommendedMatchesSelection !== "boolean" ||
    ![
      "explicit_override",
      "current_default",
      "rated_auto",
      "insufficient_evidence",
    ].includes(String(receipt.selectionReason)) ||
    ![
      receipt.modelPolicyHash,
      receipt.scoringPolicyDigest,
      receipt.evidenceDigest,
      receipt.rankingDigest,
      receipt.exclusionsDigest,
      receipt.receiptDigest,
    ].every((item) => typeof item === "string" && DIGEST.test(item)) ||
    !Number.isSafeInteger(receipt.eligibleCount) ||
    Number(receipt.eligibleCount) < 1 ||
    Number(receipt.eligibleCount) >
      MODEL_RANKING_POLICY.maxEligibleCandidates ||
    !Number.isSafeInteger(receipt.excludedCount) ||
    Number(receipt.excludedCount) < 0 ||
    !validSelection(receipt.selectedModel) ||
    !validSelection(receipt.recommendedModel) ||
    !validCapacity(receipt.selectedEndpoint) ||
    !Array.isArray(receipt.alternatives) ||
    receipt.alternatives.length < 1 ||
    receipt.alternatives.length > MODEL_RANKING_POLICY.maxReceiptAlternatives ||
    !receipt.alternatives.every(validRankedOption) ||
    !Array.isArray(receipt.sourceDates) ||
    receipt.sourceDates.length > MODEL_RANKING_POLICY.maxSourceDates ||
    !receipt.sourceDates.every(validSourceDate)
  )
    throw new Error("Advisory model receipt is invalid.");
  const alternatives = receipt.alternatives as Array<Record<string, unknown>>;
  const selectedRank = receipt.selectedRank as number | null;
  const selectedAlternative =
    selectedRank !== null && selectedRank <= alternatives.length
      ? alternatives[selectedRank - 1]
      : undefined;
  if (
    alternatives.some(
      (option, index) =>
        option.rank !== index + 1 ||
        (index === 0 && option.tiedWithPrevious !== false),
    ) ||
    canonicalJson(receipt.recommendedModel) !==
      canonicalJson(alternatives[0]!.selection) ||
    receipt.recommendedMatchesSelection !==
      (canonicalJson(receipt.recommendedModel) ===
        canonicalJson(receipt.selectedModel)) ||
    (selectedRank !== null && selectedRank > Number(receipt.eligibleCount)) ||
    (selectedAlternative !== undefined &&
      (canonicalJson(selectedAlternative.selection) !==
        canonicalJson(receipt.selectedModel) ||
        canonicalJson(selectedAlternative.endpoint) !==
          canonicalJson(receipt.selectedEndpoint)))
  )
    throw new Error("Advisory model receipt is inconsistent.");
  const withoutDigest = { ...receipt };
  delete withoutDigest.receiptDigest;
  if (digest("advisory-model-receipt", withoutDigest) !== receipt.receiptDigest)
    throw new Error("Advisory model receipt digest is invalid.");
  return receipt as unknown as AdvisoryModelReceipt;
}
