import assert from "node:assert/strict";
import test from "node:test";
import type { TuiMouseEvent } from "@pi-herdr-deck/tui";
import { BrokerClient } from "../../src/deck/broker-client.js";
import { BrokerDeckApp } from "../../src/deck/broker-app.js";
import { renderSettingsContent } from "../../src/deck/settings-presentation.js";
import type { DeckSnapshot } from "../../src/deck/types.js";
import type { Agent } from "../../src/state/types.js";
import type { ProviderProjection } from "../../src/shared/provider-projections.js";

const owner: Agent = {
  id: "agent-1",
  state: "working",
  generation: 1,
  paneId: "pane-1",
  piSessionId: "session-1",
  displayName: "Owner",
};

const signalQuestion = {
  questionId: "question-latest",
  revision: 7,
  question: "Use the latest recommendation?",
  response: { kind: "single" as const, options: [{ id: "yes", label: "Yes" }] },
  recommendedOptionIds: ["yes"],
};

function provider(): ProviderProjection {
  return {
    ownerAgentId: owner.id,
    piSessionId: "session-1",
    todo: {
      available: true,
      total: 1,
      completed: 0,
      items: [{ id: "todo-old", text: "Old Todo", status: "open" }],
    },
    agentBoard: {
      available: true,
      openCount: 1,
      items: [],
      pendingQuestions: [signalQuestion],
      view: {
        view: {
          tabs: {
            inbox: {
              rows: [
                {
                  id: signalQuestion.questionId,
                  title: "Latest question",
                  revision: signalQuestion.revision,
                  userAnswerable: true,
                },
              ],
            },
          },
        },
      },
    },
    files: { available: true },
  };
}

function snapshot(tasks: DeckSnapshot["tasks"]): DeckSnapshot {
  return {
    seq: 1,
    agents: [owner],
    tasks,
    workflows: [],
    groups: [],
    questions: [],
    results: [],
    providerProjections: [provider()],
  };
}

function click(app: BrokerDeckApp, label: string, rowSource?: string): void {
  const lines = app.render(120);
  const y = lines.findLastIndex(
    (line) => line.includes(label) && (!rowSource || line.includes(rowSource)),
  );
  assert.notEqual(y, -1, `missing ${label}`);
  const x = lines[y]!.indexOf(label) + 1;
  const clickY = y;
  for (const type of ["press", "release"] as const)
    app.handleMouse({
      type,
      button: "left",
      x,
      y: clickY,
      shift: false,
      alt: false,
      ctrl: false,
    } satisfies TuiMouseEvent);
}

test("Board targets contain only the latest Todo, task, or Signals source", () => {
  const task = {
    id: "task-current",
    title: "Current task",
    objective: "Run current task",
    state: "running" as const,
    createdAt: "2026-08-23T00:00:00Z",
    assignedAgentId: owner.id,
  };
  const client = new BrokerClient({
    socketPath: "/tmp/stale-state-targets.sock",
    secret: "test",
  });
  client.store.replace(snapshot([task]));
  const captured: Array<{ action: string; target: any }> = [];
  const app = new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => undefined,
    getHeight: () => 40,
    onActionTarget: (action, target) => captured.push({ action, target }),
  });

  click(app, "Old Todo", "[TODO]");
  click(app, "start");
  const todoTarget = captured.at(-1)!.target;
  assert.equal(todoTarget.todoTaskId, "todo-old");
  assert.equal(todoTarget.task, undefined);
  assert.equal(todoTarget.questionId, undefined);

  click(app, "Current task", "[ORCHESTRATOR]");
  click(app, "Cancel task");
  click(app, "Confirm");
  const taskTarget = captured.at(-1)!.target;
  assert.equal(taskTarget.task.id, "task-current");
  assert.equal(taskTarget.todoTaskId, undefined);
  assert.equal(taskTarget.boardQuestion, undefined);

  click(app, "Latest question", "[SIGNALS]");
  click(app, "Use recommendation");
  const signalTarget = captured.at(-1)!.target;
  assert.equal(signalTarget.task, undefined);
  assert.equal(signalTarget.todoTaskId, undefined);
  assert.deepEqual(signalTarget.boardAction, {
    action: "use-recommendation",
    fields: { questionId: signalQuestion.questionId, expectedRevision: 7 },
  });
  app.dispose();
});

test("confirmation keeps its exact guarded task target when state changes", () => {
  const first = {
    id: "task-guarded",
    title: "Guarded task",
    objective: "Keep this target",
    state: "running" as const,
    createdAt: "2026-08-23T00:00:00Z",
    assignedAgentId: owner.id,
  };
  const client = new BrokerClient({
    socketPath: "/tmp/stale-state-confirm.sock",
    secret: "test",
  });
  client.store.replace(snapshot([first]));
  const captured: Array<{ action: string; target: any }> = [];
  const app = new BrokerDeckApp({
    client,
    targetPaneId: "pane-1",
    requestRender: () => undefined,
    getHeight: () => 40,
    onActionTarget: (action, target) => captured.push({ action, target }),
  });
  click(app, "Guarded task", "[ORCHESTRATOR]");
  click(app, "Cancel task");
  client.store.replace(
    snapshot([
      {
        ...first,
        title: "Changed after confirmation opened",
      },
    ]),
  );
  click(app, "Confirm");
  assert.equal(captured.at(-1)?.action, "cancelTask");
  assert.equal(captured.at(-1)?.target.task.id, "task-guarded");
  assert.equal(captured.at(-1)?.target.task.title, "Guarded task");
  app.dispose();
});

test("settings presentation renders the model catalog outside BrokerDeckApp", () => {
  const lines = renderSettingsContent({
    capabilities: {
      thinkingLevels: ["low", "medium"],
      models: [
        {
          provider: "provider-a",
          modelId: "model-1",
          reasoning: true,
          thinkingLevels: ["low", "medium"],
        },
      ],
    },
    modelPolicy: {
      defaults: {
        global: {
          provider: "provider-a",
          modelId: "model-1",
          thinkingLevel: "low",
        },
      },
    },
    modelFilter: "model-1",
    autoCloseCompletedTemporary: true,
    scroll: 0,
    height: 30,
  });
  assert.match(lines.join("\n"), /provider-a\/model-1/);
  assert.match(lines.join("\n"), /1 models from 1 providers/);
  assert.match(lines.join("\n"), /● ON/);
});
