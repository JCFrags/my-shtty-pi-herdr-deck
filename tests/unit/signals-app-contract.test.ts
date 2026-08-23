import assert from "node:assert/strict";
import test from "node:test";
import { BrokerDeckApp } from "../../src/deck/broker-app.js";
import type { BrokerClient } from "../../src/deck/broker-client.js";
import { DeckStore } from "../../src/deck/store.js";

const projection = (revision: number) => ({
  ownerAgentId: "agent-1",
  piSessionId: "pi-1",
  agentBoard: {
    available: true,
    openCount: 1,
    items: [{ id: "question-1", title: "Choose a mode" }],
    pendingQuestions: [
      {
        questionId: "question-1",
        revision,
        question: "Choose a mode",
        response: {
          kind: "single_or_text" as const,
          options: [
            { id: "safe", label: "Safe" },
            { id: "fast", label: "Fast" },
          ],
        },
        recommendedOptionIds: ["safe"],
      },
    ],
    view: {
      view: {
        tabs: {
          inbox: {
            rows: [
              {
                id: "question-1",
                title: "Choose a mode",
                revision,
                userAnswerable: true,
                dismissible: true,
              },
            ],
          },
        },
      },
    },
  },
  todo: { available: true, total: 0, completed: 0, items: [] },
});

function fixtureSnapshot(revision: number) {
  return {
    seq: revision,
    agents: [
      {
        id: "agent-1",
        state: "working" as const,
        generation: 1,
        paneId: "pane-1",
        piSessionId: "pi-1",
      },
    ],
    tasks: [],
    runs: [],
    workflows: [],
    groups: [],
    questions: [],
    results: [],
    providerProjections: [projection(revision)],
  };
}

function appFixture() {
  const store = new DeckStore();
  store.replace(fixtureSnapshot(1));
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  const client = {
    store,
    status: "connected" as const,
    onStatus: () => () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      return {};
    },
    refresh: async () => ({}),
  } as unknown as BrokerClient;
  const app = new BrokerDeckApp({
    client,
    requestRender: () => undefined,
    getHeight: () => 32,
    targetPaneId: "pane-1",
  });
  return { app, store, requests };
}

test("BrokerDeckApp captures an exact typed Signals answer request", async () => {
  const { app, requests } = appFixture();
  app.handleInput("a");
  app.handleInput("1");
  app.handleInput("\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "provider.agent_board_action");
  assert.deepEqual(requests[0]?.params, {
    ownerAgentId: "agent-1",
    action: "answer-question",
    questionId: "question-1",
    expectedRevision: 1,
    source: "manual",
    value: { kind: "single_or_text", optionId: "safe" },
  });
  app.dispose();
});

test("BrokerDeckApp maps Recommendation to the provider accept action", async () => {
  const { app, requests } = appFixture();
  app.handleInput("a");
  app.handleInput("y");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests[0], {
    method: "provider.agent_board_action",
    params: {
      ownerAgentId: "agent-1",
      action: "accept-recommendation",
      questionId: "question-1",
      expectedRevision: 1,
    },
  });
  app.dispose();
});

test("BrokerDeckApp keeps the response modal open when the canonical revision changes", async () => {
  const { app, store, requests } = appFixture();
  app.handleInput("a");
  store.replace(fixtureSnapshot(2));
  app.handleInput("1");
  app.handleInput("\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 0);
  assert.ok(app.render(100).some((line) => line.includes("question changed")));
  app.dispose();
});
