import { createHash } from "node:crypto";
import { readPrivateRegular } from "../shared/private-fs.js";

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

export interface CurrentOperationEvidence {
  readonly format: "pi-herdr-operator-current/v1";
  readonly commit: string;
  readonly resources: readonly OperatorResource[];
  readonly preflight: readonly PreflightEvidence[];
}

export interface ApplyOptions {
  readonly confirmed?: boolean;
  readonly execute?: boolean;
  readonly runner?: FakeCommandRunner;
  readonly readCurrentEvidence?: () => Promise<CurrentOperationEvidence>;
}

const MAX_JSON_BYTES = 1_048_576;
const MAX_ENTRIES = 128;
const PLAN_KEYS = new Set([
  "format",
  "action",
  "dryRun",
  "executionEnabled",
  "confirmationRequired",
  "expectedCommit",
  "expectedResources",
  "preflight",
  "timeoutMs",
  "rollback",
  "actions",
]);
const CURRENT_KEYS = new Set(["format", "commit", "resources", "preflight"]);
const RESOURCE_KEYS = new Set(["id", "identity", "state"]);
const PREFLIGHT_KEYS = new Set(["name", "digest"]);
const ROLLBACK_KEYS = new Set([
  "candidateCommit",
  "rollbackCommit",
  "stateGeneration",
  "resourceIdentities",
]);

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  name: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      throw new Error(`${name} contains unknown field: ${key}.`);
}

function stringValue(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(
      `${name} must be a bounded string without control characters.`,
    );
  return value;
}

function parseResource(
  value: unknown,
  name: string,
  allowUnsafe: boolean,
): OperatorResource {
  const input = record(value, name);
  exactKeys(input, RESOURCE_KEYS, name);
  const resource = {
    id: stringValue(input.id, `${name}.id`),
    identity: stringValue(input.identity, `${name}.identity`),
    state: stringValue(
      input.state,
      `${name}.state`,
    ) as OperatorResource["state"],
  };
  if (!RESOURCE_ID.test(resource.id) || resource.identity.length > 256)
    throw new Error(`${name} has an invalid identity.`);
  if (
    !["clean", "dirty", "live", "unknown", "replaced", "missing"].includes(
      resource.state,
    )
  )
    throw new Error(`${name}.state is invalid.`);
  if (!allowUnsafe && resource.state !== "clean")
    throw new Error(`${name} is not clean and must be retained.`);
  return resource;
}

function parsePreflight(value: unknown, name: string): PreflightEvidence {
  const input = record(value, name);
  exactKeys(input, PREFLIGHT_KEYS, name);
  const result = {
    name: stringValue(input.name, `${name}.name`),
    digest: stringValue(input.digest, `${name}.digest`),
  };
  requireDigest(result.digest, `${name}.digest`);
  return result;
}

function parseEntries<T>(
  value: unknown,
  name: string,
  parse: (value: unknown, name: string) => T,
  key: (value: T) => string,
  allowEmpty = false,
): T[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ENTRIES ||
    (!allowEmpty && value.length === 0)
  )
    throw new Error(`${name} must contain 1 to ${MAX_ENTRIES} entries.`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const parsed = parse(item, `${name}[${index}]`);
    const identity = key(parsed);
    if (seen.has(identity))
      throw new Error(`${name} contains a duplicate: ${identity}.`);
    seen.add(identity);
    return parsed;
  });
}

