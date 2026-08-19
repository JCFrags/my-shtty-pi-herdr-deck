import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256 } from "../../src/shared/canonical-json.js";
import { emptyState, reduce } from "../../src/state/reducer.js";

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
    taskId: "tsk_example",
    runId: "run_example",
    agentId: "agt_example",
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
