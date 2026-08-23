import assert from "node:assert/strict";
import test from "node:test";
import { BrokerDeckApp } from "../../src/deck/broker-app.js";
import { BrokerClient } from "../../src/deck/broker-client.js";
import { visibleSurfaceSignature } from "../../src/deck/render-dependencies.js";
import type { DeckSnapshot, DeckState } from "../../src/deck/types.js";
import type { Agent } from "../../src/state/types.js";
import type { ProviderProjection } from "../../src/shared/provider-projections.js";

function agent(generation = 1): Agent {
  return {
    id: "agent-1",
    state: "working",
    paneId: "pane-1",
    piSessionId: `session-${generation}`,
    connectionGeneration: generation,
  } as Agent;
}

function projection(overrides: Partial<ProviderProjection> = {}): ProviderProjection {
  return {
    ownerAgentId: "agent-1",
    piSessionId: "session-1",
    todo: { available: true, total: 1, completed: 0, items: [{ id: "todo-1", text: "Do work" }] },
    agentBoard: { available: true, openCount: 0, items: [] },
    files: { available: true, summary: { selected: 0 }, view: { rows: ["a.txt"] } },
    ...overrides,
  };
}

function state(provider = projection()): DeckState {
  return {
    seq: 1,
    agents: new Map([["agent-1", agent()]]),
    tasks: new Map(),
    runs: new Map(),
    workflows: new Map(),
    groups: new Map(),
    questions: new Map(),
    results: new Map(),
    providerProjections: new Map([["agent-1", provider]]),
  };
}

function snapshot(provider = projection(), owner = agent()): DeckSnapshot {
  return { seq: 1, agents: [owner], tasks: [], runs: [], workflows: [], groups: [], questions: [], results: [], providerProjections: [provider] };
}

test("Files signature ignores heartbeat, Todo, and Agent Board churn", () => {
  const context = { tab: "files", workView: "todo", targetPaneId: "pane-1" } as const;
  const baseline = visibleSurfaceSignature(state(), context);
  const changed = state(projection({
    todo: { available: true, total: 2, completed: 0, items: [{ id: "todo-2", text: "Other" }] },
    agentBoard: { available: true, openCount: 1, items: [{ id: "q", title: "Question" }] },
  }));
  changed.agents.set("agent-1", { ...agent(), heartbeatAt: "later" } as Agent);
  assert.equal(visibleSurfaceSignature(changed, context), baseline);
});

test("Files signature reacts to semantic Files and provider generation changes", () => {
  const context = { tab: "files", workView: "todo", targetPaneId: "pane-1" } as const;
  const baseline = visibleSurfaceSignature(state(), context);
  assert.notEqual(
    visibleSurfaceSignature(state(projection({ files: { available: true, view: { rows: ["b.txt"] } } })), context),
    baseline,
  );
  const replacement = state(projection({ piSessionId: "session-2" }));
  replacement.agents.set("agent-1", agent(2));
  assert.notEqual(visibleSurfaceSignature(replacement, context), baseline);
});

test("selected Work subview ignores data exclusive to another subview", () => {
  const base = state();
  const changed = state();
  changed.results.set("result-1", { id: "result-1", status: "accepted", summary: "done" });
  const todo = { tab: "work", workView: "todo", targetPaneId: "pane-1" } as const;
  assert.equal(visibleSurfaceSignature(changed, todo), visibleSurfaceSignature(base, todo));
  const results = { ...todo, workView: "results" } as const;
  assert.notEqual(visibleSurfaceSignature(changed, results), visibleSurfaceSignature(base, results));
});

test("BrokerDeckApp requests one render only for visible Files changes", () => {
  const client = new BrokerClient({ socketPath: "/tmp/render-gate-test.sock", secret: "test" });
  client.store.replace(snapshot());
  let renders = 0;
  const app = new BrokerDeckApp({ client, targetPaneId: "pane-1", requestRender: () => renders++, getHeight: () => 30 });
  app.handleInput("3");
  const baseline = renders;

  client.store.replace(snapshot(projection({ todo: { available: true, total: 2, completed: 0, items: [] } })));
  client.store.replace(snapshot(projection({ agentBoard: { available: true, openCount: 1, items: [{ id: "q", title: "Q" }] } })));
  assert.equal(renders, baseline);

  client.store.replace(snapshot(projection({ files: { available: true, view: { rows: ["changed.txt"] } } })));
  assert.equal(renders, baseline + 1);
  app.handleInput("2");
  assert.ok(renders > baseline + 1, "switching tabs renders immediately");
  app.dispose();
});
