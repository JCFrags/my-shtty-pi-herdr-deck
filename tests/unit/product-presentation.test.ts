import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, Task } from "../../src/state/types.js";
import type { DeckState } from "../../src/deck/types.js";
import type { ProviderProjection } from "../../src/shared/provider-projections.js";
import {
  isTerminalAgentState,
  isTerminalTaskState,
  selectActivityPresentation,
  selectUnifiedBoardPresentation,
} from "../../src/deck/product-presentation.js";

const root: Agent = {
  id: "agt-root",
  state: "working",
  generation: 1,
  paneId: "pane-1",
  piSessionId: "pi-1",
  displayName: "Root",
};
const task = (
  id: string,
  state: Task["state"],
  extra: Partial<Task> = {},
): Task => ({
  id,
  title: id,
  objective: `Objective ${id}`,
  state,
  createdAt: `2026-08-23T00:00:${id.length.toString().padStart(2, "0")}Z`,
  assignedAgentId: root.id,
  ...extra,
});

function projection(): ProviderProjection {
  return {
    ownerAgentId: root.id,
    piSessionId: "pi-1",
    todo: {
      available: true,
      total: 4,
      completed: 1,
      waitReason: "provider maintenance",
      items: [
        { id: "done", text: "Done", status: "COMPLETED" },
        { id: "active", text: "Active", status: "In Progress" },
        { id: "wait", text: "Wait", status: "OPEN", waitReason: "external" },
      ],
    },
    agentBoard: {
      available: true,
      openCount: 1,
      items: [],
      pendingQuestions: [
        {
          questionId: "SQ-1",
          revision: 3,
          question: "Pick",
          response: { kind: "multiple", options: [{ id: "a", label: "A" }] },
          recommendedOptionIds: ["a"],
        },
      ],
      view: {
        view: {
          tabs: {
            inbox: {
              rows: [
                {
                  id: "SQ-1",
                  title: "Signals question",
                  revision: 3,
                  userAnswerable: true,
                  dismissible: true,
                },
              ],
            },
            updates: {
              rows: [
                {
                  id: "U-1",
                  title: "Progress",
                  state: "completed",
                  archivable: true,
                  retryableDelivery: true,
                  changedAt: "2026-08-23T02:00:00Z",
                },
              ],
            },
            decisions: {
              rows: [
                {
                  id: "D-1",
                  title: "Applied decision",
                  state: "applied",
                  changedAt: "2026-08-23T03:00:00Z",
                },
              ],
            },
            history: {
              rows: [
                {
                  id: "U-1",
                  title: "Progress complete",
                  state: "completed",
                  terminalAt: "2026-08-23T04:00:00Z",
                },
              ],
            },
          },
        },
      },
    },
  };
}

function state(): DeckState {
  const tasks = [
    task("blocked", "blocked"),
    task("question-task", "blocked"),
    task("running", "running"),
    task("succeeded", "succeeded", {
      resultId: "result-1",
      currentRunId: "run-1",
    }),
    task("timeout", "timed_out"),
  ];
  const blockedAgent: Agent = {
    id: "agt-blocked",
    state: "blocked",
    generation: 1,
    parentAgentId: root.id,
    displayName: "Blocked",
  };
  return {
    seq: 1,
    agents: new Map([
      [root.id, root],
      [blockedAgent.id, blockedAgent],
    ]),
    tasks: new Map(tasks.map((value) => [value.id, value])),
    runs: new Map(),
    workflows: new Map(),
    groups: new Map([
      [
        "group-active",
        {
          id: "group-active",
          state: "running",
          title: "Active group",
          parentAgentId: root.id,
          agentIds: [root.id],
        },
      ],
      [
        "group-blocked",
        {
          id: "group-blocked",
          state: "blocked",
          title: "Blocked group",
          blockedReason: "dependency",
          parentAgentId: root.id,
          agentIds: [root.id],
        },
      ],
    ]),
    questions: new Map([
      [
        "BQ-1",
        {
          id: "BQ-1",
          taskId: "question-task",
          prompt: "Broker choice",
          options: [{ id: "yes", label: "Yes" }],
          state: "open",
        },
      ],
    ]),
    results: new Map([
      [
        "result-1",
        {
          id: "result-1",
          taskId: "succeeded",
          runId: "run-1",
          status: "accepted",
          summary: "Result",
        },
      ],
    ]),
    providerProjections: new Map([[root.id, projection()]]),
  };
}

