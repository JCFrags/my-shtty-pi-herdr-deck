import assert from "node:assert/strict";
import test from "node:test";
import type { TuiMouseEvent } from "@pi-herdr-deck/tui";
import { BrokerDeckApp } from "../../src/deck/broker-app.js";
import { renderButton } from "../../src/deck/components/controls.js";
import { BrokerClient } from "../../src/deck/broker-client.js";
import {
  shellHeaderPresentation,
  visibleSurfaceSignature,
} from "../../src/deck/render-dependencies.js";
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
  const attentionChanged = state(
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
  assert.notEqual(
    visibleSurfaceSignature(attentionChanged, filesContext),
    baseline,
  );
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
  assert.equal(renders, baseline + 1);
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
  clickLabel(app, "Confirm");
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
        todo: {
          available: true,
          total: 2,
          completed: 0,
          items: [{ id: "todo-2", text: "Other" }],
        },
      }),
    ),
  );
  assert.equal(renders, baseline);
  client.store.replace(
    snapshot(
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
          items: [{ id: "q", title: "Q" }],
        },
      }),
    ),
  );
  assert.equal(renders, baseline + 1);
  const afterAttention = renders;
  client.store.replace(
    snapshot(
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
          items: [{ id: "q", title: "Q changed" }],
        },
      }),
    ),
  );
  assert.equal(renders, afterAttention);
  client.store.replace(
    snapshot(
      projection({
        todo: {
          available: true,
          total: 2,
          completed: 0,
          items: [{ id: "todo-2", text: "Other" }],
        },
        files: { available: true, view: { rows: ["changed.txt"] } },
        agentBoard: {
          available: true,
          openCount: 1,
          items: [{ id: "q", title: "Q changed" }],
        },
      }),
    ),
  );
  assert.equal(renders, afterAttention + 1);
  const beforeTab = renders;
  app.handleInput("1");
  assert.equal(renders, beforeTab + 1);
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

test("visible signatures derive guarded overlay state and exact action availability", () => {
  const guarded = state();
  guarded.tasks.set("task-1", {
    id: "task-1",
    state: "running",
    title: "Task",
    assignedAgentId: "agent-1",
  } as never);
  const overlay = {
    tab: "board" as const,
    targetPaneId: "pane-1",
    overlay: "confirm" as const,
    overlayGuard: {
      kind: "confirm",
      action: "cancelTask",
      target: { task: guarded.tasks.get("task-1") },
      guard: { targetId: "task-1" },
      summary: "Cancel Task?",
    },
  };
  const baseline = visibleSurfaceSignature(guarded, overlay);
  guarded.tasks.set("task-1", {
    ...guarded.tasks.get("task-1")!,
    state: "succeeded",
  } as never);
  assert.notEqual(visibleSurfaceSignature(guarded, overlay), baseline);

  const unrelated = state();
  const unchanged = visibleSurfaceSignature(unrelated, {
    tab: "board",
    targetPaneId: "pane-1",
    overlay: "agent-more",
    overlayGuard: {
      kind: "agent-more",
      guard: { agentId: "agent-1", generation: 1 },
    },
  });
  unrelated.tasks.set("other", { id: "other", state: "running" } as never);
  assert.equal(
    visibleSurfaceSignature(unrelated, {
      tab: "board",
      targetPaneId: "pane-1",
      overlay: "agent-more",
      overlayGuard: {
        kind: "agent-more",
        guard: { agentId: "agent-1", generation: 1 },
      },
    }),
    unchanged,
  );
});

test("shell attention is the canonical Board count, including synthetic waits, and scope is safe", () => {
  const value = state();
  const provider = value.providerProjections.get("agent-1")!;
  provider.todo.items = [];
  provider.todo.waitReason = "provider wait";
  const shell = shellHeaderPresentation(value, {
    tab: "board",
    targetPaneId: "pane-1",
    online: true,
  });
  assert.equal(shell.attentionCount, 1);
  value.agents.set("agent-1", {
    ...agent(),
    displayName: "bad\u001b[31m\u202e",
  } as Agent);
  assert.doesNotMatch(
    shellHeaderPresentation(value, {
      tab: "board",
      targetPaneId: "pane-1",
    }).scopeLabel,
    /\u001b|\u202e/u,
  );
});

test("duplicate provider projection events coalesce before render gating", () => {
  let renders = 0;
  const client = new BrokerClient({
    socketPath: "/tmp/provider-coalescing.sock",
    secret: "test",
  });
  client.store.replace(snapshot());
  const app = new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => renders++,
    getHeight: () => 30,
  });
  app.handleInput("2");
  const baseline = renders;
  assert.equal(
    client.store.apply({
      seq: 2,
      id: "projection-duplicate",
      event: "presentation.projection.changed",
      refs: { agentId: "agent-1" },
      data: { ownerAgentId: "agent-1", projection: projection() },
    }),
    true,
  );
  assert.equal(renders, baseline);
  assert.equal(
    client.store.apply({
      seq: 3,
      id: "projection-visible",
      event: "presentation.projection.changed",
      refs: { agentId: "agent-1" },
      data: {
        ownerAgentId: "agent-1",
        projection: projection({
          files: { available: true, view: { rows: ["b"] } },
        }),
      },
    }),
    true,
  );
  assert.equal(renders, baseline + 1);
  app.dispose();
});
