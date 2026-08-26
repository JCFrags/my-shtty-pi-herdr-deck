import { createId } from "../shared/ids.js";
export type WorkflowMode =
  "single" | "parallel" | "chain" | "dag" | "implement_review_fix";
export type FailureMode = "fail_fast" | "collect_all";
export interface WorkflowStep {
  readonly key: string;
  readonly profileId: string;
  readonly title: string;
  readonly objectiveTemplate: string;
  readonly constraints: readonly string[];
  readonly dependsOn: readonly string[];
  readonly resultProjection: readonly string[];
  readonly isolationMode:
    | "profile-default"
    | "shared-readonly"
    | "worktree"
    | "shared-explicit"
    | "reuse-worktree";
}
export interface WorkflowDefinition {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly mode: WorkflowMode;
  readonly failureMode: FailureMode;
  readonly maxCorrectionLoops: number;
  readonly steps: readonly WorkflowStep[];
}
export interface PlannedStep {
  readonly key: string;
  readonly taskId: string;
  readonly profileId: string;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly dependsOn: readonly string[];
  readonly isolationMode: WorkflowStep["isolationMode"];
}
export interface WorkflowPlan {
  readonly workflowId: string;
  readonly mode: WorkflowMode;
  readonly dryRun: boolean;
  readonly steps: readonly PlannedStep[];
  readonly estimatedAgentCount: number;
  readonly limits: {
    readonly maxActiveAgents: number;
    readonly maxTasks: number;
  };
}
export interface ResultProjection {
  readonly summary?: string;
  readonly findings?: readonly unknown[];
  readonly changedFiles?: readonly unknown[];
  readonly tests?: readonly unknown[];
  readonly unresolved?: readonly unknown[];
  readonly recommendedNextAction?: string | null;
}
const allowedProjection = new Set([
  "/summary",
  "/findings",
  "/changedFiles",
  "/tests",
  "/unresolved",
  "/recommendedNextAction",
]);
function replaceTemplate(
  template: string,
  objective: string,
  dependencyResults: Readonly<Record<string, ResultProjection>>,
): string {
  return template.replace(
    /\{\{input\.objective\}\}|\{\{steps\.([a-z][a-z0-9_-]{0,63})\.([^{}]+)\}\}/g,
    (match, key: string | undefined, field: string | undefined) => {
      if (match === "{{input.objective}}") return objective;
      if (!key || !field || !allowedProjection.has(`/${field}`))
        throw new Error("WORKFLOW_TEMPLATE_INVALID");
      const value = dependencyResults[key]?.[field as keyof ResultProjection];
      return value === undefined || value === null ? "" : JSON.stringify(value);
    },
  );
}
export function validateWorkflow(definition: WorkflowDefinition): void {
  if (
    definition.version !== 1 ||
    definition.steps.length === 0 ||
    definition.steps.length > 32
  )
    throw new Error("WORKFLOW_INVALID");
  const keys = new Set<string>();
  for (const step of definition.steps) {
    if (keys.has(step.key)) throw new Error("WORKFLOW_DUPLICATE_STEP");
    keys.add(step.key);
    if (step.resultProjection.some((item) => !allowedProjection.has(item)))
      throw new Error("WORKFLOW_PROJECTION_INVALID");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error("WORKFLOW_CYCLE");
    if (visited.has(key)) return;
    const step = definition.steps.find((item) => item.key === key);
    if (!step) throw new Error("WORKFLOW_DEPENDENCY_MISSING");
    visiting.add(key);
    for (const dependency of step.dependsOn) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const step of definition.steps) visit(step.key);
  if (definition.mode === "single" && definition.steps.length !== 1)
    throw new Error("WORKFLOW_SINGLE_ARITY");
  if (definition.maxCorrectionLoops < 0 || definition.maxCorrectionLoops > 3)
    throw new Error("WORKFLOW_CORRECTION_LIMIT");
}
export function planWorkflow(
  definition: WorkflowDefinition,
  input: {
    readonly objective: string;
    readonly dryRun?: boolean;
    readonly maxActiveAgents?: number;
    readonly maxTasks?: number;
    readonly dependencyResults?: Readonly<Record<string, ResultProjection>>;
  },
): WorkflowPlan {
  validateWorkflow(definition);
  if (!input.objective || input.objective.length > 65_536)
    throw new Error("OBJECTIVE_INVALID");
  const dependencyResults = input.dependencyResults ?? {};
  const steps = definition.steps.map((step) => ({
    key: step.key,
    taskId: createId("tsk"),
    profileId: step.profileId,
    objective: replaceTemplate(
      step.objectiveTemplate,
      input.objective,
      dependencyResults,
    ),
    constraints: [...step.constraints],
    dependsOn: [...step.dependsOn],
    isolationMode: step.isolationMode,
  }));
  return {
    workflowId: createId("wfl"),
    mode: definition.mode,
    dryRun: input.dryRun === true,
    steps,
    estimatedAgentCount: new Set(steps.map((step) => step.profileId)).size,
    limits: {
      maxActiveAgents: input.maxActiveAgents ?? 4,
      maxTasks: input.maxTasks ?? 8,
    },
  };
}
export function aggregateResults(
  plan: WorkflowPlan,
  results: ReadonlyMap<
    string,
    { readonly state: string; readonly result?: unknown }
  >,
): {
  readonly state: "succeeded" | "failed" | "blocked";
  readonly tasks: readonly unknown[];
} {
  const tasks = plan.steps.map((step) => ({
    key: step.key,
    taskId: step.taskId,
    ...(results.get(step.key) ?? { state: "queued" }),
  }));
  const values = tasks.map((task) => task.state);
  if (values.includes("blocked")) return { state: "blocked", tasks };
  if (
    values.some((state) => ["failed", "timed_out", "cancelled"].includes(state))
  )
    return { state: "failed", tasks };
  return {
    state: values.every((state) => state === "succeeded")
      ? "succeeded"
      : "blocked",
    tasks,
  };
}
