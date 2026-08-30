import {
  Container,
  SettingsList,
  Text,
  type Component,
  type SettingItem,
  type SettingsListTheme,
} from "@pi-herdr-deck/tui";
import {
  SHIPPED_TASK_PROFILES,
  THINKING_LEVELS,
  requiredModelSelections,
  type ModelPolicyConfig,
  type ModelSelection,
  type ThinkingLevel,
} from "../broker/model-policy.js";
import type {
  EndpointLimit,
  EndpointMapping,
  ModelIntelligenceConfig,
  ModelRankingProfileConfig,
  ModelRoutingMode,
} from "../broker/endpoint-policy.js";
import { modelRankingProfile } from "../model-intelligence/model-ranking.js";
import type {
  PiCapabilitySnapshot,
  PiModelCapability,
} from "./model-capabilities.js";
import type { PiContextLike, PiModelLike } from "./types.js";

const MAX_ALLOWLIST_ENTRIES = 64;
const MODE_ID = "scope-mode";
const ROUTING_ID = "routing-mode";
const SAVE_ID = "save-policy";
const ENDPOINTS_ID = "endpoint-capacity";
const MAPPINGS_ID = "endpoint-mappings";
const PROFILES_ID = "ranking-profiles";
const FOUNDATION_ID = "foundation-refresh";

export interface AgentSettingsClient {
  readonly connected: boolean;
  request(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

interface OperatorSettings {
  readonly endpoints: Readonly<Record<string, EndpointLimit>>;
  readonly modelIntelligence: ModelIntelligenceConfig;
  readonly foundationStatus?: Readonly<Record<string, unknown>>;
}

interface PolicyResponse {
  readonly policy: ModelPolicyConfig;
  readonly operatorSettings: OperatorSettings;
}

interface CatalogModel extends PiModelCapability {
  readonly inCurrentScope: boolean;
}

interface SettingsResult {
  readonly allowlist: readonly ModelSelection[] | null;
  readonly endpoints: Readonly<Record<string, EndpointLimit>> | null;
  readonly modelIntelligence: ModelIntelligenceConfig;
  readonly refreshFoundation: boolean;
}

interface AgentSettingsTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface AgentSettingsUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (
      tui: unknown,
      theme: AgentSettingsTheme,
      keybindings: unknown,
      done: (result: T) => void,
    ) => Component | Promise<Component>,
  ): Promise<T>;
}

