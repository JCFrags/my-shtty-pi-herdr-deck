import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import type {
  ModelPolicyConfig,
  ModelSelection,
} from "../../src/broker/model-policy.js";
import type { BrokerOperatorSettings } from "../../src/broker/broker.js";
import { brokerRequest } from "../../src/cli/client.js";
import { sessionKey } from "../../src/shared/paths.js";

const luna: ModelSelection = {
  provider: "openai-codex",
  modelId: "gpt-5.6-luna",
  thinkingLevel: "medium",
};
const sol: ModelSelection = {
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "medium",
};

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

test("broker persists one validated operator settings batch before runtime apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "operator-settings-"));
  const runtime = await mkdtemp(join(tmpdir(), "operator-settings-runtime-"));
  const paths = pathsFor(root, runtime);
  const persisted: BrokerOperatorSettings[] = [];
  let rejectPersistence = false;
  const broker = new Broker(paths, {
    modelPolicy: { defaults: { global: luna } },
    persistOperatorSettings: async (settings) => {
      if (rejectPersistence) throw new Error("PERSISTENCE_REJECTED");
      persisted.push(structuredClone(settings));
    },
  });
  const rated = {
    schemaVersion: 1 as const,
    routingMode: "rated_auto" as const,
    mappings: [
      {
        provider: luna.provider,
        modelId: luna.modelId,
        endpointId: "local_model",
      },
    ],
    profiles: {
      implementer: {
        weightsPpm: {
          taskCapability: 450_000,
          protocolReliability: 250_000,
          speed: 100_000,
          effectiveCost: 50_000,
          humanPreference: 150_000,
        },
        uncertaintyPenaltyPpm: 100_000,
        tieBandPpm: 20_000,
      },
    },
  };
  try {
    await broker.start();
    const accepted = (await brokerRequest(
      paths.socket,
      paths.secret,
      "model.operator.settings.set",
      {
        allowlist: [luna, sol],
        endpoints: { local_model: { maxConcurrentAgents: 2 } },
        modelIntelligence: rated,
      },
      paths.sessionKey,
    )) as { persisted: boolean; operatorSettings: Record<string, unknown> };
    assert.equal(accepted.persisted, true);
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0]?.modelIntelligence, rated);
    const modelOptions = (await brokerRequest(
      paths.socket,
      paths.secret,
      "model.options",
      { profileId: "implementer", limit: 16 },
      paths.sessionKey,
    )) as {
      candidates: Array<{
        selection: ModelSelection;
        endpoint: { limit: number };
      }>;
    };
    assert.equal(
      modelOptions.candidates.find(
        (candidate) => candidate.selection.modelId === luna.modelId,
      )?.endpoint.limit,
      2,
    );

    rejectPersistence = true;
    await assert.rejects(
      () =>
        brokerRequest(
          paths.socket,
          paths.secret,
          "model.operator.settings.set",
          {
            allowlist: [luna, sol],
            endpoints: { local_model: { maxConcurrentAgents: 1 } },
            modelIntelligence: { ...rated, routingMode: "advisory" },
          },
          paths.sessionKey,
        ),
      /Request failed/u,
    );
    const afterFailure = (await brokerRequest(
      paths.socket,
      paths.secret,
      "model.policy.get",
      {},
      paths.sessionKey,
    )) as {
      operatorSettings: {
        endpoints: Record<string, { maxConcurrentAgents: number }>;
        modelIntelligence: { routingMode: string };
      };
    };
    assert.equal(
      afterFailure.operatorSettings.endpoints.local_model?.maxConcurrentAgents,
      2,
    );
    assert.equal(
      afterFailure.operatorSettings.modelIntelligence.routingMode,
      "rated_auto",
    );
    const afterFailureOptions = (await brokerRequest(
      paths.socket,
      paths.secret,
      "model.options",
      { profileId: "implementer", limit: 16 },
      paths.sessionKey,
    )) as typeof modelOptions;
    assert.equal(
      afterFailureOptions.candidates.find(
        (candidate) => candidate.selection.modelId === luna.modelId,
      )?.endpoint.limit,
      2,
    );
  } finally {
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("broker persists one validated model allowlist batch before applying it", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-allowlist-"));
  const runtime = await mkdtemp(join(tmpdir(), "model-allowlist-runtime-"));
  const paths = pathsFor(root, runtime);
  const persisted: ModelPolicyConfig[] = [];
  let rejectPersistence = false;
  const broker = new Broker(paths, {
    modelPolicy: {
      defaults: { global: luna, roles: { planner: sol } },
    },
    persistModelPolicy: async (policy) => {
      if (rejectPersistence) throw new Error("PERSISTENCE_REJECTED");
      persisted.push(policy);
    },
  });
  try {
    await broker.start();

    await assert.rejects(
      () =>
        brokerRequest(
          paths.socket,
          paths.secret,
          "model.policy.allowlist.set",
          { allowlist: [luna] },
          paths.sessionKey,
        ),
      /effective default/u,
    );
    await assert.rejects(
      () =>
        brokerRequest(
          paths.socket,
          paths.secret,
          "model.policy.allowlist.set",
          { allowlist: [luna, { ...sol, thinkingLevel: "max" }] },
          paths.sessionKey,
        ),
      /Request failed/u,
    );
    assert.equal(persisted.length, 0);

    const accepted = (await brokerRequest(
      paths.socket,
      paths.secret,
      "model.policy.allowlist.set",
      { allowlist: [luna, sol] },
      paths.sessionKey,
    )) as {
      accepted: boolean;
      persisted: boolean;
      policy: ModelPolicyConfig;
    };
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.persisted, true);
    assert.deepEqual(accepted.policy.allowlist, [luna, sol]);
    assert.deepEqual(persisted, [accepted.policy]);

    rejectPersistence = true;
    await assert.rejects(
      () =>
        brokerRequest(
          paths.socket,
          paths.secret,
          "model.policy.allowlist.set",
          { allowlist: null },
          paths.sessionKey,
        ),
      /Request failed/u,
    );
    const afterFailure = (await brokerRequest(
      paths.socket,
      paths.secret,
      "model.policy.get",
      {},
      paths.sessionKey,
    )) as { policy: ModelPolicyConfig };
    assert.deepEqual(afterFailure.policy.allowlist, [luna, sol]);

    rejectPersistence = false;
    const cleared = (await brokerRequest(
      paths.socket,
      paths.secret,
      "model.policy.allowlist.set",
      { allowlist: null },
      paths.sessionKey,
    )) as { policy: ModelPolicyConfig };
    assert.equal(cleared.policy.allowlist, undefined);
  } finally {
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});
