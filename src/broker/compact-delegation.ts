import { canonicalJson, sha256 } from "../shared/canonical-json.js";

export const COMPACT_DELEGATION_LIMITS = Object.freeze({
  maxBytes: 4_096,
  maxLines: 32,
  maxSteps: 16,
  maxTitleChars: 240,
  maxPreviewBytes: 8_192,
});

export interface CompactPolicyContext {
  readonly parentContextHash: string;
  readonly workspacePolicyHash: string;
  readonly parentGeneration: number;
  readonly parentDepth: number;
  readonly delegatedDepth: number;
  readonly maxDelegationDepth: number;
  readonly depthDecision: "allow";
  readonly budgetPolicyHash: string;
  readonly admissionLimits: {
    readonly maxActiveAgents: number;
    readonly maxActivePerParent: number;
    readonly maxQueuedTasks: number;
    readonly maxTasksPerDelegate: number;
    readonly maxProvisioning: number;
  };
  readonly admissionSnapshot: {
    readonly queuedTasks: number;
    readonly activeTasks: number;
    readonly parentActiveTasks: number;
    readonly provisioningTasks: number;
  };
  readonly admissionDecision: {
    readonly decision: "allow";
    readonly requestedTasks: number;
    readonly queueAfterAcceptance: number;
    readonly initialDispatch: "eligible" | "deferred";
  };
}
export interface CompactPolicyProjection {
  readonly decision: "allow";
  readonly placement: "current-workspace" | "new-workspace";
  readonly isolation: "shared-readonly" | "worktree";
  readonly modelProfileId: "manager" | "subagent";
  readonly providerQualifiedModel: string;
  readonly thinkingLevel: string;
  readonly modelPolicyHash: string;
  readonly context: CompactPolicyContext;
}
export interface CompactProfileResolution {
  readonly profileId: string;
  readonly policy: CompactPolicyProjection;
}
export type CompactProfileResolver = (
  requestedProfileId: string,
  requestedIsolation: "shared-readonly" | "worktree",
) => CompactProfileResolution | undefined;
export interface CompactStepPreview {
  readonly id: string;
  readonly profileId: string;
  readonly mode: "read" | "write";
  readonly dependencyIds: readonly string[];
  readonly placement: "current-workspace" | "new-workspace";
  readonly isolation: "shared-readonly" | "worktree";
}
export interface CompactCanonicalWorkflow {
  readonly mode: "dag";
  readonly title: "Compact delegation";
  readonly failureMode: "collect_all";
  readonly transcriptPolicy: "retain-tab";
  readonly steps: readonly {
    readonly key: string;
    readonly profileId: string;
    readonly title: string;
    readonly objective: string;
    readonly constraints: readonly string[];
    readonly dependsOn: readonly string[];
    readonly resultProjection: readonly string[];
    readonly isolation: "shared-readonly" | "worktree";
    readonly compactPolicy: CompactPolicyProjection;
  }[];
}
export interface CompactCompileResult {
  readonly schemaVersion: 1;
  readonly workflowDigest: string;
  readonly stepCount: number;
  readonly steps: readonly CompactStepPreview[];
  readonly workflow: CompactCanonicalWorkflow;
}

export class CompactDelegationError extends Error {
  readonly code: string;
  readonly line?: number;
  constructor(code: string, message: string, line?: number) {
    super(message);
    this.name = "CompactDelegationError";
    this.code = code;
    if (line !== undefined) this.line = line;
  }
}