test("Board partitions canonical current work, attention, and recent Signals", () => {
  const board = selectUnifiedBoardPresentation(state(), "pane-1");
  const ids = [...board.attention, ...board.work, ...board.recentSignals].map(
    (item) => item.uiId,
  );
  assert.equal(
    new Set(ids).size,
    ids.length,
    "source-qualified UI IDs are unique",
  );
  assert.equal(ids.includes("todo:done"), false);
  assert.equal(
    ids.some((id) => id.includes("succeeded") || id.includes("timeout")),
    false,
  );
  assert.ok(board.attention.some((item) => item.uiId === "todo:wait"));
  assert.equal(
    board.work.some((item) => item.uiId === "todo:wait"),
    false,
  );
  assert.ok(board.work.some((item) => item.uiId === "todo:active"));
  assert.ok(
    board.attention.some((item) => item.uiId === "orchestrator:task:blocked"),
  );
  assert.equal(
    board.attention.some(
      (item) => item.uiId === "orchestrator:task:question-task",
    ),
    false,
  );
  assert.ok(
    board.attention.some((item) => item.uiId === "orchestrator:question:BQ-1"),
  );
  assert.ok(
    board.attention.some(
      (item) => item.uiId === "orchestrator:group:group-blocked",
    ),
  );
  assert.ok(
    board.work.some((item) => item.uiId === "orchestrator:group:group-active"),
  );
  assert.ok(
    board.attention.some((item) => item.uiId === "signals:question:SQ-1"),
  );
  assert.ok(
    board.recentSignals.some((item) => item.uiId === "signals:update:U-1"),
  );
  const update = board.recentSignals.find(
    (item) => item.uiId === "signals:update:U-1",
  );
  assert.deepEqual(update?.actions.actions, [
    "archive-update",
    "retry-delivery",
  ]);
  assert.equal(
    ids.some((id) => id.includes("D-1")),
    false,
    "decisions are not Board recommendations",
  );
  const signal = board.attention.find(
    (item) => item.uiId === "signals:question:SQ-1",
  );
  assert.ok(signal?.actions.actions.includes("use-recommendation"));
  assert.ok(signal?.actions.actions.includes("dismiss-question"));
  assert.equal(signal?.actions.actions.includes("dismiss" as never), false);
  assert.ok(
    board.attention
      .find((item) => item.uiId === "orchestrator:task:blocked")
      ?.actions.actions.includes("focus-agent"),
  );
  assert.ok(
    board.attention
      .find((item) => item.uiId === "orchestrator:task:blocked")
      ?.actions.actions.includes("open-agents"),
  );
  assert.ok(board.attention.some((item) => item.kind === "agent-alert"));
});

test("synthetic provider wait has no task actions and only waitReason clears Todo wait", () => {
  const value = state();
  const provider = value.providerProjections.get(root.id)!;
  provider.todo.items = provider.todo.items.filter(
    (item) => item.id !== "wait",
  );
  const board = selectUnifiedBoardPresentation(value, "pane-1");
  const synthetic = board.attention.find(
    (item) => item.uiId === "todo:provider-wait",
  );
  assert.deepEqual(synthetic?.actions.actions, []);
  const todo = board.work.find((item) => item.uiId === "todo:active");
  assert.equal(todo?.actions.actions.includes("clear-wait"), false);
});

test("Board filters visibility only and selection falls back deterministically", () => {
  const all = selectUnifiedBoardPresentation(
    state(),
    "pane-1",
    "missing",
    "all-current",
  );
  const attention = selectUnifiedBoardPresentation(
    state(),
    "pane-1",
    undefined,
    "attention",
  );
  const active = selectUnifiedBoardPresentation(
    state(),
    "pane-1",
    undefined,
    "active",
  );
  assert.equal(attention.visible.length, all.attention.length);
  assert.equal(
    active.visible.length,
    all.work.length + all.recentSignals.length,
  );
  assert.equal(all.selected?.uiId, all.visible[0]?.uiId);
  assert.deepEqual(
    selectUnifiedBoardPresentation(state(), "pane-1").visible.map(
      (item) => item.uiId,
    ),
    selectUnifiedBoardPresentation(state(), "pane-1").visible.map(
      (item) => item.uiId,
    ),
  );
});

test("Activity uses real terminal states and deduplicates results and Signals", () => {
  const value = state();
  value.agents.set("stopped", {
    id: "stopped",
    state: "stopped",
    generation: 1,
    parentAgentId: root.id,
  });
  value.agents.set("orphaned", {
    id: "orphaned",
    state: "orphaned",
    generation: 1,
    parentAgentId: root.id,
  });
  value.agents.set("replaced", {
    id: "replaced",
    state: "replaced",
    generation: 1,
    parentAgentId: root.id,
  });
  const activity = selectActivityPresentation(value, "pane-1");
  assert.equal(
    activity.items.some((item) => item.uiId === "orchestrator:task:succeeded"),
    false,
  );
  assert.ok(
    activity.items.some((item) => item.uiId === "orchestrator:result:result-1"),
  );
  assert.ok(
    activity.items.some((item) => item.uiId === "orchestrator:task:timeout"),
  );
  assert.ok(
    activity.items.some(
      (item) => item.kind === "terminal-agent" && item.state === "orphaned",
    ),
  );
  assert.ok(
    activity.items.some(
      (item) => item.kind === "terminal-agent" && item.state === "replaced",
    ),
  );
  assert.equal(
    activity.items.filter((item) => item.entityId === "U-1").length,
    1,
  );
  assert.ok(activity.items.some((item) => item.kind === "signal-decision"));
  assert.equal(
    selectActivityPresentation(
      value,
      "pane-1",
      undefined,
      "signals",
    ).items.every((item) => item.kind.startsWith("signal-")),
    true,
  );
});

test("canonical state helpers reject impossible historical aliases", () => {
  assert.equal(isTerminalTaskState("succeeded"), true);
  assert.equal(isTerminalTaskState("timed_out"), true);
  assert.equal(isTerminalTaskState("running"), false);
  assert.equal(isTerminalAgentState("stopped"), true);
  assert.equal(isTerminalAgentState("orphaned"), true);
  assert.equal(isTerminalAgentState("replaced"), true);
});
