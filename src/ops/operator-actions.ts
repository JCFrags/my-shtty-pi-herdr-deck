import { createHash } from "node:crypto";

const COMMIT = /^[0-9a-f]{40}$/u;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const ACTIONS = new Set<OperatorActionPlan["action"]>([
  "deploy",
  "restart",
  "rollback",
]);

export interface OperatorResource {
  readonly id: string;
  readonly identity: string;
  readonly state:
    "clean" | "dirty" | "live" | "unknown" | "replaced" | "missing";
}

export interface PreflightEvidence {
  readonly name: string;
  readonly digest: string;
}

export interface RollbackRecord {
  readonly candidateCommit: string;
  readonly rollbackCommit: string;
  readonly stateGeneration: number;
  readonly resourceIdentities: readonly string[];
}

export interface OperatorActionPlan {
  readonly format: "pi-herdr-operator-action/v1";
  readonly action: "deploy" | "restart" | "rollback";
  readonly dryRun: true;
  readonly executionEnabled: false;
  readonly confirmationRequired: true;
  readonly expectedCommit: string;
  readonly expectedResources: readonly OperatorResource[];
  readonly preflight: readonly PreflightEvidence[];
  readonly timeoutMs: number;
  readonly rollback: RollbackRecord;
  readonly actions: readonly string[];
}

export interface FakeCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs: number },
  ): Promise<{ readonly status: number; readonly outputDigest?: string }>;
}

export interface ApplyOptions {
  readonly confirmed?: boolean;
  readonly execute?: boolean;
  readonly runner?: FakeCommandRunner;
}

function requireCommit(value: string, name: string): string {
  if (!COMMIT.test(value))
    throw new Error(`${name} must be a full 40-character commit ID.`);
  return value;
}

function requireDigest(value: string, name: string): string {
  if (!DIGEST.test(value)) throw new Error(`${name} must be a SHA-256 digest.`);
  return value;
}

function requireResource(resource: OperatorResource): OperatorResource {
  if (!RESOURCE_ID.test(resource.id) || resource.identity.length === 0)
    throw new Error("Resource identity is invalid.");
  if (resource.state !== "clean")
    throw new Error(
      `Resource ${resource.id} is not clean and must be retained.`,
    );
  return { ...resource };
}

export function createRollbackRecord(input: {
  candidateCommit: string;
  rollbackCommit: string;
  stateGeneration: number;
  resourceIdentities: readonly string[];
}): RollbackRecord {
  if (!Number.isSafeInteger(input.stateGeneration) || input.stateGeneration < 0)
    throw new Error("State generation must be a non-negative safe integer.");
  const resourceIdentities = [...input.resourceIdentities].sort();
  if (resourceIdentities.some((identity) => identity.length === 0))
    throw new Error("Rollback resource identities must not be empty.");
  return {
    candidateCommit: requireCommit(input.candidateCommit, "Candidate commit"),
    rollbackCommit: requireCommit(input.rollbackCommit, "Rollback commit"),
    stateGeneration: input.stateGeneration,
    resourceIdentities,
  };
}

export function createOperationPlan(input: {
  action: OperatorActionPlan["action"];
  expectedCommit: string;
  expectedResources: readonly OperatorResource[];
  preflight: readonly PreflightEvidence[];
  timeoutMs: number;
  rollback: RollbackRecord;
}): OperatorActionPlan {
  if (!ACTIONS.has(input.action))
    throw new Error("Operation action is invalid.");
  requireCommit(input.expectedCommit, "Expected commit");
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 300_000
  )
    throw new Error("Operation timeout must be between 1 and 300000 ms.");
  if (input.preflight.length === 0)
    throw new Error("Preflight evidence is required.");
  const preflight = input.preflight.map((item) => ({
    name: item.name,
    digest: requireDigest(item.digest, `Preflight evidence ${item.name}`),
  }));
  const expectedResources = input.expectedResources
    .map(requireResource)
    .sort((a, b) => a.id.localeCompare(b.id));
  const rollback = createRollbackRecord(input.rollback);
  return {
    format: "pi-herdr-operator-action/v1",
    action: input.action,
    dryRun: true,
    executionEnabled: false,
    confirmationRequired: true,
    expectedCommit: input.expectedCommit,
    expectedResources,
    preflight,
    timeoutMs: input.timeoutMs,
    rollback,
    actions: [
      "verify-commit",
      "verify-resources",
      "verify-preflight",
      "record-rollback",
      "run-bounded-action",
    ],
  };
}

export function verifyOperationPlan(
  plan: OperatorActionPlan,
  currentCommit: string,
  currentResources: readonly OperatorResource[],
): { readonly ok: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  if (currentCommit !== plan.expectedCommit)
    reasons.push("commit identity changed");
  const expected = new Map(
    plan.expectedResources.map((resource) => [resource.id, resource.identity]),
  );
  for (const resource of currentResources) {
    const identity = expected.get(resource.id);
    if (identity === undefined) {
      reasons.push(`unknown resource must be retained: ${resource.id}`);
      continue;
    }
    if (identity !== resource.identity)
      reasons.push(`resource identity changed: ${resource.id}`);
    if (resource.state !== "clean")
      reasons.push(`resource is not clean: ${resource.id}`);
  }
  for (const resource of plan.expectedResources)
    if (!currentResources.some((candidate) => candidate.id === resource.id))
      reasons.push(`resource is missing: ${resource.id}`);
  return { ok: reasons.length === 0, reasons };
}

export async function applyOperationPlan(
  plan: OperatorActionPlan,
  options: ApplyOptions = {},
): Promise<{
  readonly applied: boolean;
  readonly status: number;
  readonly outputDigest?: string;
}> {
  if (
    options.confirmed !== true ||
    options.execute !== true ||
    options.runner === undefined
  )
    throw new Error(
      "Mutation requires explicit confirmation, --execute, and an injected command runner.",
    );
  const result = await options.runner.run(plan.action, [plan.expectedCommit], {
    timeoutMs: plan.timeoutMs,
  });
  if (result.status !== 0)
    throw new Error(`Operation failed with status ${result.status}.`);
  return {
    applied: true,
    status: result.status,
    ...(result.outputDigest ? { outputDigest: result.outputDigest } : {}),
  };
}

export function digestEvidence(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
