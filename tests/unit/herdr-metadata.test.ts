import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../../src/shared/canonical-json.js";
import { emptyState, reduce } from "../../src/state/reducer.js";
import { EventStore } from "../../src/state/event-store.js";
import { HerdrService } from "../../src/herdr/service.js";
import type { HerdrSnapshot } from "../../src/herdr/types.js";

const base = {
  schemaVersion: 1 as const,
  metadataId: "hmd_example",
  orchestrationId: "orc_example",
  workflowId: "wfl_example",
  taskId: "tsk_example",
  runId: "run_example",
  agentId: "agt_example",
  parentAgentId: "agt_parent",
  profileId: "implementer",
  state: "working" as const,
  placement: "background" as const,
  transcriptPolicy: "retain-tab" as const,
  workspaceId: "w1",
  tabId: "w1:t1",
  paneId: "w1:p1",
  terminalId: "term_example",
  piSessionRef: `pis_${sha256("session_example").slice(0, 26)}`,
  startedAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:01.000Z",
  settledAt: null,
  exitedAt: null,
  transcriptRef: null,
  resultRef: null,
  questionRef: null,
  errorCode: null,
};
const payload = (overrides: Record<string, unknown> = {}) => {
  const value = { ...base, ...overrides };
  return { ...value, metadataDigest: sha256(canonicalJson(value)) };
};
const event = (
  value: Record<string, unknown>,
  refOverrides: Record<string, string> = {},
) => ({
  type: "herdr.metadata_projected",
  actor: {
    principalId: "prn_00000000000000000000000000",
    kind: "system",
  },
  entityRefs: {
    workflowId: "wfl_example",
    taskId: "tsk_example",
    runId: "run_example",
    agentId: "agt_example",
    workflowDigest: "a".repeat(64),
    ...refOverrides,
  },
  payload: value,
});

function correlatedState() {
  const state = emptyState();
  state.workflows.wfl_example = {
    id: "wfl_example",
    state: "running",
    taskIds: ["tsk_example"],
  };
  state.tasks.tsk_example = {
    id: "tsk_example",
    title: "Example",
    objective: "Example",
    state: "running",
    createdAt: base.startedAt,
    parentAgentId: "agt_parent",
    workflowId: "wfl_example",
    profileId: "implementer",
    currentRunId: "run_example",
    assignedAgentId: "agt_example",
    project: {
      compact: {
        workflowDigest: "a".repeat(64),
        transcriptPolicy: "retain-tab",
      },
    },
  };
  state.runs.run_example = {
    id: "run_example",
    taskId: "tsk_example",
    state: "working",
    agentId: "agt_example",
    assignmentGeneration: 1,
    settled: false,
  };
  state.agents.agt_example = {
    id: "agt_example",
    state: "working",
    generation: 1,
    currentRunId: "run_example",
  };
  state.herdrResources = {
    agt_example: {
      agentId: "agt_example",
      state: "registered",
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
      terminalId: "term_example",
      sessionId: "session_example",
    },
  };
  return state;
}

test("Herdr metadata projection replays safe exact correlation", () => {
  const state = reduce(correlatedState(), event(payload()));
  assert.equal(state.herdrMetadata?.hmd_example?.paneId, "w1:p1");
  assert.equal(
    state.herdrMetadata?.hmd_example?.transcriptPolicy,
    "retain-tab",
  );
});

test("Herdr metadata rejects forbidden fields, changed identity, and terminal reversal", () => {
  assert.throws(() =>
    reduce(emptyState(), event(payload({ prompt: "secret" }))),
  );
  const terminal = reduce(
    correlatedState(),
    event(payload({ state: "completed" })),
  );
  assert.throws(() => reduce(terminal, event(payload({ state: "working" }))));
  assert.throws(() =>
    reduce(
      reduce(correlatedState(), event(payload())),
      event(payload({ runId: "run_other" })),
    ),
  );
});

