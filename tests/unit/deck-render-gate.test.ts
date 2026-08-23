import assert from "node:assert/strict";
import test from "node:test";
import type { TuiMouseEvent } from "@pi-herdr-deck/tui";
import { BrokerDeckApp } from "../../src/deck/broker-app.js";
import { BrokerClient } from "../../src/deck/broker-client.js";
import { visibleSurfaceSignature } from "../../src/deck/render-dependencies.js";
import { selectAdoptedScope } from "../../src/deck/scope.js";
import { selectBoardPresentation } from "../../src/deck/board-presentation.js";
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

function clickLabel(app: BrokerDeckApp, label: string): void {
  const lines = app.render(120);
  const y = lines.findIndex((line) => line.includes(label));
  assert.notEqual(y, -1);
  const x = lines[y]!.indexOf(label) + 1;
  const event = (type: "press" | "release"): TuiMouseEvent => ({
    type,
    button: "left",
    x,
    y,
    shift: false,
    alt: false,
    ctrl: false,
  });
  app.handleMouse(event("press"));
  app.handleMouse(event("release"));
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

test("authoritative provider selects the newest same-pane root and descendants", () => {
  const value = state();
  value.agents.clear();
  value.providerProjections.clear();
  const old = { ...agent(1), id: "old", piSessionId: "old-session" } as Agent;
  const newest = {
    ...agent(2),
    id: "new",
    piSessionId: "new-session",
  } as Agent;
  value.agents.set("old", old);
  value.agents.set("new", newest);
  value.agents.set("old-child", {
    ...agent(),
    id: "old-child",
    parentAgentId: "old",
  } as Agent);
  value.agents.set("new-child", {
    ...agent(),
    id: "new-child",
    parentAgentId: "new",
  } as Agent);
  value.providerProjections.set(
    "old",
    projection({ ownerAgentId: "old", piSessionId: "old-session" }),
  );
  value.providerProjections.set(
    "new",
    projection({ ownerAgentId: "new", piSessionId: "new-session" }),
  );
  const scope = selectAdoptedScope(value, "pane-1");
  assert.equal(scope.rootAgentId, "new");
  assert.deepEqual([...scope.state.agents.keys()].sort(), ["new", "new-child"]);
});

test("implicit Work selections include displayed detail but ignore unselected detail", () => {
  const value = state();
  value.tasks.set("a", {
    id: "a",
    state: "running",
    title: "A",
    assignedAgentId: "agent-1",
    objective: "first",
  } as never);
  value.tasks.set("b", {
    id: "b",
    state: "running",
    title: "B",
    assignedAgentId: "agent-1",
    objective: "other",
  } as never);
  const context = {
    tab: "work",
    workView: "tasks",
    targetPaneId: "pane-1",
  } as const;
  const baseline = visibleSurfaceSignature(value, context);
  const selectedChange = structuredClone(value.tasks.get("a")) as any;
  selectedChange.objective = "changed";
  value.tasks.set("a", selectedChange);
  assert.notEqual(visibleSurfaceSignature(value, context), baseline);
  const afterSelected = visibleSurfaceSignature(value, context);
  const unrelated = structuredClone(value.tasks.get("b")) as any;
  unrelated.objective = "hidden change";
  value.tasks.set("b", unrelated);
  assert.equal(visibleSurfaceSignature(value, context), afterSelected);
});

test("implicit result, group, and agent details are selected deterministically", () => {
  const value = state();
  value.results.set("a-result", {
    id: "a-result",
    status: "accepted",
    summary: "first",
    taskId: "task",
  });
  value.results.set("b-result", {
    id: "b-result",
    status: "accepted",
    summary: "second",
    taskId: "task",
  });
  value.groups.set("a-group", {
    id: "a-group",
    state: "open",
    agentIds: ["agent-1"],
    objective: "first",
  });
  value.groups.set("b-group", {
    id: "b-group",
    state: "open",
    agentIds: ["agent-1"],
    objective: "second",
  });
  value.runs.set("run", {
    id: "run",
    agentId: "agent-1",
    taskId: "task",
    state: "running",
  } as never);
  value.tasks.set("task", {
    id: "task",
    title: "Task",
    state: "running",
    currentRunId: "run",
    objective: "agent detail",
  } as never);
  value.agents.set("agent-1", { ...agent(), currentRunId: "run" } as Agent);
  value.questions.set("question", {
    id: "question",
    taskId: "task",
    prompt: "First question",
  });
  const resultContext = {
    tab: "work",
    workView: "results",
    targetPaneId: "pane-1",
  } as const;
  const groupContext = {
    tab: "work",
    workView: "groups",
    targetPaneId: "pane-1",
  } as const;
  const agentContext = {
    tab: "agents",
    workView: "todo",
    targetPaneId: "pane-1",
    agentFilter: "active",
  } as const;
  const resultBase = visibleSurfaceSignature(value, resultContext);
  value.results.set("a-result", {
    ...value.results.get("a-result")!,
    evidence: ["changed"],
  });
  assert.notEqual(visibleSurfaceSignature(value, resultContext), resultBase);
  const groupBase = visibleSurfaceSignature(value, groupContext);
  value.groups.set("a-group", {
    ...value.groups.get("a-group")!,
    objective: "changed",
  });
  assert.notEqual(visibleSurfaceSignature(value, groupContext), groupBase);
  const agentBase = visibleSurfaceSignature(value, agentContext);
  value.questions.set("question", {
    ...value.questions.get("question")!,
    prompt: "Changed question",
  });
  assert.notEqual(visibleSurfaceSignature(value, agentContext), agentBase);
});

test("removing an explicit selection falls back to the first scoped item", () => {
  const value = state();
  value.tasks.set("a", {
    id: "a",
    title: "A",
    state: "running",
    assignedAgentId: "agent-1",
  } as never);
  value.tasks.set("b", {
    id: "b",
    title: "B",
    state: "running",
    assignedAgentId: "agent-1",
  } as never);
  const context = {
    tab: "work",
    workView: "tasks",
    targetPaneId: "pane-1",
    selectedTaskId: "b",
  } as const;
  const baseline = visibleSurfaceSignature(value, context);
  value.tasks.delete("b");
  assert.notEqual(visibleSurfaceSignature(value, context), baseline);
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

test("wrapped and unwrapped Board payloads normalize identically", () => {
  const model = {
    tabCounts: { inbox: 1, updates: 2 },
    tabs: {
      inbox: {
        rows: [{ id: "q1", revision: 3 }],
        detailsById: { q1: { text: "Detail" } },
      },
    },
  };
  const base = { available: true, openCount: 1, items: [], view: model };
  const wrapped = { ...base, view: { view: model } };
  assert.deepEqual(
    selectBoardPresentation(base, "inbox"),
    selectBoardPresentation(wrapped, "inbox"),
  );
});

test("Inbox ignores broker questions and unselected provider-tab detail", () => {
  const provider = projection({
    agentBoard: {
      available: true,
      openCount: 1,
      items: [],
      view: {
        view: {
          tabCounts: { inbox: 1, updates: 1 },
          tabs: {
            inbox: {
              rows: [{ id: "q1" }],
              detailsById: { q1: { text: "Visible" } },
            },
            updates: {
              rows: [{ id: "u1" }],
              detailsById: { u1: { text: "Old" } },
            },
          },
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
  view.view.tabs.updates.detailsById.u1.text = "New";
  provider.agentBoard.view = view;
  assert.equal(visibleSurfaceSignature(base, context), baseline);
});

test("Board visible counts, selected detail, flags, and pending response are dependencies", () => {
  const board = {
    available: true,
    openCount: 1,
    items: [],
    pendingQuestions: [
      {
        questionId: "q1",
        revision: 1,
        question: "Choose",
        response: {
          kind: "single" as const,
          options: [{ id: "yes", label: "Yes" }],
        },
        recommendedOptionIds: ["yes"],
      },
    ],
    view: {
      view: {
        tabCounts: { inbox: 1, updates: 0 },
        tabs: {
          inbox: {
            rows: [{ id: "q1", revision: 1, userAnswerable: true }],
            detailsById: { q1: { text: "Detail" } },
          },
        },
      },
    },
  };
  const context = {
    tab: "inbox",
    workView: "todo",
    targetPaneId: "pane-1",
    boardTab: "inbox",
  } as const;
  const baseline = visibleSurfaceSignature(
    state(projection({ agentBoard: board })),
    context,
  );
  const count = structuredClone(board);
  count.view.view.tabCounts.updates = 1;
  assert.notEqual(
    visibleSurfaceSignature(state(projection({ agentBoard: count })), context),
    baseline,
  );
  const detail = structuredClone(board);
  detail.view.view.tabs.inbox.detailsById.q1.text = "Changed";
  assert.notEqual(
    visibleSurfaceSignature(state(projection({ agentBoard: detail })), context),
    baseline,
  );
  const flag = structuredClone(board);
  flag.view.view.tabs.inbox.rows[0]!.userAnswerable = false;
  assert.notEqual(
    visibleSurfaceSignature(state(projection({ agentBoard: flag })), context),
    baseline,
  );
  const response = structuredClone(board);
  response.pendingQuestions[0]!.recommendedOptionIds = [];
  assert.notEqual(
    visibleSurfaceSignature(
      state(projection({ agentBoard: response })),
      context,
    ),
    baseline,
  );
});

test("BrokerDeckApp tracks the implicitly selected scoped task detail", () => {
  const client = new BrokerClient({
    socketPath: "/tmp/render-task-gate.sock",
    secret: "test",
  });
  const tasks = [
    {
      id: "a",
      title: "A",
      state: "running",
      assignedAgentId: "agent-1",
      objective: "first",
    },
    {
      id: "b",
      title: "B",
      state: "running",
      assignedAgentId: "agent-1",
      objective: "second",
    },
  ] as any[];
  client.store.replace({ ...snapshot(), tasks });
  let renders = 0;
  const app = new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => renders++,
    getHeight: () => 40,
  });
  app.handleInput("2");
  clickLabel(app, "Tasks");
  const baseline = renders;
  client.store.replace({
    ...snapshot(),
    tasks: [{ ...tasks[0], objective: "changed" }, tasks[1]] as never[],
  });
  assert.equal(renders, baseline + 1);
  const changed = renders;
  client.store.replace({
    ...snapshot(),
    tasks: [
      { ...tasks[0], objective: "changed" },
      { ...tasks[1], objective: "hidden" },
    ] as never[],
  });
  assert.equal(renders, changed);
  app.dispose();
});

test("BrokerDeckApp wheel movement synchronizes the selected-task baseline", () => {
  const client = new BrokerClient({
    socketPath: "/tmp/render-wheel-gate.sock",
    secret: "test",
  });
  const tasks = [
    {
      id: "a",
      title: "A",
      state: "running",
      assignedAgentId: "agent-1",
      objective: "first",
    },
    {
      id: "b",
      title: "B",
      state: "running",
      assignedAgentId: "agent-1",
      objective: "second",
    },
  ] as any[];
  client.store.replace({ ...snapshot(), tasks });
  let renders = 0;
  const app = new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => renders++,
    getHeight: () => 40,
  });
  app.handleInput("2");
  clickLabel(app, "Tasks");
  app.handleMouse({
    type: "wheel",
    direction: "down",
    x: 1,
    y: 1,
    shift: false,
    alt: false,
    ctrl: false,
  });
  const baseline = renders;
  client.store.replace({
    ...snapshot(),
    tasks: [{ ...tasks[0], objective: "old changed" }, tasks[1]] as never[],
  });
  assert.equal(renders, baseline);
  client.store.replace({
    ...snapshot(),
    tasks: [
      { ...tasks[0], objective: "old changed" },
      { ...tasks[1], objective: "selected changed" },
    ] as never[],
  });
  assert.equal(renders, baseline + 1);
  app.dispose();
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
