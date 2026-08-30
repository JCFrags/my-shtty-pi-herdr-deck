import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  availableModelOptionsView,
  buildModelOptions,
  createAdvisoryModelReceipt,
  modelCapacityView,
  ratedAutomaticCandidate,
  validateAdvisoryModelReceipt,
} from "../../src/model-intelligence/model-ranking.js";
import {
  applyModelEvidenceRecord,
  emptyModelEvidenceState,
  normalizeModelEvidence,
} from "../../src/model-intelligence/model-evidence.js";
import { canonicalJson, sha256 } from "../../src/shared/canonical-json.js";
import { EventStore } from "../../src/state/event-store.js";
import { createId } from "../../src/shared/ids.js";
import {
  resolveSpawnPolicy,
  type ModelPolicyConfig,
} from "../../src/broker/model-policy.js";

const asOf = "2026-01-08T00:00:00.000Z";
const alpha = {
  provider: "local",
  modelId: "alpha",
  thinkingLevel: "medium",
} as const;
const beta = {
  provider: "local",
  modelId: "beta",
  thinkingLevel: "medium",
} as const;
const gamma = {
  provider: "remote",
  modelId: "gamma",
  thinkingLevel: "medium",
} as const;
const policy: ModelPolicyConfig = {
  defaults: { global: beta },
  allowlist: [alpha, beta],
  compatibility: { scout: ["subagent"] },
};
const capabilities = {
  models: [alpha, beta, gamma].map((selection) => ({
    provider: selection.provider,
    modelId: selection.modelId,
    reasoning: true,
    thinkingLevels: [selection.thinkingLevel],
  })),
  thinkingLevels: ["medium" as const],
};
const endpointPolicy = {
  endpoints: {
    alpha_ep: {
      maxConcurrentAgents: 1,
      resourceClass: "local_compute" as const,
    },
    beta_ep: {
      maxConcurrentAgents: 3,
      resourceClass: "remote_service" as const,
    },
    gamma_ep: { maxConcurrentAgents: 2 },
  },
  mappings: [
    { provider: "local", modelId: "alpha", endpointId: "alpha_ep" },
    { provider: "local", modelId: "beta", endpointId: "beta_ep" },
    { provider: "remote", modelId: "gamma", endpointId: "gamma_ep" },
  ],
};

function options(overrides: Record<string, unknown> = {}) {
  return buildModelOptions({
    capabilities,
    policy,
    endpointPolicy,
    scheduler: { queued: [], active: [], provisioning: 0 },
    fallbackEndpointLimit: 8,
    taskProfile: "scout",
    asOf,
    limit: 32,
    ...overrides,
  });
}

function alphaEvidence() {
  const record = normalizeModelEvidence({
    schemaVersion: 1,
    evidenceKind: "score",
    sourceKind: "human",
    sourceName: "operator",
    sourceKey: "alpha-quality",
    taskProfile: "scout",
    subject: {
      kind: "runtime",
      ...alpha,
      endpointId: "alpha_ep",
    },
    sampleCount: 4,
    observedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-02-01T00:00:00.000Z",
    dimension: "reviewed_output_quality",
    valuePpm: 900_000,
    confidencePpm: 1_000_000,
  });
  return applyModelEvidenceRecord(emptyModelEvidenceState(), record, 1);
}

function receiptDigest(value: Record<string, unknown>): string {
  return sha256(`pi-herdr:advisory-model-receipt:v1\0${canonicalJson(value)}`);
}

test("model options rank only installed policy-eligible pairs with deterministic ties", () => {
  const view = options();
  assert.equal(view.eligibleCount, 2);
  assert.equal(view.excludedCount, 1);
  assert.deepEqual(view.excluded[0], {
    selection: gamma,
    reason: "policy_allowlist",
  });
  assert.deepEqual(
    view.candidates.map((candidate) => candidate.selection),
    [alpha, beta],
  );
  assert.equal(view.candidates[1]?.tiedWithPrevious, true);
  assert.equal("currentSelection" in view, false);
});

