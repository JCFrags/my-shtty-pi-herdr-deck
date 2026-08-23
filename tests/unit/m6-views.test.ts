import assert from "node:assert/strict";
import test from "node:test";
import { DeckActions, type DeckAction } from "../../src/deck/actions.js";
import { BrokerClient } from "../../src/deck/broker-client.js";
import { BrokerDeckApp } from "../../src/deck/broker-app.js";
import {
  renderAgentInspector,
  renderAgents,
  renderFiles,
  renderGroupDetail,
  renderGroups,
  renderHome,
  renderInbox,
  renderNotifications,
  renderResultDetail,
  renderTaskDetail,
  renderTodoSummary,
  renderTodoDetail,
  currentProviderProjection,
} from "../../src/deck/views.js";
import type { DeckState } from "../../src/deck/types.js";

const state: DeckState = {
  seq: 4,
  agents: new Map([
    [
      "agt_1",
      {
        id: "agt_1",
        state: "working",
        generation: 2,
        paneId: "p1",
        displayName: "Worker",
      },
    ],
  ]),
  tasks: new Map([
    [
      "tsk_1",
      {
        id: "tsk_1",
        title: "A long task title",
        objective: "A long objective",
        state: "running",
        createdAt: "now",
        currentRunId: "run_1",
        resultId: "res_1",
      },
    ],
  ]),
  runs: new Map([
    [
      "run_1",
      {
        id: "run_1",
        taskId: "tsk_1",
        state: "working",
        assignmentGeneration: 2,
        settled: false,
        agentId: "agt_1",
      },
    ],
  ]),
  workflows: new Map(),
  groups: new Map([
    [
      "grp_1",
      {
        id: "grp_1",
        name: "Deck workers",
        state: "blocked",
        agentIds: ["agt_1"],
        taskIds: ["tsk_1"],
        blockedReason: "Awaiting review",
      },
    ],
  ]),
  questions: new Map(),
  providerProjections: new Map([
    [
      "agt_1",
      {
        ownerAgentId: "agt_1",
        piSessionId: "pi-1",
        agentBoard: { available: false, openCount: 0, items: [] },
        todo: { available: false, total: 0, completed: 0, items: [] },
      },
    ],
  ]),
  results: new Map([
    [
      "res_1",
      {
        id: "res_1",
        status: "accepted",
        summary: "Done",
        evidence: ["REPORT.md"],
        tests: ["focused"],
        artifacts: ["dist"],
      },
    ],
  ]),
};

