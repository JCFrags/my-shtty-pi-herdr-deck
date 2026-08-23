import assert from "node:assert/strict";
import test from "node:test";
import { BrokerClient } from "../../src/deck/broker-client.js";
import { BrokerDeckApp } from "../../src/deck/broker-app.js";
import type { DeckSnapshot } from "../../src/deck/types.js";
import type { Agent } from "../../src/state/types.js";
import type { ProviderProjection } from "../../src/shared/provider-projections.js";

const owner = (overrides: Partial<Agent> = {}): Agent => ({
  id: "owner",
  state: "working",
  generation: 1,
  paneId: "pane-1",
  cwd: "/repo",
  ...overrides,
});

const projection = (
  agentBoard: ProviderProjection["agentBoard"] = {
    available: true,
    openCount: 0,
    items: [],
  },
): ProviderProjection => ({
  ownerAgentId: "owner",
  piSessionId: "session-1",
  todo: { available: true, total: 0, completed: 0, items: [] },
  agentBoard,
});

const snapshot = (agent = owner(), provider = projection()): DeckSnapshot => ({
  seq: 1,
  agents: [agent],
  tasks: [],
  runs: [],
  workflows: [],
  groups: [],
  questions: [],
  results: [],
  providerProjections: [provider],
});

function appFor(client: BrokerClient): BrokerDeckApp {
  return new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => undefined,
    getHeight: () => 30,
  });
}

function clientFor(value: DeckSnapshot): BrokerClient {
  const client = new BrokerClient({
    socketPath: "/tmp/agent-activity-overlay-contract.sock",
    secret: "test",
  });
  client.store.replace(value);
  return client;
}

test("BrokerDeckApp accepts empty file and model filters but rejects empty actions", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = clientFor(snapshot());
  (client as any).request = async (method: string, params: unknown) => {
    requests.push({ method, params });
    return method === "model.capabilities" ? { models: [] } : {};
  };
  const app = appFor(client);

  app.handleInput("2");
  app.handleInput("/");
  app.handleInput("\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    requests.some(
      ({ method, params }) =>
        method === "provider.files_action" &&
        (params as { query?: string }).query === "",
    ),
    true,
  );

  app.handleInput("3");
  app.handleInput("p");
  app.handleInput("\n");
  assert.match(app.render(100).join("\n"), /Text is required/);

  app.handleInput("\u001b");
  app.handleInput(",");
  app.handleInput("/");
  app.handleInput("\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(app.render(100).join("\n"), /Text is required/);
  app.dispose();
});

test("BrokerDeckApp Agent More uses the exact generation guard for rendering and actions", async () => {
  const requests: Array<{ method: string; params: any }> = [];
  const client = clientFor(snapshot(owner({ state: "working" })));
  (client as any).request = async (method: string, params: unknown) => {
    requests.push({ method, params });
    return {};
  };
  const app = appFor(client);

  app.handleInput("3");
  app.handleInput("m");
  assert.match(app.render(100).join("\n"), /AGENT MORE/);
  app.handleInput("\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.at(-1), {
    method: "agent.compact",
    params: { agentId: "owner", generation: 1 },
  });

  app.handleInput("m");
  app.handleInput("m");
  client.store.replace(snapshot(owner({ state: "working", generation: 2 })));
  app.invalidate();
  assert.doesNotMatch(app.render(100).join("\n"), /AGENT MORE/);
  app.dispose();
});

test("BrokerDeckApp Activity excludes active Signals updates and renders typed terminal details", () => {
  const client = clientFor(
    snapshot(
      owner(),
      projection({
        available: true,
        openCount: 0,
        items: [],
        view: {
          tabs: {
            updates: {
              rows: [
                { id: "active", title: "Live", state: "active" },
                { id: "done", title: "Done", state: "completed" },
              ],
              detailsById: {
                done: { detail: "typed terminal detail", revision: 4 },
              },
            },
            decisions: { rows: [] },
            history: { rows: [] },
          },
        },
      }),
    ),
  );
  const app = appFor(client);
  app.handleInput("4");
  const output = app.render(100).join("\n");
  assert.doesNotMatch(output, /Live/);
  assert.match(output, /Done/);
  assert.match(output, /typed terminal detail/);
  app.dispose();
});