function parsePlan(value: unknown): OperatorActionPlan {
  const input = record(value, "plan");
  exactKeys(input, PLAN_KEYS, "plan");
  if (
    input.format !== "pi-herdr-operator-action/v1" ||
    input.dryRun !== true ||
    input.executionEnabled !== false ||
    input.confirmationRequired !== true
  )
    throw new Error("Plan safety markers are invalid.");
  const action = stringValue(
    input.action,
    "plan.action",
  ) as OperatorActionPlan["action"];
  const expectedCommit = requireCommit(
    stringValue(input.expectedCommit, "plan.expectedCommit"),
    "Expected commit",
  );
  if (!ACTIONS.has(action)) throw new Error("plan.action is invalid.");
  const expectedResources = parseEntries(
    input.expectedResources,
    "plan.expectedResources",
    (item, name) => parseResource(item, name, false),
    (item) => item.id,
    true,
  ).sort((a, b) => a.id.localeCompare(b.id));
  const preflight = parseEntries(
    input.preflight,
    "plan.preflight",
    parsePreflight,
    (item) => item.name,
  );
  const timeoutMs = input.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000
  )
    throw new Error("plan.timeoutMs is invalid.");
  const rollbackInput = record(input.rollback, "plan.rollback");
  exactKeys(rollbackInput, ROLLBACK_KEYS, "plan.rollback");
  const rollback = createRollbackRecord({
    candidateCommit: stringValue(
      rollbackInput.candidateCommit,
      "plan.rollback.candidateCommit",
    ),
    rollbackCommit: stringValue(
      rollbackInput.rollbackCommit,
      "plan.rollback.rollbackCommit",
    ),
    stateGeneration: rollbackInput.stateGeneration as number,
    resourceIdentities: parseEntries(
      rollbackInput.resourceIdentities,
      "plan.rollback.resourceIdentities",
      (item, name) => stringValue(item, name),
      (item) => item,
      true,
    ),
  });
  if (
    rollback.candidateCommit !== expectedCommit ||
    rollback.resourceIdentities.join("\u0000") !==
      expectedResources
        .map((item) => item.identity)
        .sort()
        .join("\u0000")
  )
    throw new Error("Rollback record is not bound to the expected plan.");
  if (
    !Array.isArray(input.actions) ||
    input.actions.length === 0 ||
    input.actions.length > 32 ||
    input.actions.some(
      (item) =>
        typeof item !== "string" || item.length === 0 || item.length > 128,
    )
  )
    throw new Error("plan.actions is invalid.");
  return {
    format: "pi-herdr-operator-action/v1",
    action,
    dryRun: true,
    executionEnabled: false,
    confirmationRequired: true,
    expectedCommit,
    expectedResources,
    preflight,
    timeoutMs,
    rollback,
    actions: [...input.actions] as string[],
  };
}

function parseCurrent(value: unknown): CurrentOperationEvidence {
  const input = record(value, "current evidence");
  exactKeys(input, CURRENT_KEYS, "current evidence");
  if (input.format !== "pi-herdr-operator-current/v1")
    throw new Error("Current evidence format is invalid.");
  return {
    format: "pi-herdr-operator-current/v1",
    commit: requireCommit(
      stringValue(input.commit, "current.commit"),
      "Current commit",
    ),
    resources: parseEntries(
      input.resources,
      "current.resources",
      (item, name) => parseResource(item, name, true),
      (item) => item.id,
      true,
    ),
    preflight: parseEntries(
      input.preflight,
      "current.preflight",
      parsePreflight,
      (item) => item.name,
    ),
  };
}

export async function loadOperationPlan(
  path: string,
): Promise<OperatorActionPlan> {
  const content = await readPrivateRegular(path);
  if (Buffer.byteLength(content, "utf8") > MAX_JSON_BYTES)
    throw new Error("Plan file is too large.");
  try {
    return parsePlan(JSON.parse(content) as unknown);
  } catch (error) {
    throw new Error(
      `Invalid operation plan: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
}

export async function loadCurrentEvidence(
  path: string,
): Promise<CurrentOperationEvidence> {
  const content = await readPrivateRegular(path);
  if (Buffer.byteLength(content, "utf8") > MAX_JSON_BYTES)
    throw new Error("Current evidence file is too large.");
  try {
    return parseCurrent(JSON.parse(content) as unknown);
  } catch (error) {
    throw new Error(
      `Invalid current evidence: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
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
  if (
    rollback.candidateCommit !== input.expectedCommit ||
    rollback.resourceIdentities.join("\u0000") !==
      expectedResources
        .map((item) => item.identity)
        .sort()
        .join("\u0000")
  )
    throw new Error("Rollback record is not bound to the expected plan.");
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
  currentPreflight: readonly PreflightEvidence[],
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
  const expectedPreflight = new Map(
    plan.preflight.map((item) => [item.name, item.digest]),
  );
  const currentPreflightNames = new Set<string>();
  for (const item of currentPreflight) {
    if (currentPreflightNames.has(item.name))
      reasons.push(`duplicate preflight evidence: ${item.name}`);
    currentPreflightNames.add(item.name);
    const expectedDigest = expectedPreflight.get(item.name);
    if (expectedDigest === undefined)
      reasons.push(`extra preflight evidence: ${item.name}`);
    else if (expectedDigest !== item.digest)
      reasons.push(`preflight evidence changed: ${item.name}`);
  }
  for (const item of plan.preflight)
    if (!currentPreflightNames.has(item.name))
      reasons.push(`preflight evidence missing: ${item.name}`);
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
    options.runner === undefined ||
    options.readCurrentEvidence === undefined
  )
    throw new Error(
      "Mutation requires explicit confirmation, --execute, and an injected command runner.",
    );
  const current = await options.readCurrentEvidence();
  const verification = verifyOperationPlan(
    plan,
    current.commit,
    current.resources,
    current.preflight,
  );
  if (!verification.ok)
    throw new Error(
      `Operation evidence is stale: ${verification.reasons.join("; ")}`,
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