test("public model options group choices and show capacity only for local compute", () => {
  const view = availableModelOptionsView(options(), endpointPolicy, 1);
  assert.equal(view.profileId, "scout");
  assert.deepEqual(view.thinkingGuide, [
    { thinkingLevel: "medium", useFor: "balanced default" },
  ]);
  assert.equal(view.availableModels.length, 1);
  assert.equal(view.moreAvailable, 1);
  assert.deepEqual(
    {
      rank: view.availableModels[0]?.rank,
      provider: view.availableModels[0]?.provider,
      modelId: view.availableModels[0]?.modelId,
      recommended: view.availableModels[0]?.recommended,
      capacity: view.availableModels[0]?.capacity,
      thinking: view.availableModels[0]?.thinkingLevels[0]?.thinkingLevel,
    },
    {
      rank: 1,
      provider: alpha.provider,
      modelId: alpha.modelId,
      recommended: true,
      capacity: { status: "ready", available: 1, limit: 1 },
      thinking: "medium",
    },
  );
  for (const rating of Object.values(
    view.availableModels[0]?.thinkingLevels[0]?.ratings ?? {},
  ))
    assert.match(rating, /^(?:★{0,5})(?:☆{0,5}) [0-5]\/5$/u);
  assert.equal("candidates" in view, false);
  assert.equal("excluded" in view, false);
  assert.equal("evidenceDigest" in view, false);
  assert.equal("scorePpm" in (view.availableModels[0] ?? {}), false);

  const remote = availableModelOptionsView(options(), endpointPolicy, 2);
  assert.equal(remote.availableModels[1]?.modelId, "beta");
  assert.equal(
    Object.hasOwn(remote.availableModels[1] ?? {}, "capacity"),
    false,
  );

  const busy = availableModelOptionsView(
    options({
      scheduler: {
        queued: [],
        active: [{ taskId: "task", endpointId: "alpha_ep" }],
        provisioning: 0,
      },
    }),
    endpointPolicy,
    1,
  );
  assert.deepEqual(busy.availableModels[0]?.capacity, {
    status: "will_queue",
    available: 0,
    limit: 1,
  });
});

test("group limits keep all available thinking levels for a returned model", () => {
  const alphaHigh = { ...alpha, thinkingLevel: "high" as const };
  const grouped = availableModelOptionsView(
    options({
      capabilities: {
        models: [
          {
            provider: alpha.provider,
            modelId: alpha.modelId,
            reasoning: true,
            thinkingLevels: ["medium", "high"],
          },
          capabilities.models[1],
          capabilities.models[2],
        ],
        thinkingLevels: ["medium", "high"],
      },
      policy: {
        ...policy,
        allowlist: [alpha, alphaHigh, beta],
      },
    }),
    endpointPolicy,
    1,
  );
  assert.equal(grouped.availableModels.length, 1);
  assert.equal(grouped.moreAvailable, 1);
  assert.deepEqual(
    grouped.availableModels[0]?.thinkingLevels.map((level) => ({
      rank: level.rank,
      thinkingLevel: level.thinkingLevel,
      recommended: level.recommended,
    })),
    [
      { rank: 1, thinkingLevel: "high", recommended: true },
      { rank: 2, thinkingLevel: "medium", recommended: false },
    ],
  );
  assert.deepEqual(
    grouped.thinkingGuide.map((guide) => guide.thinkingLevel),
    ["medium", "high"],
  );
});

test("explicit-required options do not require or disclose a configured default", () => {
  const view = options({
    policy: {
      defaults: { global: beta },
      allowlist: [alpha],
      compatibility: { scout: ["subagent"] },
    },
    modelIntelligence: {
      schemaVersion: 1,
      routingMode: "explicit_required",
      mappings: [],
    },
  });
  assert.deepEqual(
    view.candidates.map((candidate) => candidate.selection),
    [alpha],
  );
  assert.equal(view.eligibleCount, 1);
  assert.equal("currentSelection" in view, false);
});

test("rated automatic routing requires evidence and a unique leader", () => {
  const noEvidence = options({
    modelIntelligence: {
      schemaVersion: 1,
      routingMode: "rated_auto",
      mappings: [],
    },
  });
  assert.equal(ratedAutomaticCandidate(noEvidence), undefined);

  const evidenced = options({
    evidence: alphaEvidence(),
    modelIntelligence: {
      schemaVersion: 1,
      routingMode: "rated_auto",
      mappings: [],
    },
  });
  assert.deepEqual(ratedAutomaticCandidate(evidenced)?.selection, alpha);
  const receipt = createAdvisoryModelReceipt({
    options: evidenced,
    selectedModel: alpha,
    selectionReason: "rated_auto",
  });
  assert.equal(receipt.mode, "rated_auto");
  assert.equal(receipt.selectionReason, "rated_auto");
  assert.deepEqual(validateAdvisoryModelReceipt(receipt), receipt);
});

test("quality evidence changes advisory order but never changes the selected model", () => {
  const view = options({ evidence: alphaEvidence() });
  assert.deepEqual(view.candidates[0]?.selection, alpha);
  const receipt = createAdvisoryModelReceipt({
    options: view,
    selectedModel: beta,
    selectionReason: "current_default",
  });
  assert.deepEqual(receipt.selectedModel, beta);
  assert.deepEqual(receipt.recommendedModel, alpha);
  assert.equal(receipt.recommendedMatchesSelection, false);
  assert.ok(receipt.selectedRank !== null && receipt.selectedRank > 1);
  assert.deepEqual(validateAdvisoryModelReceipt(receipt), receipt);
});

