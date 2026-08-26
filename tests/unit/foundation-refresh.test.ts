import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ArtificialAnalysisFoundationAdapter,
  FoundationRefreshError,
  resolveScopedFoundationModels,
} from "../../src/model-intelligence/artificial-analysis.js";
import {
  applyFoundationEvidenceSnapshot,
  normalizeFoundationEvidenceSnapshot,
  validateFoundationEvidenceSnapshot,
} from "../../src/model-intelligence/foundation-snapshot.js";
import {
  emptyModelEvidenceState,
  normalizeModelEvidence,
} from "../../src/model-intelligence/model-evidence.js";
import {
  validateEndpointPolicyConfig,
  type ArtificialAnalysisSourceConfig,
  type ModelIntelligenceConfig,
} from "../../src/broker/endpoint-policy.js";
import { EventStore } from "../../src/state/event-store.js";
import { createId } from "../../src/shared/ids.js";

const now = Date.parse("2026-08-26T12:00:00.000Z");
const sourceConfig: ArtificialAnalysisSourceConfig = {
  enabled: true,
  refreshHours: 168,
  maxRequestsPerRefresh: 4,
  profileMetrics: {
    implementer: "coding",
    planner: "intelligence",
    scout: "agentic",
  },
  models: [
    { canonicalModelId: "openai/gpt-test", slug: "gpt-test" },
    { canonicalModelId: "vendor/other", slug: "other-model" },
  ],
};
const modelIntelligence: ModelIntelligenceConfig = {
  schemaVersion: 1,
  mappings: [
    {
      provider: "local-a",
      modelId: "gpt-test-q4",
      endpointId: "local_one",
      canonicalModelId: "openai/gpt-test",
      quantization: "q4",
    },
    {
      provider: "remote-a",
      modelId: "gpt-test",
      endpointId: "remote_one",
      canonicalModelId: "openai/gpt-test",
    },
    {
      provider: "remote-a",
      modelId: "other",
      endpointId: "remote_one",
      canonicalModelId: "vendor/other",
    },
  ],
  sources: { artificialAnalysis: sourceConfig },
};

