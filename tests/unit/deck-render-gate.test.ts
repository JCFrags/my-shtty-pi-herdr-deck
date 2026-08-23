import assert from "node:assert/strict";
import test from "node:test";
import type { TuiMouseEvent } from "@pi-herdr-deck/tui";
import { BrokerDeckApp } from "../../src/deck/broker-app.js";
import { renderButton } from "../../src/deck/components/controls.js";
import { BrokerClient } from "../../src/deck/broker-client.js";
import { visibleSurfaceSignature } from "../../src/deck/render-dependencies.js";
import {
  currentProviderProjection,
  selectAdoptedRootAgent,
  selectAdoptedScope,
} from "../../src/deck/scope.js";
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
  const y = lines.findLastIndex((line) => line.includes(label));
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

test("provider authority requires one logical pane when no target is supplied", () => {
  const single = state();
  assert.equal(currentProviderProjection(single)?.ownerAgentId, "agent-1");

  const differentPanes = state();
  differentPanes.agents.set("agent-2", {
    ...agent(9),
    id: "agent-2",
    paneId: "pane-2",
  } as Agent);
  differentPanes.providerProjections.set(
    "agent-2",
    projection({ ownerAgentId: "agent-2", piSessionId: "session-9" }),
  );
  assert.equal(currentProviderProjection(differentPanes), undefined);
  assert.equal(selectAdoptedRootAgent(differentPanes), undefined);
  const ambiguousScope = selectAdoptedScope(differentPanes);
  assert.equal(ambiguousScope.rootAgentId, undefined);
  assert.equal(ambiguousScope.rootExists, false);
  assert.equal(ambiguousScope.state.agents.size, 0);

  assert.equal(
    currentProviderProjection(differentPanes, "pane-1")?.ownerAgentId,
    "agent-1",
  );

  const samePane = state();
  samePane.agents.set("agent-2", {
    ...agent(2),
    id: "agent-2",
  } as Agent);
  samePane.providerProjections.set(
    "agent-2",
    projection({ ownerAgentId: "agent-2", piSessionId: "session-2" }),
  );
  assert.equal(currentProviderProjection(samePane)?.ownerAgentId, "agent-2");

  const unidentified = state();
  unidentified.agents.set("agent-1", {
    ...agent(),
    paneId: undefined,
  } as unknown as Agent);
  unidentified.agents.set("agent-2", {
    ...agent(2),
    id: "agent-2",
    paneId: undefined,
  } as unknown as Agent);
  unidentified.providerProjections.set(
    "agent-2",
    projection({ ownerAgentId: "agent-2", piSessionId: "session-2" }),
  );
  assert.equal(currentProviderProjection(unidentified), undefined);
});