Object.assign(state.agents.get("agt_1")!, {
  workspaceId: "w1",
  tabId: "w1:t1",
  requestedModel: { provider: "openai-codex", id: "gpt-5.6-sol" },
  actualModel: { provider: "openai-codex", id: "gpt-5.6-sol" },
  requestedThinkingLevel: "medium",
  thinkingLevel: "medium",
  modelChoices: [{ provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" }],
  allowedThinkingLevels: ["low", "medium", "high"],
});

test("views keep every line within narrow terminal widths", () => {
  const views = [
    renderAgents(state, 1),
    renderTaskDetail(state.tasks.get("tsk_1"), state, 1),
    renderGroups(state, 1),
    renderGroupDetail(state.groups.get("grp_1"), 1),
    renderAgentInspector(state.agents.get("agt_1"), state, 1),
    renderResultDetail(state.results.get("res_1"), 1),
    renderNotifications(
      [{ id: "evt_1", kind: "failure", text: "A failure", seq: 4 }],
      1,
    ),
  ];
  for (const lines of views)
    for (const line of lines) assert.ok(line.length <= 1);
  assert.match(renderAgents(state, 80).join("\n"), /working/);
  assert.match(
    renderTaskDetail(state.tasks.get("tsk_1"), state, 120).join("\n"),
    /Result status: accepted/,
  );
});

test("unified views expose current work, files, and separate question semantics", () => {
  state.questions.set("qst_1", {
    id: "qst_1",
    taskId: "tsk_1",
    prompt: "Choose a target.",
    state: "open",
  });
  state.agents.set("agt_history", {
    id: "agt_history",
    state: "working",
    generation: 1,
    paneId: "p-history",
    displayName: "Historical noise",
  });
  state.providerProjections.delete("agt_1");
  const homeWithoutProviders = renderHome(state, 120, "p1").join("\n");
  assert.doesNotMatch(homeWithoutProviders, /scope is unavailable/);
  assert.match(homeWithoutProviders, /Worker/);
  state.providerProjections.set("agt_1", {
    ownerAgentId: "agt_1",
    piSessionId: "pi-1",
    agentBoard: {
      available: true,
      openCount: 1,
      items: [{ id: "board-selected", title: "Selected board item" }],
    },
    todo: {
      available: true,
      total: 2,
      completed: 1,
      items: [{ id: "todo-selected", text: "Selected Todo item" }],
    },
  });
  state.providerProjections.set("agt_history", {
    ownerAgentId: "agt_history",
    piSessionId: "pi-history",
    agentBoard: {
      available: true,
      openCount: 1,
      items: [{ id: "board-wrong", title: "Wrong board item" }],
    },
    todo: {
      available: true,
      total: 1,
      completed: 0,
      items: [{ id: "todo-wrong", text: "Wrong Todo item" }],
    },
  });
  const home = renderHome(state, 120, "p1").join("\n");
  const todo = renderTodoSummary(state, 120, "p1").join("\n");
  const inbox = renderInbox(state, 120, "qst_1", "p1").join("\n");
  assert.match(home, /CURRENT SCOPE/);
  assert.match(home, /ACTIVE WORK/);
  assert.match(home, /orchestrator question/);
  assert.match(home, /Providers · Signals 1 pending · Todo 1\/2 done/);
  assert.doesNotMatch(home, /Historical noise/);
  assert.match(home, /Scope totals · 1 active · 0 idle retained · 0 history/);
  assert.match(
    renderFiles(120, state, "p1").join("\n"),
    /Provider browser: tree navigation/,
  );
  assert.match(todo, /Selected Todo item/);
  assert.doesNotMatch(todo, /Wrong Todo item/);
  assert.match(inbox, /BLOCKING · Orchestrator questions/);
  assert.match(inbox, /ask_user_question/);
  assert.doesNotMatch(
    inbox,
    /AGENT BOARD · Provider-owned asynchronous state|Pi Signal Board|Selected board item|Wrong board item/,
  );
  state.questions.delete("qst_1");
  state.agents.delete("agt_history");
  state.providerProjections.delete("agt_history");
  state.providerProjections.set("agt_1", {
    ownerAgentId: "agt_1",
    piSessionId: "pi-1",
    agentBoard: { available: false, openCount: 0, items: [] },
    todo: { available: false, total: 0, completed: 0, items: [] },
  });
});

test("provider projection selection prefers the newest pane connection after reload", () => {
  const reloaded: DeckState = {
    ...state,
    agents: new Map([
      [
        "agt_old",
        {
          id: "agt_old",
          state: "idle",
          generation: 1,
          paneId: "p1",
          piSessionId: "pi-1",
          connectionGeneration: 4,
        },
      ],
      [
        "agt_new",
        {
          id: "agt_new",
          state: "idle",
          generation: 1,
          paneId: "p1",
          piSessionId: "pi-1",
          connectionGeneration: 5,
        },
      ],
    ]),
    providerProjections: new Map([
      [
        "agt_old",
        {
          ownerAgentId: "agt_old",
          piSessionId: "pi-1",
          agentBoard: { available: false, openCount: 0, items: [] },
          todo: { available: false, total: 0, completed: 0, items: [] },
        },
      ],
      [
        "agt_new",
        {
          ownerAgentId: "agt_new",
          piSessionId: "pi-1",
          agentBoard: { available: true, openCount: 0, items: [] },
          todo: { available: true, total: 0, completed: 0, items: [] },
        },
      ],
    ]),
  };
  assert.equal(
    currentProviderProjection(reloaded, "p1")?.ownerAgentId,
    "agt_new",
  );
});

test("agent filters keep history out of active view and expose paging", () => {
  const many = new Map(state.agents);
  for (let index = 0; index < 14; index++)
    many.set(`agt_idle_${index}`, {
      id: `agt_idle_${index}`,
      state: "idle",
      generation: 1,
      displayName: `Retained ${index}`,
    });
  const filtered = { ...state, agents: many };
  const active = renderAgents(filtered, 120, undefined, "active").join("\\n");
  assert.doesNotMatch(active, /Retained 0/);
  assert.match(active, /ACTIVE/);
  assert.match(
    renderAgents(filtered, 120, undefined, "idle").join("\\n"),
    /page 1\//,
  );
  assert.match(
    renderAgents(filtered, 120, undefined, "idle").join("\\n"),
    /Scroll/,
  );
});

test("provider target selection prefers the current session after reload", () => {
  const reloadState = structuredClone(state);
  reloadState.agents.set("agt_old", {
    ...reloadState.agents.get("agt_1")!,
    id: "agt_old",
    piSessionId: "pi-new",
    paneId: "p-reload",
  });
  reloadState.agents.set("agt_new", {
    ...reloadState.agents.get("agt_1")!,
    id: "agt_new",
    piSessionId: "pi-new",
    paneId: "p-reload",
  });
  reloadState.providerProjections.set("agt_old", {
    ...reloadState.providerProjections.get("agt_1")!,
    ownerAgentId: "agt_old",
    piSessionId: "pi-old",
  });
  reloadState.providerProjections.set("agt_new", {
    ...reloadState.providerProjections.get("agt_1")!,
    ownerAgentId: "agt_new",
    piSessionId: "pi-new",
    files: { available: true, view: { rows: [{ path: "new.ts" }] } },
  });
  assert.equal(
    currentProviderProjection(reloadState, "p-reload")?.ownerAgentId,
    "agt_new",
  );
});

test("views expose placement, model, thinking, and group detail", () => {
  const inspector = renderAgentInspector(
    state.agents.get("agt_1"),
    state,
    160,
  ).join("\n");
  assert.match(inspector, /workspace w1; tab w1:t1; pane p1/);
  assert.match(inspector, /Requested model: openai-codex\/gpt-5.6-sol/);
  assert.match(inspector, /Thinking requested\/actual: medium \/ medium/);
  assert.match(renderGroups(state, 120, "grp_1").join("\n"), /Deck workers/);
  assert.match(
    renderGroupDetail(state.groups.get("grp_1"), 120).join("\n"),
    /Blocked reason: Awaiting review/,
  );
});

test("views expose state and result meaning without color", () => {
  const agents = renderAgents(state, 120).join("\n");
  assert.match(agents, /State:/);
  assert.match(agents, /▶ working/);
  assert.match(
    renderResultDetail(state.results.get("res_1"), 120).join("\n"),
    /Summary: Done/,
  );
  assert.match(
    renderNotifications(
      [{ id: "evt_1", kind: "timeout", text: "Timed out", seq: 4 }],
      120,
    ).join("\n"),
    /\[timeout\]/,
  );
});

test("switching tabs cancels the active DEFAULT input", () => {
  const client = new BrokerClient({
    socketPath: "/tmp/m6-input.sock",
    secret: "test",
  });
  const app = new BrokerDeckApp({
    client,
    requestRender: () => undefined,
    getHeight: () => 40,
  });
  app.handleInput(",");
  app.handleInput("d");
  assert.match(app.render(120).join("\\n"), /DEFAULT:/);
  app.handleInput("1");
  assert.doesNotMatch(app.render(120).join("\\n"), /DEFAULT:/);
  app.dispose();
  client.stop();
});

test("provider Todo actions use the selected provider ID, not an orchestrator task", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = {
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      return {};
    },
  } as unknown as BrokerClient;
  const actions = new DeckActions(client);
  const worker = state.agents.get("agt_1")!;
  const orchestratorTask = state.tasks.get("tsk_1")!;
  assert.equal(
    actions.authorize("todoStart", { todoTaskId: "todo-exact" }),
    undefined,
  );
  await actions.run("todoStart", { agent: worker, todoTaskId: "todo-exact" });
  await actions.run("todoDone", {
    agent: worker,
    task: orchestratorTask,
    todoTaskId: "todo-exact",
  });
  await actions.run("todoClearWait", {
    agent: worker,
    todoTaskId: "todo-exact",
  });
  assert.deepEqual(
    requests.map((entry) => (entry.params as { taskId: string }).taskId),
    ["todo-exact", "todo-exact", "todo-exact"],
  );
  state.providerProjections.set("agt_1", {
    ownerAgentId: "agt_1",
    piSessionId: "pi-1",
    agentBoard: { available: false, openCount: 0, items: [] },
    todo: {
      available: true,
      total: 1,
      completed: 0,
      items: [{ id: "todo-exact", text: "Provider work" }],
    },
  });
  assert.match(
    renderTodoDetail(state, 120, "p1", "todo-exact").join("\\n"),
    /ID: todo-exact/,
  );
});