test("EventStore rejects orphan metadata before append", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-metadata-append-"));
  const path = join(root, "events.jsonl");
  try {
    const store = new EventStore(path);
    await store.open();
    const workflowId = `wfl_${"0".repeat(26)}`;
    const taskId = `tsk_${"1".repeat(26)}`;
    const runId = `run_${"2".repeat(26)}`;
    const agentId = `agt_${"3".repeat(26)}`;
    const orphanPayload = payload({ workflowId, taskId, runId, agentId });
    await assert.rejects(
      store.append(
        event(orphanPayload, { workflowId, taskId, runId, agentId }),
      ),
      /correlation/u,
    );
    assert.equal(await readFile(path, "utf8"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Herdr metadata accepts two exact run projections for one task and replays them", () => {
  const state = correlatedState();
  state.runs.run_second = {
    id: "run_second",
    taskId: "tsk_example",
    state: "working",
    agentId: "agt_second",
    assignmentGeneration: 2,
    settled: false,
  };
  state.tasks.tsk_example!.currentRunId = "run_second";
  state.tasks.tsk_example!.assignedAgentId = "agt_second";
  state.tasks.tsk_example!.runIds = ["run_example", "run_second"];
  state.agents.agt_second = {
    id: "agt_second",
    state: "working",
    generation: 1,
    currentRunId: "run_second",
  };
  state.herdrResources!.agt_second = {
    agentId: "agt_second",
    state: "registered",
    workspaceId: "w2",
    tabId: "w2:t2",
    paneId: "w2:p2",
    terminalId: "term_second",
    sessionId: "session_second",
  };
  const second = payload({
    metadataId: "hmd_second",
    runId: "run_second",
    agentId: "agt_second",
    workspaceId: "w2",
    tabId: "w2:t2",
    paneId: "w2:p2",
    terminalId: "term_second",
    piSessionRef: `pis_${sha256("session_second").slice(0, 26)}`,
  });
  const secondEvent = event(second, {
    runId: "run_second",
    agentId: "agt_second",
  });
  const appended = reduce(reduce(state, event(payload())), secondEvent);
  assert.deepEqual(Object.keys(appended.herdrMetadata!).sort(), [
    "hmd_example",
    "hmd_second",
  ]);
  const replayed = [event(payload()), secondEvent].reduce(
    (current, stored) => reduce(current, stored),
    state,
  );
  assert.deepEqual(replayed.herdrMetadata, appended.herdrMetadata);
  assert.throws(
    () => reduce(appended, event(payload({ metadataId: "hmd_replacement" }))),
    /correlation/u,
  );
});

test("Herdr metadata rejects valid-hash missing and cross-linked correlations", () => {
  assert.throws(() => reduce(emptyState(), event(payload())), /correlation/u);

  const wrongWorkflow = correlatedState();
  wrongWorkflow.workflows.wfl_example!.taskIds = ["tsk_other"];
  assert.throws(() => reduce(wrongWorkflow, event(payload())), /correlation/u);

  const wrongResource = correlatedState();
  wrongResource.herdrResources!.agt_example!.terminalId = "term_replaced";
  assert.throws(() => reduce(wrongResource, event(payload())), /correlation/u);

  assert.throws(() =>
    reduce(
      correlatedState(),
      event(payload(), { workflowDigest: "b".repeat(64) }),
    ),
  );

  const resultState = correlatedState();
  resultState.results = {
    res_example: {
      id: "res_example",
      taskId: "tsk_example",
      runId: "run_example",
      agentId: "agt_example",
      status: "succeeded",
      payloadHash: "c".repeat(64),
      piSettled: true,
    },
  };
  assert.doesNotThrow(() =>
    reduce(resultState, event(payload({ resultRef: "res_example" }))),
  );
  const wrongResult = correlatedState();
  wrongResult.results = {
    res_example: { ...resultState.results!.res_example!, agentId: "agt_other" },
  };
  assert.throws(() =>
    reduce(wrongResult, event(payload({ resultRef: "res_example" }))),
  );

  const duplicated = reduce(correlatedState(), event(payload()));
  assert.throws(() =>
    reduce(duplicated, event(payload({ metadataId: "hmd_duplicate" }))),
  );
});

function retainedSnapshot(occupied: boolean): HerdrSnapshot {
  return {
    workspaces: [{ id: "w1", tabs: [] }],
    tabs: [{ id: "w1:t1", workspaceId: "w1", panes: [] }],
    panes: [
      {
        id: "w1:p1",
        terminalId: "term_example",
        workspaceId: "w1",
        tabId: "w1:t1",
      },
    ],
    agents: occupied
      ? [
          {
            kind: "pi",
            paneId: "w1:p1",
            terminalId: "term_example",
            workspaceId: "w1",
            tabId: "w1:t1",
            sessionId: "session_example",
          },
        ]
      : [],
    worktrees: [],
  };
}

function retainedService(input: {
  snapshots: HerdrSnapshot[];
  calls: string[];
}): HerdrService {
  let index = 0;
  return new HerdrService({
    store: { state: { herdrResources: {} } } as never,
    provisioner: {} as never,
    cli: {
      requireMutationCapabilities: () => undefined,
      snapshot: async () =>
        input.snapshots[Math.min(index++, input.snapshots.length - 1)]!,
      quitAgent: async (target: string) => input.calls.push(`quit:${target}`),
      closeTab: async (target: string) => input.calls.push(`close:${target}`),
      reportPaneMetadata: async () => input.calls.push("report"),
    } as never,
  });
}

const guard = {
  workspaceId: "w1",
  tabId: "w1:t1",
  paneId: "w1:p1",
  terminalId: "term_example",
  sessionId: "session_example",
};

test("retained lifecycle publishes, exits Pi, and closes only the proven vacant tab", async () => {
  const publishCalls: string[] = [];
  await retainedService({
    snapshots: [retainedSnapshot(true)],
    calls: publishCalls,
  }).reportTaskMetadata(guard, payload() as never, 7);
  assert.deepEqual(publishCalls, ["report"]);

  const exitCalls: string[] = [];
  await retainedService({
    snapshots: [retainedSnapshot(true), retainedSnapshot(false)],
    calls: exitCalls,
  }).exitRetainingTab(guard);
  assert.deepEqual(exitCalls, ["quit:w1:p1"]);

  const closed: HerdrSnapshot = {
    workspaces: [{ id: "w1", tabs: [] }],
    tabs: [],
    panes: [],
    agents: [],
    worktrees: [],
  };
  const closeCalls: string[] = [];
  await retainedService({
    snapshots: [retainedSnapshot(false), closed],
    calls: closeCalls,
  }).closeRetainedTab(guard);
  assert.deepEqual(closeCalls, ["close:w1:t1"]);
});

test("retained exit and close accept only proven crash-window completion", async () => {
  const exitCalls: string[] = [];
  await retainedService({
    snapshots: [retainedSnapshot(false)],
    calls: exitCalls,
  }).exitRetainingTab(guard);
  assert.deepEqual(exitCalls, []);

  const absent: HerdrSnapshot = {
    workspaces: [{ id: "w1", tabs: [] }],
    tabs: [],
    panes: [],
    agents: [],
    worktrees: [],
  };
  const closeCalls: string[] = [];
  await retainedService({
    snapshots: [absent],
    calls: closeCalls,
  }).closeRetainedTab(guard);
  assert.deepEqual(closeCalls, []);

  const replacement = structuredClone(absent);
  replacement.panes.push({
    id: "w9:p9",
    terminalId: "term_example",
    workspaceId: "w1",
    tabId: "w1:t9",
  });
  const replacementCalls: string[] = [];
  await assert.rejects(
    retainedService({
      snapshots: [replacement],
      calls: replacementCalls,
    }).closeRetainedTab(guard),
    /HERDR_IDENTITY_MISMATCH/u,
  );
  assert.deepEqual(replacementCalls, []);
});

test("retained close rejects changed identity before mutation", async () => {
  const changed = retainedSnapshot(false);
  changed.panes[0]!.terminalId = "term_replaced";
  const calls: string[] = [];
  await assert.rejects(
    retainedService({ snapshots: [changed], calls }).closeRetainedTab(guard),
    /HERDR_IDENTITY_MISMATCH/,
  );
  assert.deepEqual(calls, []);
});