test("terminal sole provider owners fail closed", () => {
  for (const terminal of ["closed", "stopped"] as const) {
    const value = state();
    value.agents.set("agent-1", { ...agent(), state: terminal } as Agent);
    assert.equal(currentProviderProjection(value), undefined);
    assert.equal(selectAdoptedRootAgent(value), undefined);
  }
  assert.equal(currentProviderProjection(state())?.ownerAgentId, "agent-1");
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

test("task detail tracks exact resultId and deterministic displayed question only", () => {
  const value = state();
  value.tasks.set("task", {
    id: "task",
    title: "Task",
    state: "running",
    assignedAgentId: "agent-1",
    resultId: "z-result",
  } as never);
  value.results.set("a-result", {
    id: "a-result",
    taskId: "task",
    status: "accepted",
    summary: "not displayed",
  });
  value.results.set("z-result", {
    id: "z-result",
    taskId: "task",
    status: "accepted",
    summary: "displayed",
  });
  value.questions.set("a-question", {
    id: "a-question",
    taskId: "task",
    prompt: "displayed",
  });
  value.questions.set("z-question", {
    id: "z-question",
    taskId: "task",
    prompt: "not displayed",
  });
  const context = {
    tab: "work",
    workView: "tasks",
    targetPaneId: "pane-1",
  } as const;
  const baseline = visibleSurfaceSignature(value, context);
  value.results.set("a-result", {
    ...value.results.get("a-result")!,
    summary: "hidden changed",
  });
  value.questions.set("z-question", {
    ...value.questions.get("z-question")!,
    prompt: "hidden changed",
  });
  assert.equal(visibleSurfaceSignature(value, context), baseline);
  value.results.set("z-result", {
    ...value.results.get("z-result")!,
    summary: "shown changed",
  });
  assert.notEqual(visibleSurfaceSignature(value, context), baseline);
  const resultChanged = visibleSurfaceSignature(value, context);
  value.questions.set("a-question", {
    ...value.questions.get("a-question")!,
    prompt: "shown changed",
  });
  assert.notEqual(visibleSurfaceSignature(value, context), resultChanged);
});

test("History dependencies match visible task and result rows", () => {
  const value = state();
  value.tasks.set("running", {
    id: "running",
    title: "Visible",
    state: "running",
    assignedAgentId: "agent-1",
    objective: "hidden",
  } as never);
  value.results.set("result", {
    id: "result",
    taskId: "running",
    status: "accepted",
    summary: "visible",
  });
  const context = {
    tab: "work",
    workView: "history",
    targetPaneId: "pane-1",
  } as const;
  const baseline = visibleSurfaceSignature(value, context);
  value.tasks.set("running", {
    ...value.tasks.get("running")!,
    objective: "hidden changed",
  });
  assert.equal(visibleSurfaceSignature(value, context), baseline);
  value.tasks.set("running", {
    ...value.tasks.get("running")!,
    title: "Visible changed",
  });
  assert.notEqual(visibleSurfaceSignature(value, context), baseline);
  const taskChanged = visibleSurfaceSignature(value, context);
  value.results.set("result", {
    ...value.results.get("result")!,
    summary: "result changed",
  });
  assert.notEqual(visibleSurfaceSignature(value, context), taskChanged);
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

test("Board answer keyboard action follows the visible provider tab", () => {
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
        tabCounts: { inbox: 1, updates: 1 },
        tabs: {
          inbox: { rows: [{ id: "q1", revision: 1, userAnswerable: true }] },
          updates: { rows: [{ id: "u1", title: "Update" }] },
        },
      },
    },
  };
  const client = new BrokerClient({
    socketPath: "/tmp/board-tab-action.sock",
    secret: "test",
  });
  client.store.replace(snapshot(projection({ agentBoard: board })));
  const app = new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => undefined,
    getHeight: () => 40,
  });
  app.handleInput("a");
  assert.match(app.render(120).join("\n"), /BOARD-ANSWER:/);
  app.dispose();
});

test("BrokerDeckApp tracks fallback Files standalone availability only", () => {
  const client = new BrokerClient({
    socketPath: "/tmp/files-fallback-authority.sock",
    secret: "test",
  });
  const empty = {
    ...snapshot(),
    agents: [],
    providerProjections: [],
  };
  client.store.replace(empty);
  let renders = 0;
  const app = new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => renders++,
    getHeight: () => 40,
  });
  app.handleInput("2");
  assert.ok(
    app
      .render(120)
      .join("\n")
      .includes(renderButton("Open standalone view", { disabled: true })),
  );

  const fallback = agent();
  let baseline = renders;
  client.store.replace({ ...empty, agents: [fallback] });
  assert.equal(renders, baseline + 1);
  assert.ok(
    app
      .render(120)
      .join("\n")
      .includes(renderButton("Open standalone view", { disabled: false })),
  );

  baseline = renders;
  client.store.replace({
    ...empty,
    agents: [{ ...fallback, state: "idle" } as Agent],
  });
  assert.equal(renders, baseline);
  const unrelated = {
    ...agent(),
    id: "other",
    paneId: "pane-2",
  } as Agent;
  client.store.replace({
    ...empty,
    agents: [{ ...fallback, state: "idle" } as Agent, unrelated],
  });
  assert.equal(renders, baseline);

  client.store.replace({ ...empty, agents: [unrelated] });
  assert.equal(renders, baseline + 1);
  assert.ok(
    app
      .render(120)
      .join("\n")
      .includes(renderButton("Open standalone view", { disabled: true })),
  );

  baseline = renders;
  const owner = { ...fallback, state: "working" } as Agent;
  const filesProvider = projection();
  client.store.replace({
    ...empty,
    agents: [owner, unrelated],
    providerProjections: [filesProvider],
  });
  assert.equal(renders, baseline + 1);
  baseline = renders;
  client.store.replace({
    ...empty,
    agents: [owner, unrelated],
    providerProjections: [
      projection({
        todo: {
          available: true,
          total: 2,
          completed: 0,
          items: [{ id: "todo-2", text: "Other" }],
        },
      }),
    ],
  });
  assert.equal(renders, baseline);
  client.store.replace({
    ...empty,
    agents: [owner, unrelated],
    providerProjections: [
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
          items: [{ id: "question", title: "Question" }],
        },
      }),
    ],
  });
  assert.equal(renders, baseline);
  app.dispose();
});

