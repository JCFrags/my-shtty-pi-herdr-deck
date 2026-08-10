import type { PlannedStep, WorkflowPlan } from "./workflows.js";

export type WorkflowExecutionState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "timed_out";

export interface WorkflowExecution {
  readonly state: WorkflowExecutionState;
  readonly result?: unknown;
}

export type WorkflowExecutionStates = ReadonlyMap<string, WorkflowExecution>;

export interface WorkflowReadiness {
  readonly ready: readonly PlannedStep[];
  readonly waiting: readonly PlannedStep[];
  readonly blocked: readonly PlannedStep[];
}

export interface WorkflowFanIn {
  readonly state:
    "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
  readonly tasks: readonly WorkflowTaskView[];
}

export interface WorkflowTaskView extends WorkflowExecution {
  readonly key: string;
  readonly taskId: string;
}

const terminalStates = new Set<WorkflowExecutionState>([
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "timed_out",
]);
const unsuccessfulDependencyStates = new Set<WorkflowExecutionState>([
  "failed",
  "blocked",
  "cancelled",
  "timed_out",
]);

function executionFor(
  states: WorkflowExecutionStates,
  key: string,
): WorkflowExecution {
  return states.get(key) ?? { state: "queued" };
}

function isTerminal(state: WorkflowExecutionState): boolean {
  return terminalStates.has(state);
}

/** Return the next steps that can be admitted without mutating the plan or state. */
export function workflowReadiness(
  plan: WorkflowPlan,
  states: WorkflowExecutionStates,
): WorkflowReadiness {
  const ready: PlannedStep[] = [];
  const waiting: PlannedStep[] = [];
  const blocked: PlannedStep[] = [];
  for (const step of plan.steps) {
    const current = executionFor(states, step.key);
    if (current.state !== "queued") continue;
    const dependencies = step.dependsOn.map((key) => executionFor(states, key));
    if (
      dependencies.some((dependency) =>
        unsuccessfulDependencyStates.has(dependency.state),
      )
    ) {
      blocked.push(step);
    } else if (
      dependencies.every((dependency) => dependency.state === "succeeded")
    ) {
      ready.push(step);
    } else {
      waiting.push(step);
    }
  }
  return { ready, waiting, blocked };
}

/** Short form for callers that only need the deterministic admission order. */
export function readyWorkflowSteps(
  plan: WorkflowPlan,
  states: WorkflowExecutionStates,
): readonly PlannedStep[] {
  return workflowReadiness(plan, states).ready;
}

/**
 * Apply a state update while preserving cancellation dominance. A late success or
 * failure event cannot resurrect a cancelled step.
 */
export function applyWorkflowState(
  current: WorkflowExecution,
  next: WorkflowExecution,
): WorkflowExecution {
  if (current.state === "cancelled") return current;
  if (next.state === "cancelled" || !isTerminal(current.state)) return next;
  return current;
}

/** Mark all non-terminal steps cancelled. The returned map is a new immutable snapshot. */
export function cancelWorkflow(
  plan: WorkflowPlan,
  states: WorkflowExecutionStates,
): ReadonlyMap<string, WorkflowExecution>;
export function cancelWorkflow(
  states: WorkflowExecutionStates,
  plan?: WorkflowPlan,
): ReadonlyMap<string, WorkflowExecution>;
export function cancelWorkflow(
  first: WorkflowPlan | WorkflowExecutionStates,
  second?: WorkflowExecutionStates | WorkflowPlan,
): ReadonlyMap<string, WorkflowExecution> {
  const firstIsPlan = "steps" in first;
  const plan = firstIsPlan ? first : (second as WorkflowPlan | undefined);
  const states = firstIsPlan ? (second as WorkflowExecutionStates) : first;
  const keys = plan?.steps.map((step) => step.key) ?? [...states.keys()];
  const cancelled = new Map<string, WorkflowExecution>();
  for (const key of keys) {
    const current = executionFor(states, key);
    cancelled.set(
      key,
      current.state === "cancelled" || isTerminal(current.state)
        ? current
        : { state: "cancelled" },
    );
  }
  return cancelled;
}

/** Compute workflow terminal state and preserve plan order in the fan-in view. */
export function fanInWorkflow(
  plan: WorkflowPlan,
  states: WorkflowExecutionStates,
): WorkflowFanIn {
  const tasks = plan.steps.map((step): WorkflowTaskView => ({
    key: step.key,
    taskId: step.taskId,
    ...executionFor(states, step.key),
  }));
  const values = tasks.map((task) => task.state);
  let state: WorkflowFanIn["state"];
  if (values.some((value) => value === "failed" || value === "timed_out"))
    state = "failed";
  else if (values.some((value) => value === "cancelled")) state = "cancelled";
  else if (values.some((value) => value === "blocked")) state = "blocked";
  else if (values.every((value) => value === "succeeded")) state = "succeeded";
  else if (values.some((value) => value === "running")) state = "running";
  else state = "queued";
  return { state, tasks };
}

export const getWorkflowReadiness = workflowReadiness;
export const aggregateWorkflow = fanInWorkflow;
