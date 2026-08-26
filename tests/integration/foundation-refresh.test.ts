import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import type { ModelIntelligenceConfig } from "../../src/broker/endpoint-policy.js";
import { ArtificialAnalysisFoundationAdapter } from "../../src/model-intelligence/artificial-analysis.js";
import { brokerRequest } from "../../src/cli/client.js";
import { sessionKey } from "../../src/shared/paths.js";

function pathsFor(root: string, runtime: string) {
  return {
    sessionKey: sessionKey(join(runtime, "broker.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
}

const modelIntelligence: ModelIntelligenceConfig = {
  schemaVersion: 1,
  mappings: [
    {
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      endpointId: "remote_one",
      canonicalModelId: "openai/gpt-test",
    },
  ],
  sources: {
    artificialAnalysis: {
      enabled: true,
      refreshHours: 168,
      maxRequestsPerRefresh: 3,
      profileMetrics: { implementer: "coding" },
      models: [{ canonicalModelId: "openai/gpt-test", slug: "gpt-test" }],
    },
  },
};

function body() {
  return {
    tier: "pro",
    intelligence_index_version: 4.1,
    data: {
      id: "36f73aaf-d38a-4b56-a2b3-d04d17186910",
      name: "GPT Test",
      slug: "gpt-test",
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

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 3_000;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for foundation state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("foundation network work does not block broker requests and commits one atomic snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-broker-"));
  const runtime = await mkdtemp(join(tmpdir(), "foundation-broker-runtime-"));
  const paths = pathsFor(root, runtime);
  const fixedNow = Date.parse("2026-08-26T12:00:00.000Z");
  let fetchCount = 0;
  let resolveFetch!: (response: Response) => void;
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const response = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const adapter = new ArtificialAnalysisFoundationAdapter({
    fetch: async () => {
      fetchCount++;
      fetchStarted();
      if (fetchCount === 1) return await response;
      return new Response(JSON.stringify(body()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const broker = new Broker(paths, {
    modelPolicy: {
      allowlist: [
        {
          provider: "openai-codex",
          modelId: "gpt-5.6-luna",
          thinkingLevel: "medium",
        },
      ],
    },
    endpointPolicy: {
      endpoints: { remote_one: { maxConcurrentAgents: 4 } },
      mappings: modelIntelligence.mappings,
    },
    modelIntelligence,
    foundationAdapter: adapter,
    foundationCredentialProvider: async () => "private-key",
    now: () => fixedNow,
  });
  try {
    await broker.start();
    await started;
    const ping = await Promise.race([
      brokerRequest(
        paths.socket,
        paths.secret,
        "system.ping",
        {},
        paths.sessionKey,
      ),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Broker request was blocked by refresh.")),
          500,
        ),
      ),
    ]);
    assert.equal((ping as { status: string }).status, "healthy");
    const requested = (await brokerRequest(
      paths.socket,
      paths.secret,
      "model.foundation.refresh",
      {},
      paths.sessionKey,
    )) as { started: boolean };
    assert.equal(requested.started, true);

    resolveFetch(
      new Response(JSON.stringify(body()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const status = await waitFor(
      async () =>
        (await brokerRequest(
          paths.socket,
          paths.secret,
          "model.foundation.status",
          {},
          paths.sessionKey,
        )) as { state: string; activeRecordCount: number; stale: boolean },
      (value) => fetchCount === 2 && value.state === "fresh",
    );
    assert.equal(status.activeRecordCount, 1);
    assert.equal(status.stale, false);
    assert.equal(
      Object.values(broker.store.state.modelEvidence?.records ?? {}).filter(
        (stored) => stored.record.sourceKind === "foundation",
      ).length,
      1,
    );
    assert.equal(
      broker.store.state.lastEventSeq,
      1,
      "the complete normalized refresh is one durable event",
    );
    assert.equal(broker.store.verify().valid, true);
  } finally {
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("malformed refresh keeps the last good snapshot and reports failure without blocking the broker", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-last-good-"));
  const runtime = await mkdtemp(
    join(tmpdir(), "foundation-last-good-runtime-"),
  );
  const paths = pathsFor(root, runtime);
  let clock = Date.parse("2026-08-26T12:00:00.000Z");
  let malformed = false;
  const adapter = new ArtificialAnalysisFoundationAdapter({
    fetch: async () =>
      new Response(
        JSON.stringify(
          malformed
            ? {
                ...body(),
                data: {
                  ...body().data,
                  evaluations: {
                    ...body().data.evaluations,
                    artificial_analysis_coding_index: null,
                  },
                },
              }
            : body(),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  const options = {
    modelPolicy: {
      allowlist: [
        {
          provider: "openai-codex",
          modelId: "gpt-5.6-luna",
          thinkingLevel: "medium" as const,
        },
      ],
    },
    endpointPolicy: {
      endpoints: { remote_one: { maxConcurrentAgents: 4 } },
      mappings: modelIntelligence.mappings,
    },
    modelIntelligence,
    foundationAdapter: adapter,
    foundationCredentialProvider: async () => "private-key",
    now: () => clock,
  };
  let broker = new Broker(paths, options);
  try {
    await broker.start();
    await waitFor(
      async () =>
        (await brokerRequest(
          paths.socket,
          paths.secret,
          "model.foundation.status",
          {},
          paths.sessionKey,
        )) as { state: string },
      (value) => value.state === "fresh",
    );
    const lastGoodIds = Object.keys(
      broker.store.state.modelEvidence?.records ?? {},
    );
    clock +=
      modelIntelligence.sources!.artificialAnalysis!.refreshHours * 3_600_000;
    const stale = (await brokerRequest(
      paths.socket,
      paths.secret,
      "model.foundation.status",
      {},
      paths.sessionKey,
    )) as { state: string; stale: boolean };
    assert.equal(stale.stale, true);
    assert.equal(stale.state, "stale");

    malformed = true;
    const refresh = (await brokerRequest(
      paths.socket,
      paths.secret,
      "model.foundation.refresh",
      {},
      paths.sessionKey,
    )) as { started: boolean };
    assert.equal(refresh.started, true);
    const failed = await waitFor(
      async () =>
        (await brokerRequest(
          paths.socket,
          paths.secret,
          "model.foundation.status",
          {},
          paths.sessionKey,
        )) as { state: string; errorCode?: string; activeRecordCount: number },
      (value) => value.state === "failed",
    );
    assert.equal(failed.errorCode, "partial_response");
    assert.equal(failed.activeRecordCount, 1);
    assert.deepEqual(
      Object.keys(broker.store.state.modelEvidence?.records ?? {}),
      lastGoodIds,
    );
    assert.equal(
      (
        (await brokerRequest(
          paths.socket,
          paths.secret,
          "system.ping",
          {},
          paths.sessionKey,
        )) as { status: string }
      ).status,
      "healthy",
    );

    await broker.stop();
    broker = new Broker(paths, options);
    await broker.start();
    assert.deepEqual(
      Object.keys(broker.store.state.modelEvidence?.records ?? {}),
      lastGoodIds,
      "restart replays the same last-good foundation snapshot",
    );
    assert.equal(broker.store.verify().valid, true);
  } finally {
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});