test("BrokerDeckApp leaves Files unbound when no-target authority is ambiguous", () => {
  const first = agent();
  const second = {
    ...agent(2),
    id: "agent-2",
    paneId: "pane-2",
  } as Agent;
  const client = new BrokerClient({
    socketPath: "/tmp/files-ambiguous-authority.sock",
    secret: "test",
  });
  client.store.replace({
    ...snapshot(),
    agents: [first, second],
    providerProjections: [
      projection(),
      projection({ ownerAgentId: "agent-2", piSessionId: "session-2" }),
    ],
  });
  const app = new BrokerDeckApp({
    client,
    requestRender: () => undefined,
    getHeight: () => 40,
  });
  app.handleInput("2");
  const output = app.render(120).join("\n");
  assert.match(output, /○ CONNECTING/);
  assert.ok(
    output.includes(renderButton("Open standalone view", { disabled: true })),
  );
  app.dispose();
});

test("BrokerDeckApp uses the first displayed agent for inspector and dependencies", () => {
  const client = new BrokerClient({
    socketPath: "/tmp/render-agent-gate.sock",
    secret: "test",
  });
  const owner = {
    ...agent(),
    id: "z-agent",
    displayName: "Zulu",
    closeReason: "selected old",
  } as Agent;
  const child = {
    ...agent(),
    id: "a-agent",
    displayName: "Alpha",
    parentAgentId: "z-agent",
    closeReason: "other old",
  } as Agent;
  const provider = projection({ ownerAgentId: "z-agent" });
  client.store.replace({
    ...snapshot(provider, owner),
    agents: [owner, child],
  });
  let renders = 0;
  const app = new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => renders++,
    getHeight: () => 40,
  });
  app.handleInput("3");
  const output = app.render(120).join("\n");
  assert.match(output, />.*Zulu/);
  assert.match(output, /Identity: z-agent/);
  const baseline = renders;
  client.store.replace({
    ...snapshot(provider, owner),
    agents: [{ ...owner, closeReason: "selected changed" }, child] as Agent[],
  });
  assert.equal(renders, baseline + 1);
  const afterSelected = renders;
  client.store.replace({
    ...snapshot(provider, owner),
    agents: [
      { ...owner, closeReason: "selected changed" },
      { ...child, closeReason: "other changed" },
    ] as Agent[],
  });
  assert.equal(renders, afterSelected);
  app.dispose();
});

test("BrokerDeckApp clamps an invalid agent page after scope shrink", () => {
  const owner = { ...agent(), id: "z-owner", displayName: "Owner" } as Agent;
  const provider = projection({ ownerAgentId: "z-owner" });
  const children = Array.from(
    { length: 13 },
    (_, index) =>
      ({
        ...agent(),
        id: `child-${String(index).padStart(2, "0")}`,
        displayName: `Child ${index}`,
        parentAgentId: "z-owner",
      }) as Agent,
  );
  const client = new BrokerClient({
    socketPath: "/tmp/agent-page-clamp.sock",
    secret: "test",
  });
  client.store.replace({
    ...snapshot(provider, owner),
    agents: [owner, ...children],
  });
  let renders = 0;
  const app = new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => renders++,
    getHeight: () => 50,
  });
  app.handleInput("3");
  for (let index = 0; index < 12; index++) app.handleInput("j");
  const baseline = renders;
  client.store.replace({
    ...snapshot(provider, owner),
    agents: [owner, children[0]!],
  });
  assert.equal(renders, baseline + 1);
  const output = app.render(120).join("\n");
  assert.match(output, /page 1\/1/);
  assert.match(output, /Identity: z-owner/);
  app.dispose();
});

