import type { ModelPolicyConfig } from "../broker/model-policy.js";
import type { PiCapabilitySnapshot } from "../pi/model-capabilities.js";

export interface SettingsContentOptions {
  capabilities?: PiCapabilitySnapshot | undefined;
  modelPolicy?: ModelPolicyConfig | undefined;
  modelFilter: string;
  autoCloseCompletedTemporary: boolean;
  scroll: number;
  height: number;
}

export function renderSettingsContent(
  options: SettingsContentOptions,
): string[] {
  const defaults = options.modelPolicy?.defaults;
  const lines = [
    "DEFAULTS FOR NEW AGENTS",
    `Global  ${defaults?.global ? `${defaults.global.provider}/${defaults.global.modelId}  ·  ${defaults.global.thinkingLevel}` : "Not set"}`,
    ...Object.entries(defaults?.roles ?? {}).map(
      ([key, model]) =>
        `Role ${key}  ${model.provider}/${model.modelId}  ·  ${model.thinkingLevel}`,
    ),
    ...Object.entries(defaults?.projects ?? {}).map(
      ([key, model]) =>
        `Project ${key}  ${model.provider}/${model.modelId}  ·  ${model.thinkingLevel}`,
    ),
    "",
    "LIFECYCLE",
    `Automatic close after collected temporary work  ${options.autoCloseCompletedTemporary ? "● ON" : "○ OFF"}`,
    "Completed work is collected before safe automatic closure.",
    "",
    "MODEL CATALOG",
    `${options.modelFilter ? `Search: ${options.modelFilter}` : "Press / to search by provider or model"}`,
  ];
  if (!options.capabilities) {
    lines.push("Loading installed Pi capabilities…");
    return lines;
  }
  const filter = options.modelFilter.toLowerCase();
  const filtered = options.capabilities.models.filter(
    (model) =>
      !filter ||
      `${model.provider}/${model.modelId}`.toLowerCase().includes(filter),
  );
  const providerCounts = new Map<string, number>();
  for (const model of filtered)
    providerCounts.set(
      model.provider,
      (providerCounts.get(model.provider) ?? 0) + 1,
    );
  lines.push(`${filtered.length} models from ${providerCounts.size} providers`);
  if (!options.modelFilter) {
    for (const [provider, count] of [...providerCounts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8))
      lines.push(`  ${provider}  ${count} models`);
    lines.push(
      "",
      "Search to choose an exact model. The full catalog stays out of the main view.",
    );
  } else {
    const pageSize = Math.max(3, options.height - lines.length - 4);
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(Math.floor(options.scroll / pageSize), pages - 1);
    const start = page * pageSize;
    for (const model of filtered.slice(start, start + pageSize))
      lines.push(
        `  ${model.provider}/${model.modelId}  ·  ${model.thinkingLevels.join(" ")}`,
      );
    lines.push(
      `Page ${page + 1}/${pages}  ·  ↑↓ browse  ·  d set scoped default`,
    );
  }
  return lines;
}