test("Agent Board view keeps provider-owned selections in the correlated request", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = {
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      return {};
    },
  } as unknown as BrokerClient;
  const actions = new DeckActions(client);
  const worker = state.agents.get("agt_1")!;
  await actions.run("boardView", {
    agent: worker,
    boardSelections: { inbox: "qst_exact", updates: "upd_exact" },
  });
  assert.deepEqual(requests, [
    {
      method: "provider.agent_board_view",
      params: {
        ownerAgentId: "agt_1",
        selections: { inbox: "qst_exact", updates: "upd_exact" },
      },
    },
  ]);
});

test("every action has a keyboard-safe authorization result", () => {
  const client = new BrokerClient({
    socketPath: "/tmp/m6-unused.sock",
    secret: "test",
  });
  const actions = new DeckActions(client);
  const actionNames: DeckAction[] = [
    "focus",
    "prompt",
    "ask",
    "steer",
    "followUp",
    "answer",
    "interrupt",
    "compact",
    "setModel",
    "setThinking",
    "restart",
    "stop",
    "close",
    "cancelTask",
    "openWorktree",
    "copyId",
    "refresh",
  ];
  for (const action of actionNames)
    assert.doesNotThrow(() => actions.authorize(action, {}));
  assert.match(actions.authorize("copyId", {}) ?? "", /agent or task/);
  assert.equal(actions.authorize("refresh", {}), undefined);
  const worker = state.agents.get("agt_1");
  assert.ok(worker);
  assert.equal(actions.authorize("compact", { agent: worker }), undefined);
  assert.match(
    actions.authorize("focus", { agent: worker }) ?? "",
    /Pane identity/,
  );
});
