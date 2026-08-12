import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId, isEntityId } from "../../src/shared/ids.js";
import { emptyState, reduce } from "../../src/state/reducer.js";
import { EventStore } from "../../src/state/event-store.js";
import {
  ParentToolService,
  mapParentToolInput,
  type ParentToolBroker,
} from "../../src/pi/parent-tools.js";
import {
  PARENT_TOOL_NAMES,
  parentToolMethod,
} from "../../src/pi/parent-tool-schema.js";
import { registerParentTools } from "../../src/pi/tools.js";

const principal = {
  id: "parent",
  kind: "pi_parent" as const,
  agentId: "agt_parent",
  permissions: ["manage:self", "read:state"],
};

test("requirement 10: control mappers preserve only exact public control fields", () => {
  assert.deepEqual(
    mapParentToolInput("agent_interrupt", {
      agentId: "agt_child",
      runId: "run_child",
      assignmentGeneration: 3,
      reason: "pause",
    }),
    {
      agentId: "agt_child",
      runId: "run_child",
      assignmentGeneration: 3,
      reason: "pause",
    },
  );
  assert.deepEqual(
    mapParentToolInput("agent_stop", {
      agentId: "agt_child",
      reason: "done",
      force: false,
    }),
    { agentId: "agt_child", reason: "done", force: false },
  );
  assert.deepEqual(
    mapParentToolInput("agent_close", {
      agentId: "agt_child",
      confirm: true,
    }),
    { agentId: "agt_child", confirm: true },
  );
});

test("requirement 11: peer ask uses a distinct broker method", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const broker: ParentToolBroker = {
    async invoke(method, params) {
      calls.push({ method, params });
      return {
        threadId: "thread",
        answer: "Peer answer",
        answers: ["Peer answer"],
      };
    },
  };
  const service = new ParentToolService(broker);
  const response = await service.execute(
    {
      tool: "agent_ask",
      input: {
        agentId: "agt_child",
        message: "Check this.",
        followUps: ["One", "Two", "Three"],
        timeoutMs: 1_000,
      },
    },
    principal,
  );
  assert.equal(response.ok, true);
  assert.equal((response.result as { answer: string }).answer, "Peer answer");
  assert.deepEqual(calls, [
    {
      method: "agent.ask",
      params: {
        agentId: "agt_child",
        message: "Check this.",
        followUps: ["One", "Two", "Three"],
        timeoutMs: 1_000,
      },
    },
  ]);
});

test("requirement 11: peer ask schema limits a thread to three follow-ups", () => {
  const tools: Array<{ name: string; parameters: unknown }> = [];
  registerParentTools(
    {
      registerTool: (tool: { name: string; parameters: unknown }) =>
        tools.push(tool),
    } as never,
    {} as never,
    {
      connected: true,
      principal: {
        id: "parent",
        kind: "pi_parent",
        permissions: ["manage:self"],
      },
    } as never,
  );
  const ask = tools.find((tool) => tool.name === "agent_ask");
  assert.ok(ask);
  const properties = (
    ask.parameters as { properties: Record<string, Record<string, unknown>> }
  ).properties;
  assert.equal(properties.followUps!.maxItems, 3);
});

test("requirements 12 and 13: groups replay through stopped and closed states", () => {
  const groupId = createId("grp");
  assert.equal(isEntityId(groupId, "grp"), true);
  let state = reduce(emptyState(), {
    type: "group.created",
    actor: { principalId: "parent", kind: "pi_parent" },
    entityRefs: { groupId },
    payload: {
      groupId,
      name: "reviewers",
      agentIds: ["agt_one", "agt_two"],
      createdAt: "2026-08-12T00:00:00.000Z",
    },
  });
  assert.equal(state.groups?.[groupId]?.state, "open");
  state = reduce(state, {
    type: "group.stopped",
    actor: { principalId: "parent", kind: "pi_parent" },
    entityRefs: { groupId },
    payload: { groupId, at: "2026-08-12T00:01:00.000Z" },
  });
  assert.equal(state.groups?.[groupId]?.state, "stopped");
  state = reduce(state, {
    type: "group.closed",
    actor: { principalId: "parent", kind: "pi_parent" },
    entityRefs: { groupId },
    payload: {
      groupId,
      at: "2026-08-12T00:02:00.000Z",
      confirm: true,
    },
  });
  assert.equal(state.groups?.[groupId]?.state, "closed");
});

test("requirement 13: group events persist and replay as canonical state", async () => {
  const root = await mkdtemp(join(tmpdir(), "controls-groups-"));
  const path = join(root, "events.jsonl");
  const groupId = createId("grp");
  const store = new EventStore(path);
  await store.open();
  await store.append({
    type: "group.created",
    actor: { principalId: createId("prn"), kind: "pi_parent" },
    entityRefs: { groupId },
    payload: {
      groupId,
      name: "pair",
      agentIds: ["agt_one", "agt_two"],
      createdAt: "2026-08-12T00:00:00.000Z",
    },
  });
  const replay = new EventStore(path);
  await replay.open();
  assert.deepEqual(replay.state.groups?.[groupId]?.agentIds, [
    "agt_one",
    "agt_two",
  ]);
});

test("requirements 14 to 16: central waits and groups are registered without replacing agent_wait", () => {
  for (const name of [
    "coordination_wait",
    "coordination_signal",
    "group_create",
    "group_list",
    "group_get",
    "group_wait",
    "group_stop",
    "group_close",
  ] as const)
    assert.equal(PARENT_TOOL_NAMES.includes(name), true, name);
  assert.equal(parentToolMethod("coordination_wait"), "coordination.wait");
  assert.equal(parentToolMethod("group_wait"), "group.wait");
  assert.equal(parentToolMethod("agent_wait"), "agent.wait");
  assert.equal(parentToolMethod("agent_ask"), "agent.ask");
});
