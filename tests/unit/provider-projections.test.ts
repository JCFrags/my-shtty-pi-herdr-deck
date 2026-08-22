import assert from "node:assert/strict";
import test from "node:test";
import { ProviderProjectionCollector } from "../../src/pi/provider-projection-collector.js";
import {
  AGENT_BOARD_CHANGED_EVENT,
  AGENT_BOARD_REQUEST_EVENT,
  AGENT_BOARD_VIEW_REQUEST_EVENT,
  AGENT_BOARD_VIEW_RESPONSE_EVENT,
  FILES_PROVIDER_REQUEST_EVENT,
  FILES_PROVIDER_RESPONSE_EVENT,
  TODO_REQUEST_EVENT,
  TODO_SUMMARY_EVENT,
  validateProviderProjection,
  type ProviderProjection,
} from "../../src/shared/provider-projections.js";
import { DeckStore, snapshotFromBroker } from "../../src/deck/store.js";

class FakeEvents {
  readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  readonly emitted: Array<{ event: string; data: unknown }> = [];
  on(event: string, listener: (value: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  off(event: string, listener: (value: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string, data: unknown): void {
    this.emitted.push({ event, data });
    for (const listener of this.listeners.get(event) ?? []) listener(data);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("provider collector uses stable events and tolerates refined summary wrappers", async () => {
  const events = new FakeEvents();
  const published: ProviderProjection[] = [];
  const collector = new ProviderProjectionCollector(events, async (value) => {
    published.push(value);
  });
  collector.start();
  collector.bind("agt_root", "pi-root");
  events.emit(AGENT_BOARD_CHANGED_EVENT, {
    schemaVersion: 1,
    snapshot: {
      schemaVersion: 1,
      pendingAsyncQuestionCount: 1,
      significantActiveUpdates: [
        { id: "U-1", kind: "working", title: "Provider projection is live" },
      ],
    },
  });
  events.emit(TODO_SUMMARY_EVENT, {
    version: 1,
    snapshot: {
      version: 1,
      planSize: 2,
      countsByState: { pending: 1, in_progress: 1, blocked: 0, done: 0 },
      unfinishedTasks: [
        { id: "todo-1", text: "Unified UI acceptance", status: "in_progress" },
        { id: "todo-2", text: "Inspect integrated deck", status: "pending" },
      ],
      externalWaits: [],
    },
  });
  await tick();
  const boardRequest = events.emitted.find(
    (item) => item.event === AGENT_BOARD_REQUEST_EVENT,
  );
  assert.equal(
    (boardRequest?.data as { schemaVersion?: number }).schemaVersion,
    1,
  );
  assert.ok(events.emitted.some((item) => item.event === TODO_REQUEST_EVENT));
  assert.equal(
    published.at(-1)?.agentBoard.items[0]?.title,
    "Provider projection is live",
  );
  assert.equal(published.at(-1)?.agentBoard.openCount, 1);
  assert.equal(published.at(-1)?.todo.items[0]?.text, "Unified UI acceptance");
  assert.equal(published.at(-1)?.todo.total, 2);
  assert.equal(published.at(-1)?.todo.planSize, 2);
  assert.deepEqual(published.at(-1)?.todo.countsByState, {
    pending: 1,
    in_progress: 1,
    blocked: 0,
    done: 0,
  });
  collector.stop();
});

test("provider collector requests and publishes a correlated Files snapshot", async () => {
  const events = new FakeEvents();
  const published: ProviderProjection[] = [];
  const collector = new ProviderProjectionCollector(events, async (value) => {
    published.push(value);
  });
  collector.start();
  collector.bind("agt_root", "pi-root");
  const request = events.emitted
    .filter((item) => item.event === FILES_PROVIDER_REQUEST_EVENT)
    .at(-1);
  assert.equal((request?.data as { action?: string }).action, "snapshot");
  const requestId = (request?.data as { requestId: string }).requestId;
  events.emit(FILES_PROVIDER_RESPONSE_EVENT, {
    version: 1,
    requestId,
    ok: true,
    summary: {
      version: 1,
      cwd: "/repo",
      currentPath: "src",
      selectedPaths: [],
      selectedCount: 0,
      limits: {},
    },
    view: {
      version: 1,
      cwd: "/repo",
      currentPath: "src",
      rows: [
        {
          path: "main.ts",
          name: "main.ts",
          kind: "file",
          depth: 0,
          selected: false,
          partiallySelected: false,
          expanded: false,
          loaded: true,
          truncated: false,
          hidden: false,
          ignored: false,
          supplemental: false,
        },
      ],
    },
  });
  await tick();
  assert.equal(published.at(-1)?.files?.available, true);
  assert.equal(
    (published.at(-1)?.files?.view as { rows?: unknown[] })?.rows?.length,
    1,
  );
  collector.stop();
});

test("collector unwraps runtime response envelopes and clears stale Files errors", async () => {
  const events = new FakeEvents();
  const published: ProviderProjection[] = [];
  const collector = new ProviderProjectionCollector(events, async (value) => {
    published.push(value);
  });
  collector.start();
  collector.bind("agt_reload", "pi-reloaded");
  const filesRequest = events.emitted
    .filter((item) => item.event === FILES_PROVIDER_REQUEST_EVENT)
    .at(-1)!;
  const boardRequest = events.emitted
    .filter((item) => item.event === AGENT_BOARD_VIEW_REQUEST_EVENT)
    .at(-1)!;
  const filesId = (filesRequest.data as { requestId: string }).requestId;
  const boardId = (boardRequest.data as { requestId: string }).requestId;
  events.emit(FILES_PROVIDER_RESPONSE_EVENT, {
    requestId: filesId,
    ok: false,
    response: { error: "No active Files provider" },
  });
  events.emit(FILES_PROVIDER_RESPONSE_EVENT, {
    requestId: filesId,
    ok: true,
    response: {
      summary: { cwd: "/repo", currentPath: "src", selectedCount: 0 },
      view: { rows: [{ path: "src/index.ts", name: "index.ts" }] },
    },
  });
  events.emit(AGENT_BOARD_VIEW_RESPONSE_EVENT, {
    requestId: boardId,
    response: {
      snapshot: {
        health: "healthy",
        view: { tabs: { updates: { rows: [{ id: "U-3", title: "Deploy" }] } } },
      },
    },
  });
  await tick();
  const last = published.at(-1)!;
  assert.equal(last.files?.available, true);
  assert.equal(last.files?.error, undefined);
  assert.equal((last.files?.view as { rows?: unknown[] })?.rows?.length, 1);
  assert.equal(
    (
      last.agentBoard.view as {
        view?: { tabs?: { updates?: { rows?: unknown[] } } };
      }
    )?.view?.tabs?.updates?.rows?.length,
    1,
  );
  collector.stop();
});

test("provider projection validation is bounded and store reconnects ephemeral state", () => {
  const projection = validateProviderProjection({
    ownerAgentId: "agt_root",
    piSessionId: "pi-root",
    agentBoard: {
      available: true,
      openCount: 1,
      items: [{ id: "q1", title: "Review?", state: "open" }],
    },
    todo: {
      available: true,
      total: 1,
      completed: 0,
      planSize: 3,
      countsByState: { working: 1 },
      currentUsefulTask: {
        id: "t1",
        text: "Build",
        status: "working",
        waitReason: "remote",
      },
      waitReason: "remote",
      externalWaits: ["remote"],
      items: [
        { id: "t1", text: "Build", status: "working", waitReason: "remote" },
      ],
    },
  });
  const store = new DeckStore();
  store.replace(
    snapshotFromBroker({
      seq: 4,
      agents: [],
      tasks: [],
      workflows: [],
      providerProjections: [projection],
    }),
  );
  assert.equal(store.state.providerProjections.get("agt_root")?.todo.total, 1);
  assert.equal(
    store.state.providerProjections.get("agt_root")?.todo.planSize,
    3,
  );
  assert.equal(
    store.state.providerProjections.get("agt_root")?.todo.externalWaits?.[0],
    "remote",
  );
  assert.equal(
    store.apply({
      seq: 4,
      id: "evt-projection",
      event: "presentation.projection.changed",
      refs: { agentId: "agt_root" },
      data: { ownerAgentId: "agt_root", projection: null },
    }),
    true,
  );
  assert.equal(store.state.providerProjections.size, 0);
  assert.throws(() =>
    validateProviderProjection({
      ...projection,
      unknown: "not accepted",
    }),
  );
});
