import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonical-json.js";
import { OrchestratorError } from "../shared/errors.js";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type AgentPlacement = "current-workspace" | "new-workspace";
export type ModelProfileId = "manager" | "subagent";

export interface ModelSelection {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel;
}

export interface ScopedModelDefaults {
  readonly global?: ModelSelection;
  readonly roles?: Readonly<Record<string, ModelSelection>>;
  readonly projects?: Readonly<Record<string, ModelSelection>>;
}

export interface ModelPolicyConfig {
  /** Scoped defaults. Explicit task selection has the highest precedence. */
  readonly defaults?: ScopedModelDefaults;
  /** Legacy profile defaults. Kept for rollback compatibility. */
  readonly profiles?: Partial<Record<ModelProfileId, ModelSelection>>;
  readonly allowlist?: readonly ModelSelection[];
  readonly compatibility?: Readonly<Record<string, readonly ModelProfileId[]>>;
}

export interface SpawnPolicyRequest {
  readonly taskProfileId: string;
  readonly placement?: AgentPlacement;
  readonly modelProfileId?: ModelProfileId;
  readonly projectKey?: string;
  readonly model?: ModelSelection;
}

export interface ResolvedSpawnPolicy {
  readonly requested: {
    readonly placement?: AgentPlacement;
    readonly modelProfileId?: ModelProfileId;
    readonly projectKey?: string;
    readonly model?: ModelSelection;
  };
  readonly effective: {
    readonly placement: AgentPlacement;
    readonly modelProfileId: ModelProfileId;
    readonly model: ModelSelection;
  };
  readonly policyHash: string;
}

const DEFAULT_PROFILES: Readonly<Record<ModelProfileId, ModelSelection>> =
  Object.freeze({
    manager: Object.freeze({
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "medium",
    }),
    subagent: Object.freeze({
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      thinkingLevel: "medium",
    }),
  });

export const SHIPPED_TASK_PROFILES = Object.freeze([
  "implementer",
  "planner",
  "reviewer",
  "scout",
  "test-runner",
]);

function bounded(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function validateModelSelection(value: unknown): ModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OrchestratorError(
      "INVALID_REQUEST",
      "Model selection is invalid.",
    );
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["provider", "modelId", "thinkingLevel"].includes(key),
    ) ||
    !bounded(record.provider, 128) ||
    !bounded(record.modelId, 256) ||
    !THINKING_LEVELS.includes(record.thinkingLevel as ThinkingLevel)
  )
    throw new OrchestratorError(
      "INVALID_REQUEST",
      "Model selection is invalid.",
    );
  return {
    provider: record.provider,
    modelId: record.modelId,
    thinkingLevel: record.thinkingLevel as ThinkingLevel,
  };
}

export function sameModelSelection(
  left: ModelSelection,
  right: ModelSelection,
): boolean {
  return (
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    left.thinkingLevel === right.thinkingLevel
  );
}

export function requiredModelSelections(
  config: ModelPolicyConfig = {},
): readonly ModelSelection[] {
  const required: ModelSelection[] = [];
  const add = (selection: ModelSelection): void => {
    const valid = validateModelSelection(selection);
    if (!required.some((candidate) => sameModelSelection(candidate, valid)))
      required.push(valid);
  };
  const defaults = config.defaults;
  const roles = defaults?.roles ?? {};
  const projects = defaults?.projects ?? {};
  for (const key of Object.keys(roles).sort()) add(roles[key]!);
  for (const key of Object.keys(projects).sort()) add(projects[key]!);
  if (defaults?.global) add(defaults.global);
  else {
    add(config.profiles?.manager ?? DEFAULT_PROFILES.manager);
    add(config.profiles?.subagent ?? DEFAULT_PROFILES.subagent);
  }
  return required;
}

export function resolveSpawnPolicy(
  request: SpawnPolicyRequest,
  config: ModelPolicyConfig = {},
): ResolvedSpawnPolicy {
  if (!bounded(request.taskProfileId, 64))
    throw new OrchestratorError(
      "INVALID_REQUEST",
      "Task profile ID is invalid.",
    );
  const placement = request.placement ?? "current-workspace";
  const defaultModelProfileId: ModelProfileId =
    placement === "new-workspace" ? "manager" : "subagent";
  const modelProfileId = request.modelProfileId ?? defaultModelProfileId;
  if (!(["manager", "subagent"] as const).includes(modelProfileId))
    throw new OrchestratorError(
      "INVALID_REQUEST",
      "Model profile ID is invalid.",
    );
  if (
    (placement === "current-workspace" && modelProfileId !== "subagent") ||
    (placement === "new-workspace" && modelProfileId !== "manager")
  )
    throw new OrchestratorError(
      "PERMISSION_DENIED",
      "The model profile is not compatible with the requested placement.",
    );
  const compatible = config.compatibility?.[request.taskProfileId];
  if (compatible && !compatible.includes(modelProfileId))
    throw new OrchestratorError(
      "PERMISSION_DENIED",
      "The task profile is not compatible with the model profile.",
    );
  if (!compatible && !SHIPPED_TASK_PROFILES.includes(request.taskProfileId))
    throw new OrchestratorError(
      "INVALID_REQUEST",
      "The task profile has no model compatibility policy.",
    );
  const scoped = config.defaults;
  const model = validateModelSelection(
    request.model ??
      (request.projectKey
        ? scoped?.projects?.[request.projectKey]
        : undefined) ??
      scoped?.roles?.[request.taskProfileId] ??
      scoped?.global ??
      config.profiles?.[modelProfileId] ??
      DEFAULT_PROFILES[modelProfileId],
  );
  const allowlist = config.allowlist?.map(validateModelSelection);
  if (
    allowlist &&
    !allowlist.some((allowed) => sameModelSelection(allowed, model))
  )
    throw new OrchestratorError(
      "PERMISSION_DENIED",
      "The effective model selection is outside the configured allowlist.",
    );
  const effective = { placement, modelProfileId, model } as const;
  return {
    requested: {
      ...(request.placement ? { placement: request.placement } : {}),
      ...(request.modelProfileId
        ? { modelProfileId: request.modelProfileId }
        : {}),
      ...(request.projectKey ? { projectKey: request.projectKey } : {}),
      ...(request.model
        ? { model: validateModelSelection(request.model) }
        : {}),
    },
    effective,
    policyHash: createHash("sha256")
      .update(canonicalJson({ effective, allowlist, compatible }))
      .digest("hex"),
  };
}

export function modelSelectionMatches(
  expected: ModelSelection,
  actual: { provider?: unknown; modelId?: unknown; thinkingLevel?: unknown },
): boolean {
  return (
    actual.provider === expected.provider &&
    actual.modelId === expected.modelId &&
    actual.thinkingLevel === expected.thinkingLevel
  );
}
