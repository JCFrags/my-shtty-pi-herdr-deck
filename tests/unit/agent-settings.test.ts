import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@pi-herdr-deck/tui";
import {
  openAgentSettings,
  type AgentSettingsClient,
} from "../../src/pi/agent-settings.js";
import type { PiContextLike } from "../../src/pi/types.js";

const luna = {
  provider: "openai-codex",
  modelId: "gpt-5.6-luna",
  reasoning: true,
  thinkingLevels: ["low", "medium"],
} as const;
const sol = {
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
  reasoning: true,
  thinkingLevels: ["medium", "high"],
} as const;

function contextFor(
  drive: (component: Component) => void,
  notifications: string[],
): PiContextLike {
  const ui = {
    notify: (message: string) => notifications.push(message),
    custom: async (
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: unknown) => void,
      ) => Component | Promise<Component>,
    ) => {
      let settled = false;
      let result: unknown;
      const component = await factory(
        {},
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        (value) => {
          settled = true;
          result = value;
        },
      );
      drive(component);
      assert.equal(settled, true, "The settings UI did not settle.");
      return result;
    },
  };
  return {
    ui,
    cwd: "/project",
    sessionManager: {},
    modelRegistry: {
      getAvailable: () => [
        { provider: luna.provider, id: luna.modelId },
        { provider: sol.provider, id: sol.modelId },
      ],
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => undefined,
    compact: () => undefined,
  } as unknown as PiContextLike;
}

function clientFor(requests: Array<{ method: string; params: unknown }>) {
  const client: AgentSettingsClient = {
    connected: true,
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "model.capabilities")
        return {
          models: [luna, sol],
          thinkingLevels: ["low", "medium", "high"],
        };
      if (method === "model.policy.get")
        return {
          policy: {
            defaults: {
              global: {
                provider: luna.provider,
                modelId: luna.modelId,
                thinkingLevel: "medium",
              },
            },
          },
        };
      return { accepted: true, persisted: true };
    },
  };
  return client;
}

test("agent settings saves exact per-model thinking selections as one batch", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const notifications: string[] = [];
  const context = contextFor((component) => {
    for (let index = 0; index < 6; index++) component.handleInput?.("\x1b[B");
    component.handleInput?.("\r");
    component.handleInput?.(" ");
    component.handleInput?.("\x1b[B");
    component.handleInput?.("\x1b[B");
    component.handleInput?.("\r");
    component.handleInput?.("\x1b[B");
    component.handleInput?.("\x1b[B");
    component.handleInput?.("\r");
  }, notifications);

  await openAgentSettings(clientFor(requests), context);

  assert.deepEqual(
    requests.map((request) => request.method),
    ["model.capabilities", "model.policy.get", "model.operator.settings.set"],
  );
  const batch = requests[2]?.params as Record<string, unknown>;
  assert.deepEqual(batch.allowlist, [
    {
      provider: luna.provider,
      modelId: luna.modelId,
      thinkingLevel: "low",
    },
    {
      provider: luna.provider,
      modelId: luna.modelId,
      thinkingLevel: "medium",
    },
  ]);
  assert.deepEqual(batch.endpoints, null);
  const intelligence = batch.modelIntelligence as {
    routingMode: string;
    mappings: unknown[];
    profiles: Record<
      string,
      { weightsPpm: Record<string, number>; tieBandPpm: number }
    >;
  };
  assert.equal(intelligence.routingMode, "current_default");
  assert.deepEqual(intelligence.mappings, []);
  assert.deepEqual(Object.keys(intelligence.profiles).sort(), [
    "implementer",
    "planner",
    "reviewer",
    "scout",
    "test-runner",
  ]);
  assert.equal(
    Object.values(intelligence.profiles.implementer!.weightsPpm).reduce(
      (sum, weight) => sum + weight,
      0,
    ),
    1_000_000,
  );
  assert.equal(intelligence.profiles.implementer!.tieBandPpm, 20_000);
  assert.deepEqual(notifications, [
    "Agent settings were saved for new agents.",
  ]);
});

test("agent settings saves explicit-required routing", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const notifications: string[] = [];
  const context = contextFor((component) => {
    component.handleInput?.(" ");
    component.handleInput?.(" ");
    component.handleInput?.(" ");
    for (let index = 0; index < 8; index++) component.handleInput?.("\x1b[B");
    component.handleInput?.("\r");
  }, notifications);

  await openAgentSettings(clientFor(requests), context);

  const batch = requests[2]?.params as {
    modelIntelligence?: { routingMode?: string };
  };
  assert.equal(batch.modelIntelligence?.routingMode, "explicit_required");
  assert.deepEqual(notifications, [
    "Agent settings were saved for new agents.",
  ]);
});

test("agent settings escape cancels without changing broker policy", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const notifications: string[] = [];
  const context = contextFor(
    (component) => component.handleInput?.("\x1b"),
    notifications,
  );

  await openAgentSettings(clientFor(requests), context);

  assert.deepEqual(
    requests.map((request) => request.method),
    ["model.capabilities", "model.policy.get"],
  );
  assert.deepEqual(notifications, []);
});
