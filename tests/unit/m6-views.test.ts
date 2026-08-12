import assert from "node:assert/strict";
import test from "node:test";
import { DeckActions, type DeckAction } from "../../src/deck/actions.js";
import { BrokerClient } from "../../src/deck/broker-client.js";
import {
  renderAgentInspector,
  renderAgents,
  renderGroupDetail,
  renderGroups,
  renderNotifications,
  renderResultDetail,
  renderTaskDetail,
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
