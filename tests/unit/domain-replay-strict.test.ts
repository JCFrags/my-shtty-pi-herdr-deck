import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, sha256 } from "../../src/shared/canonical-json.js";
import { createId } from "../../src/shared/ids.js";
import { EventStore } from "../../src/state/event-store.js";
import { emptyState, reduce } from "../../src/state/reducer.js";

type Rec = Record<string, unknown>;
type EventRec = Rec & { payload: Rec; entityRefs: Rec; hash?: unknown };
const actor = {
  principalId: "prn_00000000000000000000000000",
  kind: "system" as const,
};
const timeout = "2026-01-01T00:15:00.000Z";
const reason = { code: "TIMEOUT", message: "The task wall deadline expired." };
async function fresh() {
  const root = await mkdtemp(join(tmpdir(), "strict-replay-"));
  const store = new EventStore(join(root, "events.jsonl"), actor);
  await store.open();
  return { root, store };
}
function taskPayload(taskId: string, extra: Rec = {}) {
  return {
    taskId,
    title: "Strict task",
    objective: "line one\nline two",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}
function runPayload(
  runId: string,
  taskId: string,
  agentId: string,
  extra: Rec = {},
) {
  return {
    runId,
    taskId,
    agentId,
    assignmentId: createId("asg"),
    assignmentGeneration: 1,
    agentGeneration: 1,
    ...extra,
  };
}
async function seed(store: EventStore, withRun = true) {
  const taskId = createId("tsk"),
    runId = createId("run"),
    agentId = createId("agt");
  await store.append({
    type: "task.created_m3",
    actor,
    entityRefs: { taskId },
    payload: taskPayload(taskId, { timeoutAt: timeout }),
  });
  if (withRun)
    await store.append({
      type: "run.created",
      actor,
      entityRefs: { runId, taskId, agentId },
      payload: {
        runId,
        taskId,
        agentId,
        assignmentId: createId("asg"),
        assignmentGeneration: 1,
        agentGeneration: 1,
        timeoutAt: timeout,
      },
    });
  return { taskId, runId };
}
async function rewriteAndRequireReadonly(
  path: string,
  index: number,
  mutate: (event: EventRec) => void,
) {
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  const event = JSON.parse(lines[index]!) as EventRec;
  mutate(event);
  event.hash = sha256(canonicalJson({ ...event, hash: undefined }));
  lines[index] = canonicalJson(event);
  await writeFile(path, `${lines.join("\n")}\n`);
  const replay = new EventStore(path, actor);
  await replay.open();
  assert.equal(replay.readOnly, true);
  assert.match(replay.corruption ?? "", /event|invalid|state|deadline/i);
}

test("agent generation changes only through replacement replay", () => {
  const agentId = "agt_generation_guard";
  const actor = {
    principalId: "prn_00000000000000000000000000",
    kind: "system",
  };
  const event = (type: string, generation: number) => ({
    type,
    actor,
    entityRefs: { agentId },
    payload: { agentId, generation },
  });
  let state = reduce(emptyState(), {
    type: "agent.registered",
    actor,
    entityRefs: { agentId },
    payload: { agentId, generation: 1, managed: true },
  });
  assert.equal(state.agents[agentId]?.generation, 1);
  for (const type of ["agent.heartbeat", "agent.moved", "agent.state_changed"])
    state = reduce(state, event(type, 9));
  assert.equal(state.agents[agentId]?.generation, 1);
  state = reduce(state, event("agent.replaced", 2));
  assert.equal(state.agents[agentId]?.generation, 2);
  for (const type of ["agent.heartbeat", "agent.moved", "agent.state_changed"])
    state = reduce(state, event(type, 11));
  assert.equal(state.agents[agentId]?.generation, 2);
});

test("multiline objective and legacy task replay pass", async () => {
  const { root, store } = await fresh();
  try {
    const { taskId } = await seed(store, false);
    const replay = new EventStore(join(root, "events.jsonl"), actor);
    await replay.open();
    assert.equal(replay.state.tasks[taskId]?.objective, "line one\nline two");
    assert.equal(replay.state.tasks[taskId]?.timeoutAt, timeout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("append rejects malformed task optionals and deadlines", async () => {
  const cases: Rec[] = [
    { parentAgentId: "bad" },
    { workflowId: "bad" },
    { profileId: "\u0000" },
    { profileId: "x".repeat(257) },
    { dependencies: ["bad"] },
    { dependencies: new Array(65).fill(createId("tsk")) },
    { project: { cwd: "/tmp", workspaceId: "w", privateField: true } },
    { project: { cwd: "\u0000", workspaceId: "w" } },
    { timeoutAt: "bad" },
    { timeoutAt: "2026-01-01T00:15:00+00:00" },
    { timeoutAt: "2025-12-31T23:59:59.000Z" },
    { timeoutAt: "2026-01-02T00:16:00.000Z" },
  ];
  for (const extra of cases) {
    const { root, store } = await fresh();
    try {
      const id = createId("tsk");
      await assert.rejects(
        store.append({
          type: "task.created_m3",
          actor,
          entityRefs: { taskId: id },
          payload: taskPayload(id, extra),
        }),
        /invalid/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("append rejects run optional identities, assignment, and deadline symmetry", async () => {
  const changes: Rec[] = [
    { assignmentId: "bad" },
    { piSessionId: "" },
    { piSessionId: "\u0000" },
    { terminalId: "" },
    { terminalId: "\u0001" },
    { paneId: "" },
    { paneId: "\u0001" },
    { timeoutAt: "2026-01-01T00:16:00.000Z" },
  ];
  for (const change of changes) {
    const { root, store } = await fresh();
    try {
      const { taskId, runId } = await seed(store, false);
      const agentId = createId("agt");
      const payload: Rec = {
        runId,
        taskId,
        agentId,
        assignmentId: createId("asg"),
        assignmentGeneration: 1,
        agentGeneration: 1,
        timeoutAt: timeout,
        ...change,
      };
      if (change.timeoutAt === undefined) delete payload.timeoutAt;
      await assert.rejects(
        store.append({
          type: "run.created",
          actor,
          entityRefs: { runId, taskId, agentId },
          payload,
        }),
        /invalid|deadline/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("strict task and run append matrix rejects malformed optional identities", async () => {
  const taskCases: Array<(payload: Rec) => void> = [
    (payload) => {
      payload.parentAgentId = "bad";
    },
    (payload) => {
      payload.workflowId = "bad";
    },
    (payload) => {
      payload.profileId = "";
    },
    (payload) => {
      payload.profileId = "x".repeat(257);
    },
  ];
  for (const mutate of taskCases) {
    const { root, store } = await fresh();
    try {
      const taskId = createId("tsk");
      const payload = taskPayload(taskId);
      mutate(payload);
      await assert.rejects(
        store.append({
          type: "task.created_m3",
          actor,
          entityRefs: { taskId },
          payload,
        }),
        /invalid/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const runCases: Array<(refs: Record<string, string>, payload: Rec) => void> =
    [
      (refs) => {
        refs.taskId = createId("tsk");
      },
      (_refs, payload) => {
        payload.taskId = createId("tsk");
      },
      (refs) => {
        refs.agentId = createId("agt");
      },
      (_refs, payload) => {
        payload.agentId = createId("agt");
      },
      (_refs, payload) => {
        payload.assignmentGeneration = "1";
      },
      (_refs, payload) => {
        payload.assignmentGeneration = 1.5;
      },
      (_refs, payload) => {
        payload.assignmentGeneration = -1;
      },
      (_refs, payload) => {
        payload.agentGeneration = "1";
      },
      (_refs, payload) => {
        payload.agentGeneration = 1.5;
      },
      (_refs, payload) => {
        payload.agentGeneration = -1;
      },
      (_refs, payload) => {
        payload.piSessionId = "x".repeat(257);
      },
      (_refs, payload) => {
        payload.terminalId = "x".repeat(257);
      },
    ];
  for (const mutate of runCases) {
    const { root, store } = await fresh();
    try {
      const { taskId } = await seed(store, false);
      const runId = createId("run");
      const agentId = createId("agt");
      const refs: Record<string, string> = { runId, taskId, agentId };
      const payload = runPayload(runId, taskId, agentId);
      mutate(refs, payload);
      await assert.rejects(
        store.append({
          type: "run.created",
          actor,
          entityRefs: refs,
          payload,
        }),
        /invalid/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("valid finite task optionals append and replay", async () => {
  const projects = [
    { cwd: "/tmp/project", workspaceId: "workspace" },
    {
      cwd: "/tmp/project",
      workspaceId: "workspace",
      isolation: "shared-readonly",
    },
    {
      cwd: "/tmp/project",
      workspaceId: "workspace",
      worktreeId: "worktree",
      isolation: "shared-readonly",
    },
  ];
  const profiles = ["p", "x".repeat(256)];
  for (const project of projects)
    for (const profileId of profiles) {
      const { root, store } = await fresh();
      try {
        const taskId = createId("tsk");
        const parentAgentId = createId("agt");
        const workflowId = createId("wfl");
        await store.append({
          type: "task.created_m3",
          actor,
          entityRefs: { taskId },
          payload: taskPayload(taskId, {
            parentAgentId,
            workflowId,
            profileId,
            project,
          }),
        });
        const replay = new EventStore(join(root, "events.jsonl"), actor);
        await replay.open();
        assert.equal(replay.readOnly, false);
        assert.equal(replay.state.tasks[taskId]?.profileId, profileId);
        assert.deepEqual(replay.state.tasks[taskId]?.project, project);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
});

test("task timeout reasons require exact canonical summaries", async () => {
  const valid = [
    { code: "TIMEOUT", message: "The task wall deadline expired." },
    { code: "BUDGET_EXCEEDED", message: "The configured budget was exceeded." },
  ];
  for (const reason of valid) {
    const { root, store } = await fresh();
    try {
      const { taskId } = await seed(store, false);
      await store.append({
        type: "task.state_changed",
        actor,
        entityRefs: { taskId },
        payload: { to: "timed_out", reason },
      });
      const replay = new EventStore(join(root, "events.jsonl"), actor);
      await replay.open();
      assert.equal(replay.readOnly, false);
      assert.equal(replay.state.tasks[taskId]?.state, "timed_out");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const invalid: Rec[] = [
    { to: "timed_out", reason: { code: "WRONG", message: reason.message } },
    { to: "timed_out", reason: { code: "TIMEOUT", message: "wrong" } },
    { to: "timed_out", reason: { code: "TIMEOUT" } },
    {
      to: "timed_out",
      reason: {
        code: "TIMEOUT",
        message: "The task wall deadline expired.",
        extra: true,
      },
    },
    {
      to: "queued",
      reason,
    },
  ];
  for (const payload of invalid) {
    const { root, store } = await fresh();
    try {
      const { taskId } = await seed(store, false);
      await assert.rejects(
        store.append({
          type: "task.state_changed",
          actor,
          entityRefs: { taskId },
          payload,
        }),
        /invalid/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("run state producers append and replay every frozen state form", async () => {
  const states: Array<{ state: string; reason?: Rec }> = [
    { state: "created" },
    { state: "working" },
    { state: "blocked" },
    { state: "result_pending" },
    { state: "result_pending_missing" },
    { state: "settled" },
    { state: "failed" },
    { state: "succeeded" },
    { state: "cancelled" },
    {
      state: "timed_out",
      reason: { code: "TIMEOUT", message: reason.message },
    },
    { state: "lost" },
  ];
  for (const transition of states) {
    const { root, store } = await fresh();
    try {
      const { taskId, runId } = await seed(store);
      await store.append({
        type: "run.state_changed",
        actor,
        entityRefs: { runId, taskId },
        payload: { runId, ...transition },
      });
      const replay = new EventStore(join(root, "events.jsonl"), actor);
      await replay.open();
      assert.equal(replay.readOnly, false);
      assert.equal(replay.state.runs[runId]?.state, transition.state);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("valid prompting and budget producers append and replay", async () => {
  const { root, store } = await fresh();
  try {
    const { taskId, runId } = await seed(store);
    await store.append({
      type: "run.state_changed",
      actor,
      entityRefs: { runId, taskId },
      payload: { runId, state: "prompting" },
    });
    await store.append({
      type: "run.state_changed",
      actor,
      entityRefs: { runId, taskId },
      payload: {
        runId,
        state: "timed_out",
        reason: {
          code: "BUDGET_EXCEEDED",
          message: "The configured budget was exceeded.",
        },
      },
    });
    const replay = new EventStore(join(root, "events.jsonl"), actor);
    await replay.open();
    assert.equal(replay.state.runs[runId]?.state, "timed_out");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("append rejects ref, payload, state-reason, and task identity mismatches", async () => {
  const { root, store } = await fresh();
  try {
    const taskId = createId("tsk"),
      otherTask = createId("tsk"),
      runId = createId("run"),
      agentId = createId("agt");
    await store.append({
      type: "task.created_m3",
      actor,
      entityRefs: { taskId },
      payload: taskPayload(taskId),
    });
    await assert.rejects(
      store.append({
        type: "task.created_m3",
        actor,
        entityRefs: { taskId },
        payload: taskPayload(otherTask),
      }),
      /invalid/i,
    );
    await store.append({
      type: "run.created",
      actor,
      entityRefs: { runId, taskId, agentId },
      payload: {
        runId,
        taskId,
        agentId,
        assignmentId: createId("asg"),
        assignmentGeneration: 1,
        agentGeneration: 1,
      },
    });
    await assert.rejects(
      store.append({
        type: "run.state_changed",
        actor,
        entityRefs: { runId, taskId: otherTask },
        payload: { runId, state: "prompting" },
      }),
      /invalid/i,
    );
    await assert.rejects(
      store.append({
        type: "run.state_changed",
        actor,
        entityRefs: { runId, taskId },
        payload: { runId, state: "working", reason },
      }),
      /invalid/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid legacy timeout omissions derive exact values", async () => {
  const { root, store } = await fresh();
  try {
    const taskId = createId("tsk"),
      runId = createId("run"),
      agentId = createId("agt");
    await store.append({
      type: "task.created_m3",
      actor,
      entityRefs: { taskId },
      payload: taskPayload(taskId),
    });
    await store.append({
      type: "run.created",
      actor,
      entityRefs: { runId, taskId, agentId },
      payload: {
        runId,
        taskId,
        agentId,
        assignmentId: createId("asg"),
        assignmentGeneration: 1,
        agentGeneration: 1,
      },
    });
    assert.equal(store.state.tasks[taskId]?.timeoutAt, timeout);
    assert.equal(store.state.runs[runId]?.timeoutAt, timeout);
    const replay = new EventStore(join(root, "events.jsonl"), actor);
    await replay.open();
    assert.equal(replay.readOnly, false);
    assert.equal(replay.state.runs[runId]?.timeoutAt, timeout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid-hash replay tampering fails closed across strict variants", async () => {
  const runCases: Array<(e: EventRec) => void> = [
    (e) => {
      e.entityRefs.runId = createId("run");
    },
    (e) => {
      e.payload.runId = createId("run");
    },
    (e) => {
      e.payload.state = "unknown";
    },
    (e) => {
      e.entityRefs.taskId = createId("tsk");
    },
    (e) => {
      e.payload.state = "working";
    },
    (e) => {
      e.payload.reason = { code: "WRONG", message: "wrong" };
    },
    (e) => {
      e.payload.reason = { code: "TIMEOUT", message: "wrong" };
    },
    (e) => {
      (e.payload.reason as Rec).extra = true;
    },
    (e) => {
      delete (e.payload.reason as Rec).message;
    },
  ];
  for (const mutate of runCases) {
    const { root, store } = await fresh();
    try {
      const { taskId, runId } = await seed(store);
      await store.append({
        type: "run.state_changed",
        actor,
        entityRefs: { runId, taskId },
        payload: { runId, state: "timed_out", reason },
      });
      await rewriteAndRequireReadonly(join(root, "events.jsonl"), 2, mutate);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const taskCases: Array<(e: EventRec) => void> = [
    (e) => {
      e.payload.timeoutAt = "bad";
    },
    (e) => {
      e.payload.timeoutAt = "2026-01-01T00:15:00+00:00";
    },
    (e) => {
      e.payload.timeoutAt = "2025-12-31T23:59:59.000Z";
    },
    (e) => {
      e.payload.timeoutAt = "2026-01-02T00:16:00.000Z";
    },
    (e) => {
      e.payload.dependencies = ["bad"];
    },
    (e) => {
      e.payload.profileId = "\u0000";
    },
    (e) => {
      e.payload.profileId = "x".repeat(257);
    },
    (e) => {
      e.payload.dependencies = new Array(65).fill(createId("tsk"));
    },
    (e) => {
      e.payload.project = { cwd: "\u0000", workspaceId: "w" };
    },
    (e) => {
      e.payload.project = { cwd: "/tmp", workspaceId: "" };
    },
    (e) => {
      e.payload.project = { cwd: "/tmp", workspaceId: "w", extra: true };
    },
    (e) => {
      e.payload.taskId = createId("tsk");
    },
    (e) => {
      e.payload.parentAgentId = "bad";
    },
    (e) => {
      e.payload.workflowId = "bad";
    },
    (e) => {
      e.payload.profileId = "";
    },
    (e) => {
      e.payload.profileId = "x".repeat(257);
    },
  ];
  for (const mutate of taskCases) {
    const { root, store } = await fresh();
    try {
      await seed(store, false);
      await rewriteAndRequireReadonly(join(root, "events.jsonl"), 0, mutate);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const runCases2: Array<(e: EventRec) => void> = [
    (e) => {
      e.payload.assignmentId = "bad";
    },
    (e) => {
      e.payload.piSessionId = "";
    },
    (e) => {
      e.payload.piSessionId = "\u0000";
    },
    (e) => {
      e.payload.terminalId = "";
    },
    (e) => {
      e.payload.terminalId = "\u0001";
    },
    (e) => {
      e.payload.paneId = "";
    },
    (e) => {
      e.payload.paneId = "\u0001";
    },
    (e) => {
      e.payload.timeoutAt = "2026-01-01T00:16:00.000Z";
    },
    (e) => {
      e.payload.timeoutAt = "bad";
    },
    (e) => {
      e.payload.timeoutAt = "2026-01-01T00:15:00+00:00";
    },
    (e) => {
      e.entityRefs.agentId = createId("agt");
    },
    (e) => {
      e.payload.agentId = createId("agt");
    },
    (e) => {
      e.payload.taskId = createId("tsk");
    },
    (e) => {
      e.payload.assignmentGeneration = "1";
    },
    (e) => {
      e.payload.assignmentGeneration = 1.5;
    },
    (e) => {
      e.payload.assignmentGeneration = -1;
    },
    (e) => {
      e.payload.agentGeneration = "1";
    },
    (e) => {
      e.payload.agentGeneration = 1.5;
    },
    (e) => {
      e.payload.agentGeneration = -1;
    },
    (e) => {
      e.payload.piSessionId = "x".repeat(257);
    },
    (e) => {
      e.payload.terminalId = "x".repeat(257);
    },
  ];
  for (const mutate of runCases2) {
    const { root, store } = await fresh();
    try {
      await seed(store);
      await rewriteAndRequireReadonly(join(root, "events.jsonl"), 1, mutate);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const taskStateCases: Array<(e: EventRec) => void> = [
    (e) => {
      (e.payload.reason as Rec).code = "WRONG";
    },
    (e) => {
      (e.payload.reason as Rec).message = "wrong";
    },
    (e) => {
      delete (e.payload.reason as Rec).message;
    },
    (e) => {
      (e.payload.reason as Rec).extra = true;
    },
    (e) => {
      e.payload.to = "queued";
    },
  ];
  for (const mutate of taskStateCases) {
    const { root, store } = await fresh();
    try {
      const { taskId } = await seed(store, false);
      await store.append({
        type: "task.state_changed",
        actor,
        entityRefs: { taskId },
        payload: { to: "timed_out", reason },
      });
      await rewriteAndRequireReadonly(join(root, "events.jsonl"), 1, mutate);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("terminal runs reject late adapter progress and replay rejects valid-hash resurrection", async () => {
  const { root, store } = await fresh();
  try {
    const { taskId, runId } = await seed(store);
    const run = store.state.runs[runId]!;
    await store.append({
      type: "run.state_changed",
      actor,
      entityRefs: { runId, taskId },
      payload: { runId, state: "settled" },
    });
    await assert.rejects(
      store.append({
        type: "assignment.accepted",
        actor,
        entityRefs: { runId, taskId },
        payload: {
          assignmentId: run.assignmentId,
          runId,
          taskId,
          agentId: run.agentId,
          generation: 1,
          assignmentGeneration: run.assignmentGeneration,
          piSessionId: "strict-pi",
          connectionGeneration: 1,
          deliveryState: "accepted",
        },
      }),
      /terminal run/i,
    );
    await store.append({
      type: "run.state_changed",
      actor,
      entityRefs: { runId, taskId },
      payload: { runId, state: "succeeded" },
    });
    const assignmentPayload = {
      assignmentId: run.assignmentId,
      runId,
      taskId,
      agentId: run.agentId,
      generation: 1,
      assignmentGeneration: run.assignmentGeneration,
      piSessionId: "strict-pi",
      connectionGeneration: 1,
      deliveryState: "accepted",
    };
    for (const type of [
      "assignment.delivered",
      "assignment.accepted",
      "assignment.delivery_failed",
      "run.pi_started",
      "run.pi_settled",
    ] as const) {
      await assert.rejects(
        store.append({
          type,
          actor,
          entityRefs: { runId, taskId },
          payload:
            type === "assignment.accepted"
              ? assignmentPayload
              : {
                  runId,
                  taskId,
                  agentId: run.agentId,
                  piSessionId: "strict-pi",
                  ...(type === "run.pi_started"
                    ? { agentCycleId: "strict-cycle", turnIndex: 1 }
                    : {}),
                },
        }),
        /terminal run/i,
      );
    }
    await assert.rejects(
      store.append({
        type: "run.state_changed",
        actor,
        entityRefs: { runId, taskId },
        payload: { runId, state: "failed" },
      }),
      /terminal run/i,
    );
    const replayCases = [
      {
        type: "run.state_changed",
        payload: { runId, state: "succeeded" },
      },
      {
        type: "assignment.delivered",
        payload: {
          assignmentId: run.assignmentId,
          runId,
          taskId,
          agentId: run.agentId,
          generation: 1,
          assignmentGeneration: run.assignmentGeneration,
          piSessionId: "strict-pi",
          connectionGeneration: 1,
          deliveryState: "pending",
        },
      },
      {
        type: "run.pi_started",
        payload: {
          runId,
          taskId,
          agentId: run.agentId,
          piSessionId: "strict-pi",
          agentCycleId: "strict-cycle",
          turnIndex: 1,
        },
      },
    ] as const;
    for (const late of replayCases) {
      const replayRoot = await mkdtemp(
        join(tmpdir(), "strict-replay-terminal-"),
      );
      try {
        const replayStore = new EventStore(
          join(replayRoot, "events.jsonl"),
          actor,
        );
        await replayStore.open();
        const seeded = await seed(replayStore);
        await replayStore.append({
          type: "run.state_changed",
          actor,
          entityRefs: { runId: seeded.runId, taskId: seeded.taskId },
          payload: { runId: seeded.runId, state: "failed" },
        });
        const lines = (await readFile(join(replayRoot, "events.jsonl"), "utf8"))
          .trim()
          .split("\n");
        const previous = JSON.parse(lines.at(-1)!) as EventRec;
        const payload = structuredClone(late.payload) as Rec;
        payload.runId = seeded.runId;
        if (payload.taskId === taskId) payload.taskId = seeded.taskId;
        const base = {
          schemaVersion: 1,
          seq: Number(previous.seq) + 1,
          id: createId("evt"),
          timestamp: "2026-01-01T00:20:00.000Z",
          type: late.type,
          actor,
          entityRefs: { runId: seeded.runId, taskId: seeded.taskId },
          payload,
          prevHash: previous.hash,
        };
        lines.push(
          canonicalJson({ ...base, hash: sha256(canonicalJson(base)) }),
        );
        await writeFile(
          join(replayRoot, "events.jsonl"),
          `${lines.join("\n")}\n`,
        );
        const replay = new EventStore(join(replayRoot, "events.jsonl"), actor);
        await replay.open();
        assert.equal(replay.readOnly, true, late.type);
        assert.match(replay.corruption ?? "", /terminal run|state/i, late.type);
      } finally {
        await rm(replayRoot, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
