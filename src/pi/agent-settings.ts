import {
  Container,
  SettingsList,
  Text,
  type Component,
  type SettingItem,
  type SettingsListTheme,
} from "@pi-herdr-deck/tui";
import {
  THINKING_LEVELS,
  requiredModelSelections,
  type ModelPolicyConfig,
  type ModelSelection,
  type ThinkingLevel,
} from "../broker/model-policy.js";
import type {
  PiCapabilitySnapshot,
  PiModelCapability,
} from "./model-capabilities.js";
import type { PiContextLike, PiModelLike } from "./types.js";

const MAX_ALLOWLIST_ENTRIES = 64;
const MODE_ID = "scope-mode";
const SAVE_ID = "save-policy";

export interface AgentSettingsClient {
  readonly connected: boolean;
  request(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

interface PolicyResponse {
  readonly policy: ModelPolicyConfig;
}

interface CatalogModel extends PiModelCapability {
  readonly inCurrentScope: boolean;
}

interface SettingsResult {
  readonly allowlist: readonly ModelSelection[] | null;
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
  return { policy: value.policy as unknown as ModelPolicyConfig };
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
          ? { description: "This level is required by an effective default." }
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

async function editPolicy(
  context: PiContextLike,
  catalog: readonly CatalogModel[],
  policy: ModelPolicyConfig,
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
  const selected = selectedByModel(policy.allowlist ?? required);
  addRequiredSelections(selected, required);
  let mode = policy.allowlist ? "restricted" : "unrestricted";

  return await ui.custom<SettingsResult | undefined>(
    (_tui, theme, _kb, done) => {
      const listTheme = settingsTheme(theme);
      const container = new Container();
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Agent model scope")), 1, 1),
      );
      const items: SettingItem[] = [
        {
          id: MODE_ID,
          label: "Scope mode",
          currentValue: mode,
          values: ["unrestricted", "restricted"],
          description:
            "Restricted mode permits only the selected model and thinking-level pairs.",
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
              requiredKeys,
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
          if (id === MODE_ID) {
            mode = value;
            if (mode === "restricted")
              addRequiredSelections(selected, required);
            return;
          }
          if (id.startsWith("model-")) {
            mode = "restricted";
            settingsList.updateValue(MODE_ID, mode);
            return;
          }
          if (id !== SAVE_ID) return;
          if (mode === "unrestricted") {
            done({ allowlist: null });
            return;
          }
          const allowlist = flattenSelections(catalog, selected);
          if (allowlist.length < 1) {
            ui.notify(
              "Select at least one model and thinking level.",
              "warning",
            );
            return;
          }
          done({ allowlist });
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
    const { policy } = parsePolicy(policyValue);
    const catalog = buildCatalog(capabilities, context, policy);
    if (catalog.length < 1) {
      context.ui.notify?.(
        "No broker-attested model is in the current Pi model scope.",
        "warning",
      );
      return;
    }
    const result = await editPolicy(context, catalog, policy);
    if (!result) return;
    const response = await client.request("model.policy.allowlist.set", {
      allowlist: result.allowlist,
    });
    const persisted = isRecord(response) && response.persisted === true;
    context.ui.notify?.(
      persisted
        ? "Agent model settings were saved for new agents."
        : "Agent model settings changed for this broker run but were not persisted.",
      persisted ? "info" : "warning",
    );
  } catch (error) {
    context.ui.notify?.(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  }
}
