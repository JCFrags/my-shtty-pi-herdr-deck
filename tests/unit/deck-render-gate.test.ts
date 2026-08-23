import assert from "node:assert/strict";
import test from "node:test";
import { BrokerDeckApp } from "../../src/deck/broker-app.js";
import { BrokerClient } from "../../src/deck/broker-client.js";
import { visibleSurfaceSignature } from "../../src/deck/render-dependencies.js";
import { selectAdoptedScope } from "../../src/deck/scope.js";
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

function projection(
  overrides: Partial<ProviderProjection> = {},
): ProviderProjection {
  return {
    ownerAgentId: "agent-1",
    piSessionId: "session-1",
    todo: {
      available: true,
      total: 1,
      completed: 0,
      items: [{ id: "todo-1", text: "Do work" }],
    },
    agentBoard: { available: true, openCount: 0, items: [] },
    files: {
      available: true,
      summary: { selected: 0 },
      view: { rows: ["a.txt"] },
    },
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
  return {
    seq: 1,
    agents: [owner],
    tasks: [],
    runs: [],
    workflows: [],
    groups: [],
    questions: [],
    results: [],
    providerProjections: [provider],
  };
}

const filesContext = {
  tab: "files",
  workView: "todo",
  targetPaneId: "pane-1",
} as const;

test("Files ignores heartbeat, same-owner state, provider peers, and broker churn", () => {
  const baseline = visibleSurfaceSignature(state(), filesContext);
  const changed = state(
    projection({
      todo: {
        available: true,
        total: 2,
        completed: 0,
        items: [{ id: "todo-2", text: "Other" }],
      },
      agentBoard: {
        available: true,
        openCount: 1,
        items: [{ id: "q", title: "Question" }],
      },
    }),
  );
  changed.agents.set("agent-1", {
    ...agent(),
    state: "idle",
    heartbeatAt: "later",
  } as Agent);
  changed.agents.set("other-root", {
    ...agent(),
    id: "other-root",
    paneId: "other-pane",
  } as Agent);
  changed.tasks.set("unrelated-task", {
    id: "unrelated-task",
    state: "running",
  } as never);
  changed.results.set("unrelated-result", {
    id: "unrelated-result",
    status: "accepted",
  });
  changed.questions.set("unrelated-question", {
    id: "unrelated-question",
    prompt: "Other",
  });
  changed.groups.set("unrelated-group", {
    id: "unrelated-group",
    state: "open",
  });
  assert.equal(visibleSurfaceSignature(changed, filesContext), baseline);
});

test("Files reacts to semantic data, availability, root existence, and provider generation", () => {
  const baseline = visibleSurfaceSignature(state(), filesContext);
  assert.notEqual(
    visibleSurfaceSignature(
      state(
        projection({ files: { available: true, view: { rows: ["b.txt"] } } }),
      ),
      filesContext,
    ),
    baseline,
  );
  assert.notEqual(
    visibleSurfaceSignature(
      state(projection({ files: { available: false, error: "offline" } })),
      filesContext,
    ),
    baseline,
  );
  const replacement = state(projection({ piSessionId: "session-2" }));
  replacement.agents.set("agent-1", agent(2));
  assert.notEqual(visibleSurfaceSignature(replacement, filesContext), baseline);
  const missing = state();
  missing.agents.clear();
  assert.notEqual(visibleSurfaceSignature(missing, filesContext), baseline);
});

test("adopted scope includes descendants and both task ownership routes", () => {
  const value = state();
  value.agents.set("child", {
    ...agent(),
    id: "child",
    parentAgentId: "agent-1",
  } as Agent);
  value.agents.set("other", {
    ...agent(),
    id: "other",
    paneId: "other-pane",
  } as Agent);
  value.runs.set("run-child", {
    id: "run-child",
    agentId: "child",
    state: "running",
  } as never);
  value.tasks.set("assigned", {
    id: "assigned",
    state: "running",
    assignedAgentId: "child",
  } as never);
  value.tasks.set("run-owned", {
    id: "run-owned",
    state: "running",
    currentRunId: "run-child",
  } as never);
  value.tasks.set("other-task", {
    id: "other-task",
    state: "running",
    assignedAgentId: "other",
  } as never);
  value.results.set("result", {
    id: "result",
    taskId: "run-owned",
    status: "accepted",
  });
  value.questions.set("question", {
    id: "question",
    taskId: "assigned",
    prompt: "Q",
  });
  value.groups.set("group", {
    id: "group",
    state: "open",
    taskIds: ["assigned"],
  });
  const scoped = selectAdoptedScope(value, "pane-1").state;
  assert.deepEqual([...scoped.agents.keys()].sort(), ["agent-1", "child"]);
  assert.deepEqual([...scoped.tasks.keys()].sort(), ["assigned", "run-owned"]);
  assert.deepEqual([...scoped.results.keys()], ["result"]);
  assert.deepEqual([...scoped.questions.keys()], ["question"]);
  assert.deepEqual([...scoped.groups.keys()], ["group"]);
});

test("Work surfaces isolate data exclusive to another subview", () => {
  const base = state();
  const changed = state();
  changed.results.set("result-1", {
    id: "result-1",
    status: "accepted",
    summary: "done",
  });
  const todo = {
    tab: "work",
    workView: "todo",
    targetPaneId: "pane-1",
  } as const;
  assert.equal(
    visibleSurfaceSignature(changed, todo),
    visibleSurfaceSignature(base, todo),
  );
  const groups = { ...todo, workView: "groups" } as const;
  assert.equal(
    visibleSurfaceSignature(changed, groups),
    visibleSurfaceSignature(base, groups),
  );
});

test("Home signature includes only the visible notification slice", () => {
  const context = {
    tab: "home",
    workView: "todo",
    targetPaneId: "pane-1",
  } as const;
  const first = [{ id: "n1", kind: "result" as const, text: "One", seq: 1 }];
  const baseline = visibleSurfaceSignature(state(), {
    ...context,
    notifications: first,
  });
  assert.notEqual(
    visibleSurfaceSignature(state(), { ...context, notifications: [] }),
    baseline,
  );
  const four = [1, 2, 3, 4].map((seq) => ({
    id: `n${seq}`,
    kind: "result" as const,
    text: String(seq),
    seq,
  }));
  assert.equal(
    visibleSurfaceSignature(state(), {
      ...context,
      notifications: [
        ...four,
        { id: "n5", kind: "result", text: "five", seq: 5 },
      ],
    }),
    visibleSurfaceSignature(state(), {
      ...context,
      notifications: [
        ...four,
        { id: "other", kind: "result", text: "other", seq: 99 },
      ],
    }),
  );
});

test("Inbox ignores broker questions and unselected provider-tab detail", () => {
  const provider = projection({
    agentBoard: {
      available: true,
      openCount: 1,
      items: [],
      view: {
        counts: { inbox: 1, updates: 1 },
        tabs: {
          inbox: { rows: [{ id: "q1" }], details: { q1: { text: "Visible" } } },
          updates: { rows: [{ id: "u1" }], details: { u1: { text: "Old" } } },
        },
      },
    },
  });
  const base = state(provider);
  const context = {
    tab: "inbox",
    workView: "todo",
    targetPaneId: "pane-1",
    boardTab: "inbox",
    boardSelectionId: "q1",
  } as const;
  const baseline = visibleSurfaceSignature(base, context);
  base.questions.set("broker", { id: "broker", prompt: "Broker only" });
  const view = structuredClone(provider.agentBoard.view) as any;
  view.tabs.updates.details.u1.text = "New";
  provider.agentBoard.view = view;
  assert.equal(visibleSurfaceSignature(base, context), baseline);
});

test("BrokerDeckApp render counter gates Files changes and tab switching", () => {
  const client = new BrokerClient({
    socketPath: "/tmp/render-gate-test.sock",
    secret: "test",
  });
  client.store.replace(snapshot());
  let renders = 0;
  const app = new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => renders++,
    getHeight: () => 30,
  });
  app.handleInput("3");
  const baseline = renders;
  client.store.replace(
    snapshot(
      projection({
        todo: { available: true, total: 2, completed: 0, items: [] },
      }),
    ),
  );
  client.store.replace(
    snapshot(
      projection({
        agentBoard: {
          available: true,
          openCount: 1,
          items: [{ id: "q", title: "Q" }],
        },
      }),
    ),
  );
  client.store.replace(
    snapshot(projection(), {
      ...agent(),
      state: "idle",
      heartbeatAt: "later",
    } as Agent),
  );
  assert.equal(renders, baseline);
  client.store.replace(
    snapshot(
      projection({
        files: { available: true, view: { rows: ["changed.txt"] } },
      }),
    ),
  );
  assert.equal(renders, baseline + 1);
  app.handleInput("2");
  assert.ok(renders > baseline + 1);
  app.dispose();
});