test("BrokerDeckApp action targets match scoped displayed entities", () => {
  const owner = { ...agent(), id: "z-agent", displayName: "Zulu" } as Agent;
  const other = { ...agent(), id: "other-root", paneId: "other-pane" } as Agent;
  const provider = projection({ ownerAgentId: "z-agent" });
  const scopedTask = {
    id: "z-task",
    title: "Scoped task",
    state: "running",
    assignedAgentId: "z-agent",
  } as never;
  const outsideTask = {
    id: "a-task",
    title: "Outside",
    state: "running",
    assignedAgentId: "other-root",
  } as never;
  const scopedGroup = {
    id: "z-group",
    name: "Scoped group",
    state: "open",
    agentIds: ["z-agent"],
  };
  const outsideGroup = {
    id: "a-group",
    name: "Outside",
    state: "open",
    agentIds: ["other-root"],
  };
  const client = new BrokerClient({
    socketPath: "/tmp/scoped-action-target.sock",
    secret: "test",
  });
  client.store.replace({
    ...snapshot(provider, owner),
    agents: [owner, other],
    tasks: [outsideTask, scopedTask],
    groups: [outsideGroup, scopedGroup],
  });
  const captured: Array<{ action: string; target: any }> = [];
  const app = new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => undefined,
    getHeight: () => 40,
    onActionTarget: (action, target) => captured.push({ action, target }),
  });
  clickLabel(app, "Scoped task");
  clickLabel(app, "Cancel task");
  clickLabel(app, "Cancel task");
  assert.equal(
    captured.find((item) => item.action === "cancelTask")?.target.task.id,
    "z-task",
  );
  clickLabel(app, "Scoped group");
  clickLabel(app, "Wait group");
  assert.equal(
    captured.find((item) => item.action === "groupWait")?.target.group.id,
    "z-group",
  );
  app.handleInput("3");
  clickLabel(app, "Focus");
  assert.equal(
    captured.find((item) => item.action === "focus")?.target.agent.id,
    "z-agent",
  );
  app.dispose();
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
  app.handleInput("2");
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
  app.handleInput("1");
  assert.ok(renders > baseline + 1);
  app.dispose();
});

