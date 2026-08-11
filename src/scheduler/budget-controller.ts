import {
  assessBudget,
  forceStopAfterGrace,
  type BudgetAction,
  type BudgetAssessment,
  type EffectiveBudget,
  type UsageSnapshot,
} from "./budgets.js";

export type BudgetTerminalOutcome =
  "succeeded" | "failed" | "cancelled" | "timed_out";

export interface BudgetControllerSnapshot {
  readonly assessment: BudgetAssessment;
  readonly action: BudgetAction;
  readonly warning: boolean;
  readonly graceStartedAtMs?: number;
  readonly graceExpiresAtMs?: number;
}

export interface BudgetControllerState {
  readonly warningSent: boolean;
  readonly gracefulStopRequested: boolean;
  readonly graceStartedAtMs?: number;
}

export function graceExpired(
  graceStartedAtMs: number | undefined,
  nowMs: number,
  graceMs: number,
): boolean {
  return graceStartedAtMs !== undefined && nowMs - graceStartedAtMs >= graceMs;
}

export function selectTerminalOutcome(
  action: BudgetAction,
  currentOutcome: BudgetTerminalOutcome | undefined,
): BudgetTerminalOutcome | undefined {
  if (currentOutcome !== undefined) return currentOutcome;
  return action === "force_stop" ? "timed_out" : undefined;
}

export class BudgetController {
  private readonly budget: EffectiveBudget;
  private state: BudgetControllerState = {
    warningSent: false,
    gracefulStopRequested: false,
  };

  public constructor(budget: EffectiveBudget) {
    this.budget = budget;
  }

  public evaluate(
    usage: UsageSnapshot,
    nowMs: number,
    nowPercent?: number,
  ): BudgetControllerSnapshot {
    if (!Number.isFinite(nowMs)) throw new RangeError("nowMs must be finite.");
    const assessment = assessBudget(this.budget, usage, nowPercent);
    const warning = assessment.action === "warning" && !this.state.warningSent;
    let graceStartedAtMs = this.state.graceStartedAtMs;
    let gracefulStopRequested = this.state.gracefulStopRequested;
    if (assessment.action === "graceful_stop") {
      gracefulStopRequested = true;
      graceStartedAtMs ??= nowMs;
    }
    this.state = {
      warningSent: this.state.warningSent || assessment.action === "warning",
      gracefulStopRequested,
      ...(graceStartedAtMs === undefined ? {} : { graceStartedAtMs }),
    };
    const graceElapsedMs =
      graceStartedAtMs === undefined
        ? 0
        : Math.max(0, nowMs - graceStartedAtMs);
    const action = forceStopAfterGrace(
      assessment,
      graceElapsedMs,
      this.budget.graceMs,
    );
    const snapshot: BudgetControllerSnapshot = {
      assessment,
      action,
      warning,
      ...(graceStartedAtMs === undefined
        ? {}
        : {
            graceStartedAtMs,
            graceExpiresAtMs: graceStartedAtMs + this.budget.graceMs,
          }),
    };
    return snapshot;
  }

  public markWarningSent(): void {
    this.state = { ...this.state, warningSent: true };
  }

  public terminalOutcome(
    currentOutcome: BudgetTerminalOutcome | undefined,
    snapshot: BudgetControllerSnapshot,
  ): BudgetTerminalOutcome | undefined {
    return selectTerminalOutcome(snapshot.action, currentOutcome);
  }

  public getState(): BudgetControllerState {
    return this.state;
  }
}