test("an explicitly selected out-of-scope model is frozen without entering eligible ranking", () => {
  const view = options({ evidence: alphaEvidence() });
  const receipt = createAdvisoryModelReceipt({
    options: view,
    selectedModel: gamma,
    selectedEndpoint: modelCapacityView("gamma_ep", 2, {
      queued: [],
      active: [],
      provisioning: 0,
    }),
    selectionReason: "explicit_override",
  });
  assert.equal(receipt.selectedEligible, false);
  assert.equal(receipt.selectedRank, null);
  assert.deepEqual(receipt.selectedModel, gamma);
  assert.deepEqual(receipt.recommendedModel, alpha);
  assert.deepEqual(validateAdvisoryModelReceipt(receipt), receipt);
});

test("capacity is reported separately and cannot alter score, order, or ranking digest", () => {
  const evidence = alphaEvidence();
  const empty = options({ evidence });
  const busy = options({
    evidence,
    scheduler: {
      queued: [{ endpointId: "alpha_ep" }] as never,
      active: [{ endpointId: "alpha_ep" }] as never,
      provisioning: 0,
    },
  });
  assert.deepEqual(
    busy.candidates.map((candidate) => [
      candidate.selection,
      candidate.scorePpm,
    ]),
    empty.candidates.map((candidate) => [
      candidate.selection,
      candidate.scorePpm,
    ]),
  );
  assert.equal(busy.rankingDigest, empty.rankingDigest);
  assert.deepEqual(busy.candidates[0]?.endpoint, {
    endpointId: "alpha_ep",
    limit: 1,
    active: 1,
    queued: 1,
    available: 0,
  });
});

test("receipt validation rejects nested extension fields even with a recomputed digest", () => {
  const valid = createAdvisoryModelReceipt({
    options: options({ evidence: alphaEvidence() }),
    selectedModel: beta,
    selectionReason: "explicit_override",
  });
  const malformed = structuredClone(valid) as unknown as Record<
    string,
    unknown
  >;
  const alternatives = malformed.alternatives as Array<Record<string, unknown>>;
  alternatives[0]!.unexpected = true;
  const { receiptDigest: _old, ...withoutDigest } = malformed;
  malformed.receiptDigest = receiptDigest(withoutDigest);
  assert.throws(
    () => validateAdvisoryModelReceipt(malformed),
    /receipt is invalid/i,
  );
});

test("eligible exact pair scopes above 256 fail closed", () => {
  const many = Array.from({ length: 257 }, (_, index) => ({
    provider: "local",
    modelId: `model-${String(index).padStart(3, "0")}`,
    reasoning: true,
    thinkingLevels: ["medium" as const],
  }));
  assert.throws(
    () =>
      options({
        capabilities: { models: many, thinkingLevels: ["medium"] },
        policy: {
          defaults: {
            global: {
              provider: "local",
              modelId: "model-000",
              thinkingLevel: "medium",
            },
          },
          compatibility: { scout: ["subagent"] },
        },
      }),
    /MODEL_SCOPE_TOO_LARGE/,
  );
});

test("task replay preserves one atomic advisory receipt inside the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-receipt-"));
  try {
    const store = new EventStore(join(root, "events.jsonl"));
    await store.open();
    const taskId = createId("tsk");
    const spawnPolicy = resolveSpawnPolicy(
      { taskProfileId: "scout", projectKey: "/project" },
      policy,
    );
    const receipt = createAdvisoryModelReceipt({
      options: options({ evidence: alphaEvidence(), projectKey: "/project" }),
      selectedModel: spawnPolicy.effective.model,
      selectionReason: "current_default",
    });
    await store.append({
      type: "task.created_m3",
      actor: {
        principalId: "prn_00000000000000000000000000",
        kind: "system",
      },
      entityRefs: { taskId },
      payload: {
        taskId,
        title: "Frozen receipt",
        objective: "Verify atomic replay.",
        createdAt: asOf,
        profileId: "scout",
        endpointId: "beta_ep",
        dependencies: [],
        project: {
          cwd: "/project",
          workspaceId: "workspace",
          isolation: "shared-readonly",
          requestedSpawnPolicy: spawnPolicy.requested,
          effectiveSpawnPolicy: spawnPolicy.effective,
          modelPolicyHash: spawnPolicy.policyHash,
          advisoryModelReceipt: receipt,
        },
        timeoutAt: "2026-01-08T01:00:00.000Z",
      },
    });
    const replay = new EventStore(join(root, "events.jsonl"));
    await replay.open();
    assert.equal(replay.readOnly, false);
    assert.deepEqual(
      replay.state.tasks[taskId]?.project?.advisoryModelReceipt,
      receipt,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
