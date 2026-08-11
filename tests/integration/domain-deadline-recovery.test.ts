import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import { resolvePaths } from "../../src/shared/paths.js";
import { createId } from "../../src/shared/ids.js";
const actor = {
  principalId: "prn_00000000000000000000000000",
  kind: "system" as const,
};
async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function makePaths(root: string, runtime: string) {
  return {
    ...resolvePaths(join(runtime, "herdr.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
}
async function durableTask(
  broker: Broker,
  taskId: string,
  timeoutAt: string,
  state: "queued" | "assigned" = "queued",
): Promise<void> {
  await broker.store.append({
    type: "task.created_m3",
    actor,
    entityRefs: { taskId },
    payload: {
      taskId,
      title: "deadline",
      objective: "deadline",
      createdAt: new Date(Date.parse(timeoutAt) - 60_000).toISOString(),
      timeoutAt,
      project: { cwd: "/tmp/project", workspaceId: "w" },
    },
  });
  if (state === "assigned")
    await broker.store.append({
      type: "task.state_changed",
      actor,
      entityRefs: { taskId },
      payload: { to: "assigned" },
    });
}

test("broker restart reschedules a future task wall deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "deadline-restart-"));
  const runtime = await mkdtemp(join(tmpdir(), "deadline-restart-runtime-"));
  const paths = makePaths(root, runtime);
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const timers: Array<{
    delay: number;
    callback: () => void;
    handle: NodeJS.Timeout;
  }> = [];
  const schedule = (callback: () => void, delay: number) => {
    const handle = setTimeout(() => undefined, 2_000_000);
    handle.unref();
    timers.push({ callback, delay, handle });
    return handle;
  };
  const make = (clock: () => number) =>
    new Broker(paths, { now: clock, setTimeout: schedule });
  let broker = make(() => now);
  await broker.start();
  try {
    await broker.stop();
    await durableTask(
      broker,
      "tsk_01J1Q0Q0Q0Q0Q0Q0Q0Q0Q0Q0Q0",
      new Date(now + 60_000).toISOString(),
    );
    broker = make(() => now + 10_000);
    await broker.start();
    assert.equal(
      broker.store.state.tasks["tsk_01J1Q0Q0Q0Q0Q0Q0Q0Q0Q0Q0Q0"]?.state,
      "queued",
    );
    assert.ok(timers.some((timer) => timer.delay === 50_000));
  } finally {
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("broker restart terminalizes an expired queued task before provisioning", async () => {
  const root = await mkdtemp(join(tmpdir(), "deadline-expired-"));
  const runtime = await mkdtemp(join(tmpdir(), "deadline-expired-runtime-"));
  const paths = makePaths(root, runtime);
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  let provisions = 0;
  const make = () =>
    new Broker(paths, {
      now: () => now,
      herdrFactory: async (store) =>
        ({
          store,
          startupReconcile: async () => [],
          provision: async () => {
            provisions++;
            throw new Error("expired work was provisioned");
          },
        }) as never,
    });
  let broker = make();
  await broker.start();
  try {
    await broker.stop();
    await durableTask(
      broker,
      "tsk_01J1Q0Q0Q0Q0Q0Q0Q0Q0Q0Q0Q1",
      new Date(now - 1).toISOString(),
    );
    broker = make();
    await broker.start();
    const timedOutTask =
      broker.store.state.tasks["tsk_01J1Q0Q0Q0Q0Q0Q0Q0Q0Q0Q0Q1"]!;
    assert.equal(timedOutTask.state, "timed_out");
    assert.deepEqual(timedOutTask.terminalReason, {
      code: "TIMEOUT",
      message: "The task wall deadline expired.",
    });
    assert.equal(provisions, 0);
  } finally {
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production restart recovers question and task deadlines in chronological order", async () => {
  const cases = [
    {
      name: "question-earlier",
      taskAt: 20_000,
      questionAt: 10_000,
      first: "question.timed_out",
    },
    {
      name: "task-earlier",
      taskAt: 10_000,
      questionAt: 20_000,
      first: "run.state_changed",
    },
    {
      name: "equal-task-first",
      taskAt: 10_000,
      questionAt: 10_000,
      first: "run.state_changed",
    },
  ] as const;
  for (const scenario of cases) {
    const root = await mkdtemp(
      join(tmpdir(), `deadline-order-${scenario.name}-`),
    );
    const runtime = await mkdtemp(
      join(tmpdir(), `deadline-order-${scenario.name}-runtime-`),
    );
    const paths = makePaths(root, runtime);
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    let broker = new Broker(paths, { now: () => now });
    await broker.start();
    try {
      await broker.stop();
      const taskId = createId("tsk");
      const runId = createId("run");
      const agentId = createId("agt");
      const assignmentId = createId("asg");
      const questionId = createId("qst");
      const taskAt = new Date(now + scenario.taskAt).toISOString();
      const questionAt = new Date(
        now + scenario.questionAt - 10_000,
      ).toISOString();
      await broker.store.append({
        type: "task.created_m3",
        actor,
        entityRefs: { taskId },
        payload: {
          taskId,
          title: "order",
          objective: "order",
          createdAt: new Date(now).toISOString(),
          timeoutAt: taskAt,
        },
      });
      await broker.store.append({
        type: "run.created",
        actor,
        entityRefs: { runId, taskId, agentId },
        payload: {
          runId,
          taskId,
          agentId,
          assignmentId,
          assignmentGeneration: 1,
          agentGeneration: 1,
          timeoutAt: taskAt,
        },
      });
      await broker.store.append({
        type: "question.opened",
        actor,
        entityRefs: {
          questionId: questionId,
          taskId,
          runId,
          agentId,
        },
        payload: {
          questionId: questionId,
          assignmentGeneration: 1,
          toolCallId: "order",
          payload: {
            schemaVersion: 1,
            prompt: "order",
            context: null,
            options: [],
            allowFreeform: true,
            defaultOptionId: null,
            timeoutMs: scenario.questionAt,
          },
          askedAt: questionAt,
        },
      });
      const beforeRecoverySeq = broker.store.state.lastEventSeq;
      broker = new Broker(paths, { now: () => now + 30_000 });
      await broker.start();
      const recovery = Object.values(broker.store.events)
        .filter((event) => event.seq > beforeRecoverySeq)
        .sort((left, right) => left.seq - right.seq);
      const recoveryTypes = recovery.map((event) => event.type);
      if (scenario.name === "question-earlier") {
        assert.ok(recoveryTypes.includes("question.timed_out"));
        assert.ok(recoveryTypes.includes("run.state_changed"));
        assert.ok(
          recoveryTypes.indexOf("question.timed_out") <
            recoveryTypes.lastIndexOf("run.state_changed"),
          recoveryTypes.join(","),
        );
      } else {
        assert.equal(recoveryTypes.includes("question.timed_out"), false);
        assert.ok(recoveryTypes.includes("question.cancelled"));
        const timeoutRun = recovery.find(
          (event) =>
            event.type === "run.state_changed" &&
            (event.payload as Record<string, unknown>).state === "timed_out",
        );
        assert.ok(timeoutRun);
        assert.deepEqual(
          (timeoutRun!.payload as Record<string, unknown>).reason,
          { code: "TIMEOUT", message: "The task wall deadline expired." },
        );
        assert.equal(broker.store.state.runs[runId]?.state, "timed_out");
        assert.equal(broker.store.state.tasks[taskId]?.state, "timed_out");
        assert.ok(
          recoveryTypes.indexOf("question.cancelled") <
            recoveryTypes.indexOf("run.state_changed"),
          recoveryTypes.join(","),
        );
      }
    } finally {
      await broker.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      await rm(runtime, { recursive: true, force: true });
    }
  }
});

test("production restart rejects question delivery before one exact fallback stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "deadline-active-restart-"));
  const runtime = await mkdtemp(
    join(tmpdir(), "deadline-active-restart-runtime-"),
  );
  const paths = makePaths(root, runtime);
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  let stopResolve!: () => void;
  const stopObserved = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });
  const stops: unknown[] = [];
  const make = () =>
    new Broker(paths, {
      now: () => now,
      herdrFactory: async (store) =>
        ({
          store,
          startupReconcile: async () => [],
          stop: async (identity: unknown) => {
            stops.push(identity);
            stopResolve();
          },
        }) as never,
    });
  let broker = make();
  await broker.start();
  try {
    await broker.stop();
    const taskId = createId("tsk");
    const runId = createId("run");
    const agentId = createId("agt");
    const questionId = createId("qst");
    const assignmentId = createId("asg");
    const timeoutAt = new Date(now - 1).toISOString();
    await broker.store.append({
      type: "agent.registered",
      actor,
      entityRefs: { agentId },
      payload: {
        agentId,
        managed: true,
        generation: 1,
        paneId: "pane-active",
        terminalId: "term-active",
        piSessionId: "pi-active",
        connectionGeneration: 1,
      },
    });
    await broker.store.append({
      type: "herdr.provision.intent",
      actor,
      entityRefs: { agentId },
      payload: { agentId },
    });
    await broker.store.append({
      type: "herdr.provision.outcome",
      actor,
      entityRefs: { agentId },
      payload: {
        agentId,
        state: "registered",
        paneId: "pane-active",
        terminalId: "term-active",
        sessionId: "pi-active",
        generation: 1,
        ownerId: agentId,
      },
    });
    await broker.store.append({
      type: "task.created_m3",
      actor,
      entityRefs: { taskId },
      payload: {
        taskId,
        title: "active expired",
        objective: "active expired",
        createdAt: new Date(now - 60_000).toISOString(),
        timeoutAt,
      },
    });
    await broker.store.append({
      type: "run.created",
      actor,
      entityRefs: { runId, taskId, agentId },
      payload: {
        runId,
        taskId,
        agentId,
        assignmentId,
        assignmentGeneration: 1,
        agentGeneration: 1,
        piSessionId: "pi-active",
        terminalId: "term-active",
        timeoutAt,
      },
    });
    await broker.store.append({
      type: "question.opened",
      actor,
      entityRefs: { questionId, taskId, runId, agentId },
      payload: {
        questionId,
        assignmentGeneration: 1,
        toolCallId: "held-question",
        payload: {
          schemaVersion: 1,
          prompt: "held",
          context: null,
          options: [],
          allowFreeform: true,
          defaultOptionId: null,
          timeoutMs: 300_000,
        },
        askedAt: new Date(now - 1_000).toISOString(),
      },
    });
    const before = broker.store.state.lastEventSeq;
    broker = make();
    let auditResolve!: () => void;
    const auditObserved = new Promise<void>((resolve) => {
      auditResolve = resolve;
    });
    const removeAudit = broker.store.onAppend((event) => {
      if (
        event.type === "audit.action" &&
        (event.payload as Record<string, unknown>).action ===
          "question_terminal_delivery_rejected"
      )
        auditResolve();
    });
    await broker.start();
    await bounded(auditObserved, "delivery rejection audit timeout");
    await bounded(stopObserved, "fallback stop timeout");
    const recovery = Object.values(broker.store.events).filter(
      (event) => event.seq > before,
    );
    removeAudit();
    assert.equal(stops.length, 1);
    assert.equal(
      recovery.some((event) => event.type === "control.abort"),
      false,
    );
    assert.deepEqual(stops[0], {
      paneId: "pane-active",
      terminalId: "term-active",
      sessionId: "pi-active",
      generation: 1,
    });
    assert.equal(
      recovery.some((event) => event.type === "question.timed_out"),
      false,
    );
    assert.equal(
      broker.store.state.questions?.[questionId]?.state,
      "cancelled",
    );
    assert.equal(broker.store.state.runs[runId]?.state, "timed_out");
    assert.equal(broker.store.state.tasks[taskId]?.state, "timed_out");
    assert.deepEqual(broker.store.state.runs[runId]?.terminalReason, {
      code: "TIMEOUT",
      message: "The task wall deadline expired.",
    });
    assert.deepEqual(broker.store.state.tasks[taskId]?.terminalReason, {
      code: "TIMEOUT",
      message: "The task wall deadline expired.",
    });
    assert.equal(stops.length, 1);
  } finally {
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production restart expires runnable workflow task before provisioning", async () => {
  const root = await mkdtemp(join(tmpdir(), "deadline-workflow-expired-"));
  const runtime = await mkdtemp(
    join(tmpdir(), "deadline-workflow-expired-runtime-"),
  );
  const paths = makePaths(root, runtime);
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  let provisions = 0;
  const make = () =>
    new Broker(paths, {
      now: () => now,
      herdrFactory: async (store) =>
        ({
          store,
          startupReconcile: async () => [],
          provision: async () => {
            provisions++;
            throw new Error("expired workflow was provisioned");
          },
        }) as never,
    });
  let broker = make();
  await broker.start();
  try {
    await broker.stop();
    const workflowId = createId("wfl");
    const taskId = createId("tsk");
    await broker.store.append({
      type: "workflow.created",
      actor,
      entityRefs: { workflowId },
      payload: { workflowId, taskIds: [taskId], mode: "single" },
    });
    await broker.store.append({
      type: "task.created_m3",
      actor,
      entityRefs: { taskId },
      payload: {
        taskId,
        title: "expired workflow",
        objective: "expired workflow",
        createdAt: new Date(now - 60_000).toISOString(),
        workflowId,
        timeoutAt: new Date(now - 1).toISOString(),
      },
    });
    const before = broker.store.state.lastEventSeq;
    broker = make();
    await broker.start();
    const newEvents = Object.values(broker.store.events).filter(
      (event) => event.seq > before,
    );
    assert.equal(provisions, 0);
    assert.equal(
      newEvents.some((event) => event.type === "run.created"),
      false,
    );
    assert.equal(broker.store.state.tasks[taskId]?.state, "timed_out");
    assert.deepEqual(broker.store.state.tasks[taskId]?.terminalReason, {
      code: "TIMEOUT",
      message: "The task wall deadline expired.",
    });
  } finally {
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("production equal-deadline recovery uses stable task IDs after reverse append", async () => {
  const root = await mkdtemp(join(tmpdir(), "deadline-stable-id-"));
  const runtime = await mkdtemp(join(tmpdir(), "deadline-stable-id-runtime-"));
  const paths = makePaths(root, runtime);
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  let broker = new Broker(paths, { now: () => now });
  await broker.start();
  try {
    await broker.stop();
    const ids = [createId("tsk"), createId("tsk")].sort();
    const deadline = new Date(now + 10_000).toISOString();
    for (const taskId of [...ids].reverse())
      await broker.store.append({
        type: "task.created_m3",
        actor,
        entityRefs: { taskId },
        payload: {
          taskId,
          title: "stable",
          objective: "stable",
          createdAt: new Date(now).toISOString(),
          timeoutAt: deadline,
        },
      });
    const before = broker.store.state.lastEventSeq;
    broker = new Broker(paths, { now: () => now + 20_000 });
    await broker.start();
    const recovered = Object.values(broker.store.events)
      .filter(
        (event) =>
          event.seq > before &&
          event.type === "task.state_changed" &&
          (event.payload as Record<string, unknown>).to === "timed_out",
      )
      .sort((left, right) => left.seq - right.seq)
      .map((event) => event.entityRefs?.taskId);
    assert.deepEqual(recovered, ids);
  } finally {
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});
