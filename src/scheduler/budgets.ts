export interface EffectiveBudget {
  readonly wallTimeMs: number;
  readonly maxTurns?: number;
  readonly maxContextPercent?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxCostUsd?: number;
  readonly softPercent: number;
  readonly graceMs: number;
}
export interface UsageSnapshot {
  readonly wallTimeMs: number;
  readonly turns?: number;
  readonly contextPercent?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly unavailable: readonly string[];
}
export type BudgetAction = "none" | "warning" | "graceful_stop" | "force_stop";
export interface BudgetAssessment {
  readonly action: BudgetAction;
  readonly breached: readonly string[];
  readonly unavailable: readonly string[];
  readonly percent: number;
}
const metrics: readonly [keyof UsageSnapshot, keyof EffectiveBudget][] = [
  ["wallTimeMs", "wallTimeMs"],
  ["turns", "maxTurns"],
  ["contextPercent", "maxContextPercent"],
  ["inputTokens", "maxInputTokens"],
  ["outputTokens", "maxOutputTokens"],
  ["costUsd", "maxCostUsd"],
];
export function validateBudget(budget: EffectiveBudget): void {
  if (
    !Number.isSafeInteger(budget.wallTimeMs) ||
    budget.wallTimeMs < 10_000 ||
    budget.wallTimeMs > 86_400_000
  )
    throw new RangeError("wallTimeMs is outside the supported range.");
  if (
    budget.softPercent <= 0 ||
    budget.softPercent >= 100 ||
    budget.graceMs < 1_000 ||
    budget.graceMs > 300_000
  )
    throw new RangeError("Budget thresholds are invalid.");
}
export function assessBudget(
  budget: EffectiveBudget,
  usage: UsageSnapshot,
  nowPercent?: number,
): BudgetAssessment {
  validateBudget(budget);
  const breached: string[] = [];
  const unavailable = [...usage.unavailable];
  let maxPercent = nowPercent ?? (usage.wallTimeMs / budget.wallTimeMs) * 100;
  for (const [usageKey, limitKey] of metrics) {
    const limit = budget[limitKey];
    const value = usage[usageKey];
    if (limit === undefined || limit === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      if (!unavailable.includes(String(usageKey)))
        unavailable.push(String(usageKey));
      continue;
    }
    const percent = (value / limit) * 100;
    maxPercent = Math.max(maxPercent, percent);
    if (value >= limit) breached.push(String(limitKey));
  }
  const hard = breached.length > 0;
  const soft = maxPercent >= budget.softPercent;
  return {
    action: hard ? "graceful_stop" : soft ? "warning" : "none",
    breached,
    unavailable,
    percent: maxPercent,
  };
}
export function forceStopAfterGrace(
  assessment: BudgetAssessment,
  graceElapsedMs: number,
  graceMs: number,
): BudgetAction {
  return assessment.action === "graceful_stop" && graceElapsedMs >= graceMs
    ? "force_stop"
    : assessment.action;
}