const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const SHELL_CONTROL = /(?:[;&|`<>]|\$\(|\r|\0)/u;
const MARKER = /^(?:- \[([ x])\]|\* \[([ x])\]|\d+\.) +/u;

type Parsed = {
  id: string;
  title: string;
  after: string[];
  profileId: string;
  mode: "read" | "write";
  completedInput: boolean;
  policy: CompactPolicyProjection;
};

function fail(code: string, message: string, line?: number): never {
  throw new CompactDelegationError(code, message, line);
}

/** Compile compact text without I/O, allocation, event writes, or command execution. */
export function compileCompactDelegation(
  input: string | Uint8Array,
  resolveProfile: CompactProfileResolver,
  defaultProfileId = "implementer",
): CompactCompileResult {
  let text: string;
  if (typeof input === "string") text = input;
  else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      fail("COMPACT_UTF8_INVALID", "Input is not valid UTF-8.");
    }
  }
  if (Buffer.byteLength(text, "utf8") > COMPACT_DELEGATION_LIMITS.maxBytes)
    fail("COMPACT_BYTE_LIMIT", "Input exceeds 4,096 UTF-8 bytes.");
  if (/\r|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
    fail("COMPACT_CONTROL_CHARACTER", "Input contains a control character.");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const nonEmptyLineCount = lines.filter((line) => !/^ *$/u.test(line)).length;
  if (nonEmptyLineCount > COMPACT_DELEGATION_LIMITS.maxLines)
    fail("COMPACT_LINE_LIMIT", "Input exceeds 32 non-empty lines.");

  const parsed: Parsed[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = lines[index]!;
    if (/^ *$/u.test(line)) continue;
    const marker = MARKER.exec(line);
    if (!marker)
      fail("COMPACT_MARKER_INVALID", "Step marker is invalid.", lineNumber);
    const completedInput = marker[1] === "x" || marker[2] === "x";
    let rest = line.slice(marker[0].length);
    const colon = rest.indexOf(":");
    if (colon < 1 || rest[colon + 1] !== " ")
      fail(
        "COMPACT_STEP_INVALID",
        "Step must contain an ID, colon, and title.",
        lineNumber,
      );
    const id = rest.slice(0, colon);
    if (!ID.test(id))
      fail("COMPACT_ID_INVALID", "Step ID is invalid.", lineNumber);
    if (ids.has(id))
      fail("COMPACT_ID_DUPLICATE", "Step ID is duplicated.", lineNumber);
    ids.add(id);
    rest = rest.slice(colon + 2);

    let command: string | undefined;
    const commandAt = rest.indexOf(" :: ");
    if (commandAt >= 0) {
      command = rest.slice(commandAt + 4);
      rest = rest.slice(0, commandAt);
      if (!command || SHELL_CONTROL.test(command))
        fail(
          "COMPACT_COMMAND_UNSAFE",
          "Command description contains shell control data.",
          lineNumber,
        );
    }
    const tags = [...rest.matchAll(/ +\[([^\]]+)\]/gu)];
    const firstTag = tags[0]?.index;
    const title = (
      firstTag === undefined ? rest : rest.slice(0, firstTag)
    ).trimEnd();
    if (
      !title ||
      title.length > COMPACT_DELEGATION_LIMITS.maxTitleChars ||
      /[\[\]]/u.test(title)
    )
      fail(
        "COMPACT_TITLE_INVALID",
        "Title must contain 1 to 240 safe characters.",
        lineNumber,
      );
    if (firstTag !== undefined) {
      const suffix = rest.slice(firstTag);
      if (tags.map((tag) => tag[0]).join("") !== suffix)
        fail("COMPACT_TAG_INVALID", "Tag syntax is invalid.", lineNumber);
    }
    let profileId = defaultProfileId;
    let mode: "read" | "write" = "write";
    let after: string[] = [];
    const seenTags = new Set<string>();
    for (const tag of tags) {
      const value = tag[1]!;
      const kind = value.split(":", 1)[0]!;
      if (seenTags.has(kind))
        fail("COMPACT_TAG_DUPLICATE", "Tag is duplicated.", lineNumber);
      seenTags.add(kind);
      if (value.startsWith("after:")) {
        after = value.slice(6).split(",");
        if (
          after.length === 0 ||
          after.some((item) => !ID.test(item)) ||
          new Set(after).size !== after.length
        )
          fail(
            "COMPACT_AFTER_INVALID",
            "Dependencies are invalid or duplicated.",
            lineNumber,
          );
      } else if (value.startsWith("profile:")) {
        profileId = value.slice(8);
        if (!ID.test(profileId))
          fail("COMPACT_PROFILE_INVALID", "Profile ID is invalid.", lineNumber);
      } else if (value === "mode:read") mode = "read";
      else if (value === "mode:write") mode = "write";
      else fail("COMPACT_TAG_UNKNOWN", "Tag is not supported.", lineNumber);
    }
    const requestedIsolation = mode === "read" ? "shared-readonly" : "worktree";
    const resolved = resolveProfile(profileId, requestedIsolation);
    if (
      !resolved ||
      !ID.test(resolved.profileId) ||
      resolved.policy.isolation !== requestedIsolation ||
      !/^[a-f0-9]{64}$/u.test(resolved.policy.modelPolicyHash) ||
      !/^[a-f0-9]{64}$/u.test(resolved.policy.context.parentContextHash) ||
      !/^[a-f0-9]{64}$/u.test(resolved.policy.context.workspacePolicyHash) ||
      !/^[a-f0-9]{64}$/u.test(resolved.policy.context.budgetPolicyHash) ||
      resolved.policy.context.depthDecision !== "allow" ||
      !resolved.policy.providerQualifiedModel.includes("/")
    )
      fail("COMPACT_PROFILE_UNTRUSTED", "Profile is not trusted.", lineNumber);
    parsed.push({
      id,
      title,
      after,
      profileId: resolved.profileId,
      mode,
      completedInput,
      policy: resolved.policy,
    });
  }
  if (parsed.length === 0) fail("COMPACT_EMPTY", "Input has no steps.");
  if (parsed.length > COMPACT_DELEGATION_LIMITS.maxSteps)
    fail("COMPACT_STEP_LIMIT", "Input exceeds 16 steps.");
  for (const step of parsed)
    if (step.after.some((dependency) => !ids.has(dependency)))
      fail("COMPACT_DEPENDENCY_UNKNOWN", "A dependency does not exist.");
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(parsed.map((step) => [step.id, step]));
  const visit = (id: string): void => {
    if (visiting.has(id))
      fail("COMPACT_CYCLE", "Dependencies contain a cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.after) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of parsed) visit(step.id);

  const workflow: CompactCanonicalWorkflow = {
    mode: "dag",
    title: "Compact delegation",
    failureMode: "collect_all",
    transcriptPolicy: "retain-tab",
    steps: parsed.map((step) => ({
      key: step.id,
      profileId: step.profileId,
      title: step.title,
      objective: step.title,
      constraints: [],
      dependsOn: [...step.after].sort(),
      resultProjection: [],
      isolation: step.policy.isolation,
      compactPolicy: step.policy,
    })),
  };
  const workflowDigest = sha256(canonicalJson(workflow));
  const steps = parsed.map((step): CompactStepPreview => ({
    id: step.id,
    profileId: step.profileId,
    mode: step.mode,
    dependencyIds: [...step.after].sort(),
    placement: step.policy.placement,
    isolation: step.policy.isolation,
  }));
  const result = {
    schemaVersion: 1 as const,
    workflowDigest,
    stepCount: steps.length,
    steps,
    workflow,
  };
  if (
    Buffer.byteLength(
      JSON.stringify({ ...result, workflow: undefined }),
      "utf8",
    ) > COMPACT_DELEGATION_LIMITS.maxPreviewBytes
  )
    fail("COMPACT_PREVIEW_LIMIT", "Preview exceeds its safe bound.");
  return result;
}

export function acceptedCompactWorkflow(
  compiled: CompactCompileResult,
  acceptedDigest: string | undefined,
): CompactCanonicalWorkflow {
  if (!acceptedDigest || acceptedDigest !== compiled.workflowDigest)
    fail(
      "COMPACT_DIGEST_MISMATCH",
      "Scheduling requires explicit acceptance of the current digest.",
    );
  return compiled.workflow;
}
