import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256 } from "../../src/shared/canonical-json.js";
import { emptyState, reduce } from "../../src/state/reducer.js";
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
  piSessionRef: "pis_example",
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
const event = (value: Record<string, unknown>) => ({
  type: "herdr.metadata_projected",
  actor: { principalId: "system", kind: "system" },
  entityRefs: {
    workflowId: "wfl_example",
    taskId: "tsk_example",
    runId: "run_example",
    agentId: "agt_example",
    workflowDigest: "a".repeat(64),
  },
  payload: value,
});

test("Herdr metadata projection replays safe exact correlation", () => {
  const state = reduce(emptyState(), event(payload()));
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
  const terminal = reduce(emptyState(), event(payload({ state: "completed" })));
  assert.throws(() => reduce(terminal, event(payload({ state: "working" }))));
  assert.throws(() =>
    reduce(
      reduce(emptyState(), event(payload())),
      event(payload({ runId: "run_other" })),
    ),
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