function sourceBody(slug = "gpt-test") {
  return {
    tier: "pro",
    intelligence_index_version: 4.1,
    data: {
      id: "36f73aaf-d38a-4b56-a2b3-d04d17186910",
      name: "GPT Test",
      slug,
      release_date: "2026-08-01",
      model_creator: {
        id: "e67e56e3-15cd-43db-b679-da4660a69f41",
        name: "OpenAI",
      },
      evaluations: {
        artificial_analysis_intelligence_index: 71.2,
        artificial_analysis_coding_index: 65.8,
        artificial_analysis_agentic_index: 58.3,
      },
    },
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

test("foundation configuration is bounded and source aliases must reference canonical mappings", () => {
  const endpoints = {
    local_one: { maxConcurrentAgents: 1 },
    remote_one: { maxConcurrentAgents: 4 },
  };
  const validated = validateEndpointPolicyConfig(endpoints, modelIntelligence);
  assert.deepEqual(
    validated.modelIntelligence?.sources?.artificialAnalysis?.models,
    sourceConfig.models,
  );

  assert.throws(
    () =>
      validateEndpointPolicyConfig(endpoints, {
        ...modelIntelligence,
        sources: {
          artificialAnalysis: {
            ...sourceConfig,
            models: [
              { canonicalModelId: "unknown/model", slug: "unknown-model" },
            ],
          },
        },
      }),
    /models\[0\] is invalid/u,
  );
  assert.throws(
    () =>
      validateEndpointPolicyConfig(endpoints, {
        ...modelIntelligence,
        sources: {
          artificialAnalysis: {
            ...sourceConfig,
            maxRequestsPerRefresh: 33,
          },
        },
      }),
    /artificialAnalysis is invalid/u,
  );
  assert.throws(
    () =>
      validateEndpointPolicyConfig(endpoints, {
        ...modelIntelligence,
        sources: {
          artificialAnalysis: {
            ...sourceConfig,
            maxRequestsPerRefresh: 32,
            profileMetrics: Object.fromEntries(
              Array.from({ length: 9 }, (_, index) => [
                `profile_${index}`,
                "coding",
              ]),
            ),
          },
        },
      }),
    /profileMetrics is invalid/u,
    "the configured request and profile bounds must fit one atomic event",
  );
});

test("foundation scope intersects installed models, exact allowlist pairs, mappings, and source aliases", () => {
  const capabilities = {
    thinkingLevels: ["off", "medium", "high"] as const,
    models: [
      {
        provider: "local-a",
        modelId: "gpt-test-q4",
        reasoning: true,
        thinkingLevels: ["medium", "high"] as const,
      },
      {
        provider: "remote-a",
        modelId: "gpt-test",
        reasoning: true,
        thinkingLevels: ["medium"] as const,
      },
    ],
  };
  const scope = resolveScopedFoundationModels({
    capabilities,
    policy: {
      allowlist: [
        {
          provider: "local-a",
          modelId: "gpt-test-q4",
          thinkingLevel: "high",
        },
        {
          provider: "remote-a",
          modelId: "gpt-test",
          thinkingLevel: "medium",
        },
        {
          provider: "remote-a",
          modelId: "other",
          thinkingLevel: "medium",
        },
      ],
    },
    modelIntelligence,
  });
  assert.equal(scope.length, 1);
  assert.equal(scope[0]?.canonicalModelId, "openai/gpt-test");
  assert.equal(scope[0]?.slug, "gpt-test");
  assert.equal(scope[0]?.runtimeMappings.length, 2);

  assert.deepEqual(
    resolveScopedFoundationModels({
      capabilities,
      policy: {
        allowlist: [
          {
            provider: "local-a",
            modelId: "gpt-test-q4",
            thinkingLevel: "max",
          },
        ],
      },
      modelIntelligence,
    }),
    [],
  );
});

test("Artificial Analysis adapter requests only explicit model slugs and normalizes profile evidence", async () => {
  const urls: string[] = [];
  const adapter = new ArtificialAnalysisFoundationAdapter({
    fetch: async (url, init) => {
      urls.push(url);
      assert.equal(
        init.headers && (init.headers as Record<string, string>)["x-api-key"],
        "private-key",
      );
      return jsonResponse(sourceBody());
    },
    sleep: async () => undefined,
    random: () => 0,
  });
  const result = await adapter.refresh({
    credential: "private-key",
    scope: [
      {
        canonicalModelId: "openai/gpt-test",
        slug: "gpt-test",
        runtimeMappings: modelIntelligence.mappings.slice(0, 2),
      },
    ],
    config: sourceConfig,
    now,
  });
  assert.deepEqual(urls, [
    "https://artificialanalysis.ai/api/v2/language/models/gpt-test",
  ]);
  assert.equal(result.requestCount, 1);
  assert.equal(result.records.length, 3);
  assert.deepEqual(
    result.records.map((record) => [
      record.taskProfile,
      record.evidenceKind === "score" ? record.valuePpm : null,
    ]),
    [
      ["implementer", 658_000],
      ["planner", 712_000],
      ["scout", 583_000],
    ],
  );
  assert.ok(
    result.records.every(
      (record) =>
        record.sourceKind === "foundation" &&
        record.subject.kind === "canonical" &&
        record.subject.canonicalModelId === "openai/gpt-test" &&
        record.observedAt === "2026-08-26T12:00:00.000Z",
    ),
  );
  const repeated = await adapter.refresh({
    credential: "private-key",
    scope: [
      {
        canonicalModelId: "openai/gpt-test",
        slug: "gpt-test",
        runtimeMappings: modelIntelligence.mappings.slice(0, 2),
      },
    ],
    config: sourceConfig,
    now,
  });
  assert.deepEqual(repeated.records, result.records);
});

test("adapter rejects missing credentials, partial data, future dates, aliases, and exhausted request budgets", async () => {
  const scope = [
    {
      canonicalModelId: "openai/gpt-test",
      slug: "gpt-test",
      runtimeMappings: modelIntelligence.mappings.slice(0, 1),
    },
  ];
  const missing = new ArtificialAnalysisFoundationAdapter({
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  await assert.rejects(
    () =>
      missing.refresh({
        credential: undefined,
        scope,
        config: sourceConfig,
        now,
      }),
    (error: unknown) =>
      error instanceof FoundationRefreshError &&
      error.code === "missing_credential",
  );

  for (const [body, code] of [
    [
      {
        ...sourceBody(),
        data: {
          ...sourceBody().data,
          evaluations: {
            ...sourceBody().data.evaluations,
            artificial_analysis_coding_index: null,
          },
        },
      },
      "partial_response",
    ],
    [
      { ...sourceBody(), data: { ...sourceBody().data, slug: "wrong" } },
      "unknown_model",
    ],
    [
      {
        ...sourceBody(),
        data: { ...sourceBody().data, release_date: "2027-01-01" },
      },
      "future_dated",
    ],
    [{ ...sourceBody(), unexpected: true }, "malformed_response"],
    [
      {
        ...sourceBody(),
        data: { ...sourceBody().data, unexpected: true },
      },
      "malformed_response",
    ],
    [
      {
        ...sourceBody(),
        data: {
          ...sourceBody().data,
          evaluations: {
            ...sourceBody().data.evaluations,
            unexpected: 50,
          },
        },
      },
      "malformed_response",
    ],
    [
      {
        ...sourceBody(),
        data: { ...sourceBody().data, id: "not-a-source-id" },
      },
      "partial_response",
    ],
  ] as const) {
    const adapter = new ArtificialAnalysisFoundationAdapter({
      fetch: async () => jsonResponse(body),
    });
    await assert.rejects(
      () =>
        adapter.refresh({
          credential: "private-key",
          scope,
          config: sourceConfig,
          now,
        }),
      (error: unknown) =>
        error instanceof FoundationRefreshError && error.code === code,
    );
  }

  const budgeted = new ArtificialAnalysisFoundationAdapter({
    fetch: async () => new Response("rate limited", { status: 429 }),
    sleep: async () => undefined,
    random: () => 0,
  });
  await assert.rejects(
    () =>
      budgeted.refresh({
        credential: "private-key",
        scope,
        config: { ...sourceConfig, maxRequestsPerRefresh: 2 },
        now,
      }),
    (error: unknown) =>
      error instanceof FoundationRefreshError &&
      error.code === "request_budget",
  );
});

test("one foundation snapshot atomically supersedes the last good records and replays", async () => {
  const oldRecord = normalizeModelEvidence({
    schemaVersion: 1,
    evidenceKind: "score",
    sourceKind: "foundation",
    sourceName: "artificial-analysis-v2",
    sourceKey: "old",
    taskProfile: "implementer",
    subject: { kind: "canonical", canonicalModelId: "openai/gpt-test" },
    sampleCount: 1,
    observedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    dimension: "task_capability",
    valuePpm: 500_000,
    confidencePpm: 600_000,
  });
  const { evidenceId: _oldEvidenceId, ...oldInput } = oldRecord;
  const nextRecord = normalizeModelEvidence({
    ...oldInput,
    sourceKey: "next",
    observedAt: "2026-08-26T12:00:00.000Z",
    valuePpm: 658_000,
  });
  let state = applyFoundationEvidenceSnapshot(
    emptyModelEvidenceState(),
    normalizeFoundationEvidenceSnapshot({
      schemaVersion: 1,
      sourceName: "artificial-analysis-v2",
      observedAt: oldRecord.observedAt,
      items: [{ supersedes: [], record: oldRecord }],
    }),
    1,
  );
  const replacementInput = {
    schemaVersion: 1 as const,
    sourceName: "artificial-analysis-v2",
    observedAt: nextRecord.observedAt,
    items: [{ supersedes: [oldRecord.evidenceId], record: nextRecord }],
  };
  const replacement = normalizeFoundationEvidenceSnapshot(replacementInput);
  assert.deepEqual(
    normalizeFoundationEvidenceSnapshot(replacementInput),
    replacement,
    "the same normalized input has one stable snapshot identity",
  );
  state = applyFoundationEvidenceSnapshot(state, replacement, 2);
  assert.equal(state.supersededBy[oldRecord.evidenceId], nextRecord.evidenceId);
  const storedNext = state.records[nextRecord.evidenceId]?.record;
  assert.equal(
    storedNext?.evidenceKind === "score" ? storedNext.valuePpm : undefined,
    658_000,
  );
  assert.throws(
    () =>
      validateFoundationEvidenceSnapshot({
        ...replacement,
        snapshotId: "0".repeat(64),
      }),
    /does not match/u,
  );

  const root = await mkdtemp(join(tmpdir(), "foundation-snapshot-"));
  try {
    const path = join(root, "events.jsonl");
    const actor = { principalId: createId("prn"), kind: "system" } as const;
    const store = new EventStore(path, actor);
    await store.open();
    await store.append({
      type: "model.foundation_snapshot_recorded",
      actor,
      entityRefs: {},
      payload: normalizeFoundationEvidenceSnapshot({
        schemaVersion: 1,
        sourceName: "artificial-analysis-v2",
        observedAt: oldRecord.observedAt,
        items: [{ supersedes: [], record: oldRecord }],
      }),
    });
    await store.append({
      type: "model.foundation_snapshot_recorded",
      actor,
      entityRefs: {},
      payload: replacement,
    });
    const replay = new EventStore(path, actor);
    await replay.open();
    assert.deepEqual(replay.state.modelEvidence, store.state.modelEvidence);
    assert.equal(replay.verify().valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