test("Files mouse regions keep preview, selection, and expansion distinct", async () => {
  const files = {
    available: true,
    summary: { cwd: "/repo", selectedCount: 0 },
    view: {
      currentPath: ".",
      rows: [
        {
          path: "src",
          name: "src",
          kind: "directory",
          depth: 0,
          expanded: false,
        },
        {
          path: "src/app.ts",
          name: "app.ts",
          kind: "file",
          depth: 1,
          selected: false,
        },
      ],
      preview: {
        lines: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`),
      },
    },
  };
  const client = new BrokerClient({
    socketPath: "/tmp/files-mouse-regions.sock",
    secret: "test",
  });
  client.store.replace(snapshot(projection({ files })));
  const requests: Array<{ method: string; params: any }> = [];
  (client as any).request = async (method: string, params: unknown) => {
    requests.push({ method, params });
    return {};
  };
  const app = new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => undefined,
    getHeight: () => 30,
  });
  app.handleInput("2");
  const click = (x: number, y: number) => {
    for (const type of ["press", "release"] as const)
      app.handleMouse({
        type,
        button: "left",
        x,
        y,
        shift: false,
        alt: false,
        ctrl: false,
      });
  };

  let lines = app.render(120);
  const fileY = lines.findIndex((line) => line.includes("app.ts"));
  assert.ok(fileY >= 0);
  click(lines[fileY]!.indexOf("app.ts"), fileY);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1)?.params.action, "preview");
  assert.equal(requests.at(-1)?.params.path, "src/app.ts");

  lines = app.render(120);
  const selectedFileY = lines.findIndex((line) => line.includes("app.ts"));
  click(lines[selectedFileY]!.indexOf("[ ") + 1, selectedFileY);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1)?.params.action, "toggle-selection");
  assert.equal(requests.at(-1)?.params.path, "src/app.ts");

  lines = app.render(120);
  const folderY = lines.findIndex(
    (line) => line.includes("src") && line.includes("▸"),
  );
  click(lines[folderY]!.indexOf("▸"), folderY);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1)?.params.action, "expand");
  assert.equal(requests.at(-1)?.params.path, "src");

  lines = app.render(120);
  const previewY = lines.findIndex((line) => line.includes("line 1"));
  app.handleMouse({
    type: "wheel",
    direction: "down",
    x: 2,
    y: previewY,
    shift: false,
    alt: false,
    ctrl: false,
  });
  const scrolled = app.render(120).join("\n");
  assert.match(scrolled, /line 2/);
  assert.doesNotMatch(scrolled, /\nline 1\n/);
  assert.match(scrolled, /app\.ts/);
  app.dispose();
});

test("Board combines and acts on Signals questions, updates, and recommendations", async () => {
  const board = {
    available: true,
    openCount: 1,
    items: [{ id: "q1", title: "Question" }],
    view: {
      view: {
        tabCounts: { inbox: 1, updates: 1, decisions: 1 },
        tabs: {
          inbox: {
            rows: [{ id: "q1", title: "Question", userAnswerable: true }],
          },
          updates: { rows: [{ id: "u1", title: "Progress update" }] },
          decisions: { rows: [{ id: "d1", title: "Prefer the cache" }] },
        },
      },
    },
  };
  const client = new BrokerClient({
    socketPath: "/tmp/board-combined-signals.sock",
    secret: "test",
  });
  client.store.replace(snapshot(projection({ agentBoard: board })));
  const requests: Array<{ method: string; params: any }> = [];
  (client as any).request = async (method: string, params: unknown) => {
    requests.push({ method, params });
    return {};
  };
  const app = new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => undefined,
    getHeight: () => 40,
  });
  let output = app.render(120).join("\n");
  assert.match(output, /Question/);
  assert.match(output, /Progress update/);
  assert.match(output, /Prefer the cache/);
  clickLabel(app, "Progress update");
  output = app.render(120).join("\n");
  assert.match(output, /DETAIL  SIGNAL-UPDATE/);
  assert.ok(output.includes(renderButton("Answer", { disabled: true })));
  clickLabel(app, "Prefer the cache");
  clickLabel(app, "Use recommendation");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1)?.method, "provider.agent_board_action");
  assert.equal(requests.at(-1)?.params.action, "accept-recommendation");
  assert.equal(requests.at(-1)?.params.questionId, "d1");
  app.dispose();
});

test("Activity keeps keyboard-selected history inside its visible viewport", () => {
  const owner = agent();
  const results = Array.from({ length: 16 }, (_, index) => ({
    id: `result-${String(index).padStart(2, "0")}`,
    taskId: `task-${String(index).padStart(2, "0")}`,
    status: "accepted",
    summary: `Historical result ${index}`,
  })) as never[];
  const tasks = Array.from({ length: 16 }, (_, index) => ({
    id: `task-${String(index).padStart(2, "0")}`,
    title: `Completed task ${index}`,
    state: "completed",
    assignedAgentId: owner.id,
  })) as never[];
  const client = new BrokerClient({
    socketPath: "/tmp/activity-scroll.sock",
    secret: "test",
  });
  client.store.replace({ ...snapshot(), agents: [owner], tasks, results });
  const app = new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => undefined,
    getHeight: () => 18,
  });
  app.handleInput("4");
  for (let index = 0; index < 12; index++) app.handleInput("j");
  const output = app.render(120).join("\n");
  assert.match(output, /> \[accepted\] Historical result 12/);
  assert.match(output, /↕ \d+-\d+ of 16/);
  app.dispose();
});