function settingsTheme(theme: AgentSettingsTheme): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) => theme.fg(selected ? "accent" : "muted", text),
    description: (text) => theme.fg("muted", text),
    cursor: theme.fg("accent", "> "),
    hint: (text) => theme.fg("dim", text),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`;
}

function selectionKey(selection: ModelSelection): string {
  return `${modelKey(selection.provider, selection.modelId)}\u0000${selection.thinkingLevel}`;
}

function modelFromScoped(
  value: PiModelLike | { model: PiModelLike; thinkingLevel?: string },
): PiModelLike {
  const nested = (value as { model?: unknown }).model;
  return isRecord(nested) &&
    typeof nested.provider === "string" &&
    typeof nested.id === "string"
    ? (nested as unknown as PiModelLike)
    : (value as PiModelLike);
}

function currentPiModels(context: PiContextLike): readonly PiModelLike[] {
  const scoped = context.scopedModels?.map(modelFromScoped) ?? [];
  if (scoped.length > 0) return scoped;
  return context.modelRegistry.getAvailable?.() ?? [];
}

function parseCapabilities(value: unknown): PiCapabilitySnapshot {
  if (!isRecord(value) || !Array.isArray(value.models))
    throw new Error("The broker returned an invalid model catalog.");
  const models: PiModelCapability[] = value.models.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.provider !== "string" ||
      typeof candidate.modelId !== "string" ||
      typeof candidate.reasoning !== "boolean" ||
      !Array.isArray(candidate.thinkingLevels) ||
      candidate.thinkingLevels.length < 1 ||
      candidate.thinkingLevels.some(
        (level) => !THINKING_LEVELS.includes(level as ThinkingLevel),
      )
    )
      throw new Error("The broker returned an invalid model catalog.");
    return {
      provider: candidate.provider,
      modelId: candidate.modelId,
      reasoning: candidate.reasoning,
      thinkingLevels: candidate.thinkingLevels as ThinkingLevel[],
    };
  });
  return {
    models,
    thinkingLevels: THINKING_LEVELS.filter((level) =>
      models.some((model) => model.thinkingLevels.includes(level)),
    ),
  };
}

function parsePolicy(value: unknown): PolicyResponse {
  if (!isRecord(value) || !isRecord(value.policy))
    throw new Error("The broker returned an invalid model policy.");
  const rawSettings = isRecord(value.operatorSettings)
    ? value.operatorSettings
    : {};
  const endpoints = isRecord(rawSettings.endpoints)
    ? (rawSettings.endpoints as unknown as Record<string, EndpointLimit>)
    : {};
  const modelIntelligence = isRecord(rawSettings.modelIntelligence)
    ? (rawSettings.modelIntelligence as unknown as ModelIntelligenceConfig)
    : ({
        schemaVersion: 1,
        routingMode: "current_default",
        mappings: [],
      } as const);
  return {
    policy: value.policy as unknown as ModelPolicyConfig,
    operatorSettings: {
      endpoints,
      modelIntelligence,
      ...(isRecord(rawSettings.foundationStatus)
        ? { foundationStatus: rawSettings.foundationStatus }
        : {}),
    },
  };
}

function buildCatalog(
  capabilities: PiCapabilitySnapshot,
  context: PiContextLike,
  policy: ModelPolicyConfig,
): readonly CatalogModel[] {
  const current = new Set(
    currentPiModels(context).map((model) => modelKey(model.provider, model.id)),
  );
  const retained = new Set(
    [...(policy.allowlist ?? []), ...requiredModelSelections(policy)].map(
      (selection) => modelKey(selection.provider, selection.modelId),
    ),
  );
  return capabilities.models
    .filter((model) => {
      const key = modelKey(model.provider, model.modelId);
      return current.has(key) || retained.has(key);
    })
    .map((model) => ({
      ...model,
      inCurrentScope: current.has(modelKey(model.provider, model.modelId)),
    }))
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.modelId.localeCompare(right.modelId),
    );
}

function selectedByModel(
  selections: readonly ModelSelection[],
): Map<string, Set<ThinkingLevel>> {
  const selected = new Map<string, Set<ThinkingLevel>>();
  for (const selection of selections) {
    const key = modelKey(selection.provider, selection.modelId);
    const levels = selected.get(key) ?? new Set<ThinkingLevel>();
    levels.add(selection.thinkingLevel);
    selected.set(key, levels);
  }
  return selected;
}

function selectionCount(
  selected: ReadonlyMap<string, Set<ThinkingLevel>>,
): number {
  let count = 0;
  for (const levels of selected.values()) count += levels.size;
  return count;
}

function summarizeLevels(
  model: PiModelCapability,
  levels: ReadonlySet<ThinkingLevel> | undefined,
): string {
  const ordered = model.thinkingLevels.filter((level) => levels?.has(level));
  return ordered.length > 0 ? ordered.join(", ") : "not allowed";
}

function flattenSelections(
  catalog: readonly PiModelCapability[],
  selected: ReadonlyMap<string, Set<ThinkingLevel>>,
): readonly ModelSelection[] {
  const selections: ModelSelection[] = [];
  for (const model of catalog)
    for (const thinkingLevel of model.thinkingLevels)
      if (
        selected
          .get(modelKey(model.provider, model.modelId))
          ?.has(thinkingLevel)
      )
        selections.push({
          provider: model.provider,
          modelId: model.modelId,
          thinkingLevel,
        });
  return selections;
}

function addRequiredSelections(
  selected: Map<string, Set<ThinkingLevel>>,
  required: readonly ModelSelection[],
): void {
  for (const selection of required) {
    const key = modelKey(selection.provider, selection.modelId);
    const levels = selected.get(key) ?? new Set<ThinkingLevel>();
    levels.add(selection.thinkingLevel);
    selected.set(key, levels);
  }
}

function createLevelSubmenu(
  model: CatalogModel,
  selected: Map<string, Set<ThinkingLevel>>,
  requiredKeys: ReadonlySet<string>,
  routingMode: ModelRoutingMode,
  ui: AgentSettingsUi,
  listTheme: SettingsListTheme,
  done: (selectedValue?: string) => void,
): Component {
  const key = modelKey(model.provider, model.modelId);
  const original = selected.get(key) ?? new Set<ThinkingLevel>();
  const draft = new Set(original);
  const items: SettingItem[] = [
    ...model.thinkingLevels.map((level) => {
      const required = requiredKeys.has(
        selectionKey({
          provider: model.provider,
          modelId: model.modelId,
          thinkingLevel: level,
        }),
      );
      return {
        id: level,
        label: level,
        currentValue: draft.has(level) ? "allowed" : "not allowed",
        ...(required ? {} : { values: ["allowed", "not allowed"] }),
        ...(required
          ? {
              description:
                routingMode === "explicit_required"
                  ? "An effective default requires this level for non-direct creation. Direct agent_spawn calls must still select a model."
                  : "This level is required by an effective default.",
            }
          : {}),
      };
    }),
    {
      id: SAVE_ID,
      label: "Apply model levels",
      currentValue: "apply",
      values: ["apply"],
    },
  ];
  return new SettingsList(
    items,
    Math.min(items.length + 2, 12),
    listTheme,
    (id, value) => {
      if (id !== SAVE_ID) {
        const level = id as ThinkingLevel;
        if (value === "allowed") draft.add(level);
        else draft.delete(level);
        return;
      }
      const nextCount = selectionCount(selected) - original.size + draft.size;
      if (nextCount > MAX_ALLOWLIST_ENTRIES) {
        ui.notify(
          `A restricted model scope can contain at most ${MAX_ALLOWLIST_ENTRIES} model-level pairs.`,
          "warning",
        );
        return;
      }
      if (draft.size > 0) selected.set(key, new Set(draft));
      else selected.delete(key);
      done(summarizeLevels(model, draft));
    },
    () => done(undefined),
  );
}

function createEndpointSubmenu(
  endpoints: Record<string, EndpointLimit>,
  listTheme: SettingsListTheme,
  done: (selectedValue?: string) => void,
): Component {
  const entries = Object.keys(endpoints).sort();
  const items: SettingItem[] = [
    ...(entries.length > 0
      ? entries.map((endpointId) => ({
          id: endpointId,
          label: endpointId,
          currentValue: String(endpoints[endpointId]!.maxConcurrentAgents),
          values: [
            ...new Set([
              endpoints[endpointId]!.maxConcurrentAgents,
              ...Array.from({ length: 32 }, (_, index) => index + 1),
            ]),
          ]
            .sort((left, right) => left - right)
            .map(String),
          description:
            "Lowering a limit blocks new admission. It does not stop active agents.",
        }))
      : [
          {
            id: "none",
            label: "Configured endpoints",
            currentValue: "none",
            values: ["none"],
            description:
              "Add endpoint IDs in the owner config before assigning model mappings.",
          },
        ]),
    {
      id: SAVE_ID,
      label: "Apply endpoint limits",
      currentValue: "apply",
      values: ["apply"],
    },
  ];
  return new SettingsList(
    items,
    Math.min(items.length + 2, 12),
    listTheme,
    (id, value) => {
      if (id === SAVE_ID) {
        done(`${String(Object.keys(endpoints).length)} configured`);
        return;
      }
      if (id !== "none")
        endpoints[id] = {
          ...endpoints[id],
          maxConcurrentAgents: Number(value),
        };
    },
    () => done(undefined),
  );
}

function createMappingSubmenu(
  catalog: readonly CatalogModel[],
  endpoints: Readonly<Record<string, EndpointLimit>>,
  mappings: EndpointMapping[],
  listTheme: SettingsListTheme,
  done: (selectedValue?: string) => void,
): Component {
  const endpointIds = Object.keys(endpoints).sort();
  const values = ["derived", ...endpointIds];
  const items: SettingItem[] = [
    ...catalog.map((model, index) => ({
      id: `mapping-${index}`,
      label: `${model.provider}/${model.modelId}`,
      currentValue:
        mappings.find(
          (mapping) =>
            mapping.provider === model.provider &&
            mapping.modelId === model.modelId,
        )?.endpointId ?? "derived",
      values,
      description:
        "An exact model mapping overrides a provider mapping. Derived uses the provider fallback.",
    })),
    {
      id: SAVE_ID,
      label: "Apply endpoint mappings",
      currentValue: "apply",
      values: ["apply"],
    },
  ];
  return new SettingsList(
    items,
    Math.min(items.length + 2, 12),
    listTheme,
    (id, value) => {
      if (id === SAVE_ID) {
        done(`${String(mappings.length)} configured`);
        return;
      }
      const index = Number(id.slice("mapping-".length));
      const model = catalog[index];
      if (!model) return;
      const existing = mappings.findIndex(
        (mapping) =>
          mapping.provider === model.provider &&
          mapping.modelId === model.modelId,
      );
      const prior = existing >= 0 ? mappings[existing] : undefined;
      if (existing >= 0) mappings.splice(existing, 1);
      if (value !== "derived")
        mappings.push({
          provider: model.provider,
          modelId: model.modelId,
          endpointId: value,
          ...(prior?.canonicalModelId
            ? { canonicalModelId: prior.canonicalModelId }
            : {}),
          ...(prior?.quantization ? { quantization: prior.quantization } : {}),
        });
    },
    () => done(undefined),
  );
}

function ppmValues(current: number): string[] {
  return [
    ...new Set([
      current,
      ...Array.from({ length: 21 }, (_, index) => index * 50_000),
    ]),
  ]
    .sort((left, right) => left - right)
    .map(String);
}

function profileSummary(profile: ModelRankingProfileConfig): string {
  const weights = profile.weightsPpm;
  return `${weights.taskCapability / 10_000}/${weights.protocolReliability / 10_000}/${weights.speed / 10_000}/${weights.effectiveCost / 10_000}/${weights.humanPreference / 10_000}%`;
}

function createProfileSubmenu(
  profileId: string,
  profile: ModelRankingProfileConfig,
  profiles: Record<string, ModelRankingProfileConfig>,
  ui: AgentSettingsUi,
  listTheme: SettingsListTheme,
  done: (selectedValue?: string) => void,
): Component {
  const draft = structuredClone(profile);
  const mutableDraft = draft as unknown as {
    weightsPpm: Record<string, number>;
    uncertaintyPenaltyPpm: number;
    tieBandPpm: number;
  };
  const fields = [
    ["taskCapability", "Task capability"],
    ["protocolReliability", "Protocol reliability"],
    ["speed", "Endpoint speed"],
    ["effectiveCost", "Effective cost"],
    ["humanPreference", "Human preference"],
  ] as const;
  const items: SettingItem[] = [
    ...fields.map(([key, label]) => ({
      id: key,
      label,
      currentValue: String(draft.weightsPpm[key]),
      values: ppmValues(draft.weightsPpm[key]),
    })),
    {
      id: "uncertaintyPenaltyPpm",
      label: "Uncertainty penalty",
      currentValue: String(draft.uncertaintyPenaltyPpm),
      values: ppmValues(draft.uncertaintyPenaltyPpm),
    },
    {
      id: "tieBandPpm",
      label: "Tie band",
      currentValue: String(draft.tieBandPpm),
      values: ppmValues(draft.tieBandPpm),
    },
    {
      id: SAVE_ID,
      label: `Apply ${profileId} scoring`,
      currentValue: "apply",
      values: ["apply"],
    },
  ];
  return new SettingsList(
    items,
    Math.min(items.length + 2, 12),
    listTheme,
    (id, value) => {
      if (id === SAVE_ID) {
        const total = Object.values(draft.weightsPpm).reduce(
          (sum, item) => sum + item,
          0,
        );
        if (total !== 1_000_000) {
          ui.notify("Profile weights must total 1000000 PPM.", "warning");
          return;
        }
        profiles[profileId] = draft;
        done(profileSummary(draft));
        return;
      }
      if (id === "uncertaintyPenaltyPpm" || id === "tieBandPpm")
        mutableDraft[id] = Number(value);
      else mutableDraft.weightsPpm[id] = Number(value);
    },
    () => done(undefined),
  );
}

function createProfilesSubmenu(
  profiles: Record<string, ModelRankingProfileConfig>,
  ui: AgentSettingsUi,
  listTheme: SettingsListTheme,
  done: (selectedValue?: string) => void,
): Component {
  const profileIds = Object.keys(profiles).sort();
  const items: SettingItem[] = [
    ...profileIds.map((profileId) => ({
      id: profileId,
      label: profileId,
      currentValue: profileSummary(profiles[profileId]!),
      description:
        "Order: capability, protocol, speed, cost, human preference.",
      submenu: (
        _currentValue: string,
        close: (selectedValue?: string) => void,
      ) =>
        createProfileSubmenu(
          profileId,
          profiles[profileId]!,
          profiles,
          ui,
          listTheme,
          close,
        ),
    })),
    {
      id: SAVE_ID,
      label: "Apply scoring profiles",
      currentValue: "apply",
      values: ["apply"],
    },
  ];
  return new SettingsList(
    items,
    Math.min(items.length + 2, 12),
    listTheme,
    (id) => {
      if (id === SAVE_ID) done(`${String(profileIds.length)} profiles`);
    },
    () => done(undefined),
  );
}

async function editPolicy(
  context: PiContextLike,
  catalog: readonly CatalogModel[],
  policy: ModelPolicyConfig,
  operatorSettings: OperatorSettings,
): Promise<SettingsResult | undefined> {
  if (!("custom" in context.ui) || typeof context.ui.custom !== "function") {
    context.ui.notify?.(
      "Agent settings require Pi's interactive UI.",
      "warning",
    );
    return undefined;
  }
  const ui = context.ui as unknown as AgentSettingsUi;
  const required = requiredModelSelections(policy);
  const requiredKeys = new Set(required.map(selectionKey));
  let mode = policy.allowlist ? "restricted" : "unrestricted";
  let routingMode: ModelRoutingMode =
    operatorSettings.modelIntelligence.routingMode ?? "current_default";
  const selected = selectedByModel(
    policy.allowlist ?? (routingMode === "explicit_required" ? [] : required),
  );
  if (routingMode !== "explicit_required")
    addRequiredSelections(selected, required);
  const endpoints = structuredClone(operatorSettings.endpoints) as Record<
    string,
    EndpointLimit
  >;
  const mappings = structuredClone(
    operatorSettings.modelIntelligence.mappings,
  ) as EndpointMapping[];
  const configuredProfileIds = Object.keys(
    operatorSettings.modelIntelligence.profiles ?? {},
  );
  const profileIds = [
    ...new Set([...SHIPPED_TASK_PROFILES, ...configuredProfileIds]),
  ];
  const profiles = Object.fromEntries(
    profileIds.map((profileId) => [
      profileId,
      structuredClone(
        modelRankingProfile(operatorSettings.modelIntelligence, profileId),
      ),
    ]),
  ) as Record<string, ModelRankingProfileConfig>;
  let refreshFoundation = false;
  const foundationState = String(
    operatorSettings.foundationStatus?.state ?? "disabled",
  );
  const foundationObservedAt =
    operatorSettings.foundationStatus?.lastGoodObservedAt;
  const foundationSummary =
    typeof foundationObservedAt === "string"
      ? `${foundationState} · ${foundationObservedAt}`
      : foundationState;

  return await ui.custom<SettingsResult | undefined>(
    (_tui, theme, _kb, done) => {
      const listTheme = settingsTheme(theme);
      const container = new Container();
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Agent settings")), 1, 1),
      );
      const items: SettingItem[] = [
        {
          id: ROUTING_ID,
          label: "Model routing",
          currentValue: routingMode,
          values: [
            "current_default",
            "advisory",
            "rated_auto",
            "explicit_required",
          ],
          description:
            "explicit_required rejects a direct agent_spawn without a model. rated_auto selects only with sufficient evidence.",
        },
        {
          id: MODE_ID,
          label: "Scope mode",
          currentValue: mode,
          values: ["unrestricted", "restricted"],
          description:
            "Restricted mode permits only the selected model and thinking-level pairs.",
        },
        {
          id: ENDPOINTS_ID,
          label: "Endpoint capacity",
          currentValue: `${String(Object.keys(endpoints).length)} configured`,
          description: "Edit hard concurrent-agent limits for known endpoints.",
          submenu: (
            _currentValue: string,
            close: (selectedValue?: string) => void,
          ) => createEndpointSubmenu(endpoints, listTheme, close),
        },
        {
          id: MAPPINGS_ID,
          label: "Model endpoint mappings",
          currentValue: `${String(mappings.length)} configured`,
          description: "Map scoped exact models to configured endpoints.",
          submenu: (
            _currentValue: string,
            close: (selectedValue?: string) => void,
          ) =>
            createMappingSubmenu(
              catalog,
              endpoints,
              mappings,
              listTheme,
              close,
            ),
        },
        {
          id: PROFILES_ID,
          label: "Task-profile scoring",
          currentValue: `${String(Object.keys(profiles).length)} profiles`,
          description:
            "Edit capability, reliability, speed, cost, preference, uncertainty, and tie weights.",
          submenu: (
            _currentValue: string,
            close: (selectedValue?: string) => void,
          ) => createProfilesSubmenu(profiles, ui, listTheme, close),
        },
        {
          id: FOUNDATION_ID,
          label: "Foundation source",
          currentValue: foundationSummary,
          values: [foundationSummary, "refresh"],
          description:
            "Source status is read-only here. Select refresh to request one bounded update.",
        },
        ...catalog.map((model, index) => ({
          id: `model-${index}`,
          label: `${model.provider}/${model.modelId}`,
          currentValue: summarizeLevels(
            model,
            selected.get(modelKey(model.provider, model.modelId)),
          ),
          description: model.inCurrentScope
            ? "Select the thinking levels that agent creators may use."
            : "This configured model is outside the current Pi model scope.",
          submenu: (
            _currentValue: string,
            close: (selectedValue?: string) => void,
          ) =>
            createLevelSubmenu(
              model,
              selected,
              routingMode === "explicit_required" ? new Set() : requiredKeys,
              routingMode,
              ui,
              listTheme,
              close,
            ),
        })),
        {
          id: SAVE_ID,
          label: "Save agent settings",
          currentValue: "save",
          values: ["save"],
        },
      ];
      let settingsList: SettingsList;
      settingsList = new SettingsList(
        items,
        15,
        listTheme,
        (id, value) => {
          if (id === ROUTING_ID) {
            routingMode = value as ModelRoutingMode;
            if (routingMode !== "explicit_required")
              addRequiredSelections(selected, required);
            return;
          }
          if (id === FOUNDATION_ID) {
            refreshFoundation = value === "refresh";
            return;
          }
          if (id === MODE_ID) {
            mode = value;
            if (mode === "restricted" && routingMode !== "explicit_required")
              addRequiredSelections(selected, required);
            return;
          }
          if (id.startsWith("model-")) {
            mode = "restricted";
            settingsList.updateValue(MODE_ID, mode);
            return;
          }
          if (id !== SAVE_ID) return;
          const allowlist =
            mode === "unrestricted"
              ? null
              : flattenSelections(catalog, selected);
          if (allowlist !== null && allowlist.length < 1) {
            ui.notify(
              "Select at least one model and thinking level.",
              "warning",
            );
            return;
          }
          const sortedMappings = [...mappings].sort(
            (left, right) =>
              left.provider.localeCompare(right.provider) ||
              (left.modelId ?? "").localeCompare(right.modelId ?? ""),
          );
          done({
            allowlist,
            endpoints: Object.keys(endpoints).length > 0 ? endpoints : null,
            modelIntelligence: {
              schemaVersion: 1,
              routingMode,
              mappings: sortedMappings,
              profiles,
              ...(operatorSettings.modelIntelligence.sources
                ? { sources: operatorSettings.modelIntelligence.sources }
                : {}),
            },
            refreshFoundation,
          });
        },
        () => done(undefined),
        { enableSearch: true },
      );
      container.addChild(settingsList);
      return {
        render: (width) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data) => settingsList.handleInput(data),
      };
    },
  );
}

export async function openAgentSettings(
  client: AgentSettingsClient | undefined,
  context: PiContextLike,
): Promise<void> {
  if (!client?.connected) {
    context.ui.notify?.("Pi Herd Orchestrator is disconnected.", "warning");
    return;
  }
  try {
    const [capabilityValue, policyValue] = await Promise.all([
      client.request("model.capabilities", {}),
      client.request("model.policy.get", {}),
    ]);
    const capabilities = parseCapabilities(capabilityValue);
    const { policy, operatorSettings } = parsePolicy(policyValue);
    const catalog = buildCatalog(capabilities, context, policy);
    if (catalog.length < 1) {
      context.ui.notify?.(
        "No broker-attested model is in the current Pi model scope.",
        "warning",
      );
      return;
    }
    const result = await editPolicy(context, catalog, policy, operatorSettings);
    if (!result) return;
    const response = await client.request("model.operator.settings.set", {
      allowlist: result.allowlist,
      endpoints: result.endpoints,
      modelIntelligence: result.modelIntelligence,
    });
    const persisted = isRecord(response) && response.persisted === true;
    context.ui.notify?.(
      persisted
        ? "Agent settings were saved for new agents."
        : "Agent settings were not persisted.",
      persisted ? "info" : "warning",
    );
    if (result.refreshFoundation) {
      try {
        const refresh = await client.request("model.foundation.refresh", {});
        const started = isRecord(refresh) && refresh.started === true;
        context.ui.notify?.(
          started
            ? "Foundation refresh was scheduled."
            : "Foundation refresh is not enabled.",
          started ? "info" : "warning",
        );
      } catch (error) {
        context.ui.notify?.(
          `Agent settings were saved, but foundation refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }
  } catch (error) {
    context.ui.notify?.(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  }
}
