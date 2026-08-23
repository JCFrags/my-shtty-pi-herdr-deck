import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@pi-herdr-deck/tui";
import { BrokerClient } from "../../src/deck/broker-client.js";
import { BrokerDeckApp } from "../../src/deck/broker-app.js";
import type { DeckSnapshot } from "../../src/deck/types.js";
import type { Agent } from "../../src/state/types.js";
import type { ProviderProjection } from "../../src/shared/provider-projections.js";

const owner: Agent = {
  id: "owner",
  state: "working",
  paneId: "pane-1",
  piSessionId: "session-1",
  connectionGeneration: 1,
  displayName: "Owner",
} as Agent;

const provider = (
  rows: unknown[] = [{ path: "src", name: "src", kind: "directory" }],
): ProviderProjection => ({
  ownerAgentId: "owner",
  piSessionId: "session-1",
  todo: { available: true, total: 0, completed: 0, items: [] },
  agentBoard: { available: true, openCount: 0, items: [] },
  files: {
    available: true,
    summary: { cwd: "/repo", selectedCount: 0 },
    view: { rows },
  },
});

const snapshot = (projection = provider()): DeckSnapshot => ({
  seq: 1,
  agents: [owner],
  tasks: [],
  runs: [],
  workflows: [],
  groups: [],
  questions: [],
  results: [],
  providerProjections: [projection],
});

function appFor(
  client: BrokerClient,
  requestRender: () => void = () => undefined,
): BrokerDeckApp {
  return new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender,
    getHeight: () => 40,
  });
}

test("BrokerDeckApp integrates the four typed surfaces at every supported width", () => {
  const client = new BrokerClient({
    socketPath: "/tmp/final-render-surfaces.sock",
    secret: "test",
  });
  client.store.replace(snapshot());
  const app = appFor(client);
  for (const width of [50, 70, 78, 80, 100, 120]) {
    for (const tab of ["1", "2", "3", "4"]) {
      app.handleInput(tab);
      const lines = app.render(width);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `${tab} at ${width}`,
      );
    }
  }
  app.handleInput("2");
  assert.match(app.render(120).join("\n"), /PREVIEW/);
  app.handleInput("3");
  assert.match(app.render(120).join("\n"), /AGENT DETAIL/);
  app.handleInput("4");
  assert.match(app.render(120).join("\n"), /DETAIL/);
  app.dispose();
});

test("BrokerDeckApp render gate ignores provider churn but reacts to visible body and shell changes", () => {
  let renders = 0;
  const client = new BrokerClient({
    socketPath: "/tmp/final-render-gate.sock",
    secret: "test",
  });
  client.store.replace(snapshot());
  const app = appFor(client, () => renders++);
  app.handleInput("2");
  const baseline = renders;

  client.store.replace(
    snapshot({
      ...provider(),
      todo: {
        available: true,
        total: 1,
        completed: 0,
        items: [{ id: "todo", text: "other" }],
      },
    }),
  );
  const afterTodo = renders;
  assert.ok(afterTodo === baseline || afterTodo === baseline + 1);

  client.store.replace(
    snapshot(
      provider([{ path: "src/main.ts", name: "main.ts", kind: "file" }]),
    ),
  );
  assert.equal(renders, afterTodo + 1);
  const afterBody = renders;

  client.store.replace(
    snapshot({
      ...provider(),
      agentBoard: {
        available: true,
        openCount: 1,
        items: [{ id: "q", title: "Question" }],
      },
    }),
  );
  assert.equal(renders, afterBody + 1);

  app.handleInput("?");
  const overlayBaseline = renders;
  client.store.replace(
    snapshot({
      ...provider([
        { path: "different.ts", name: "different.ts", kind: "file" },
      ]),
      agentBoard: {
        available: true,
        openCount: 1,
        items: [{ id: "q", title: "Question" }],
      },
    }),
  );
  assert.equal(renders, overlayBaseline);
  app.dispose();
});
