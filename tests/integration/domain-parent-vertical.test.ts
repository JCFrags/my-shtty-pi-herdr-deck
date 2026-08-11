import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import { digest } from "../../src/broker/authentication.js";
import { createId } from "../../src/shared/ids.js";
import { sessionKey, type ResolvedPaths } from "../../src/shared/paths.js";
import { encodeFrame, NdjsonDecoder } from "../../src/shared/protocol/codec.js";
import type { EventStore } from "../../src/state/event-store.js";
type Frame = {
  type?: string;
  id?: string;
  ok?: boolean;
  result?: any;
  error?: any;
  method?: string;
  params?: any;
  seq?: number;
  event?: string;
};
const resultBody = {
  schemaVersion: 1 as const,
  status: "succeeded" as const,
  summary: "vertical",
  findings: [],
  changedFiles: [],
  commandsRun: [],
  tests: [],
  commits: [],
  artifacts: [],
  unresolved: [],
  questions: [],
  recommendedNextAction: null,
};
class FakeHerdr {
  readonly tokens = new Map<string, string>();
  provisions = 0;
  adoptions = 0;
  readonly occupants = new Map([
    ["root-1", "root-term-1"],
    ["root-2", "root-term-2"],
  ]);
  async verifyRoot(identity: any) {
    this.adoptions++;
    if (this.occupants.get(identity.paneId) !== identity.terminalId)
      throw new Error("HERDR_IDENTITY_MISMATCH");
    return {
      paneId: identity.paneId,
      terminalId: identity.terminalId,
      workspaceId: "w",
      cwd: "/fake",
    };
  }
  async adoptRoot(agent: any, identity: any) {
    this.adoptions++;
    if (
      identity.paneId !== agent.paneId ||
      identity.terminalId !== agent.terminalId ||
      identity.sessionId !== agent.piSessionId
    )
      throw new Error("HERDR_IDENTITY_MISMATCH");
    await this.store.append({
      type: "herdr.provision.intent",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId: agent.id },
      payload: { agentId: agent.id },
    });
  }
  constructor(readonly store: EventStore) {}
  get resources() {
    return this.store.state.herdrResources ?? {};
  }
  async startupReconcile() {
    return [];
  }
  async provision(input: any) {
    this.provisions++;
    const token = `child-token-${this.provisions}`;
    this.tokens.set(input.agentId, token);
    await this.store.append({
      type: "herdr.provision.intent",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId: input.agentId },
      payload: { agentId: input.agentId },
    });
    await this.store.append({
      type: "herdr.provision.outcome",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId: input.agentId },
      payload: {
        agentId: input.agentId,
        state: "pending",
        paneId: `pane-${this.provisions}`,
        terminalId: `term-${this.provisions}`,
        tokenDigest: digest(token),
        generation: 1,
        parentAgentId: input.parentAgentId,
        ownerId: input.agentId,
      },
    });
    return {
      name: `child-${this.provisions}`,
      token: { token, digest: digest(token), generation: 1 },
      paneId: `pane-${this.provisions}`,
    };
  }
  async verifyManagedPane(agentId: string, identity: any) {
    const resource = this.store.state.herdrResources?.[agentId];
    return {
      paneId: identity.paneId,
      terminalId: identity.terminalId ?? resource?.terminalId,
      workspaceId: "w",
      cwd: "/fake",
    };
  }
  async recordRegistrationMismatch(agentId: string) {
    await this.store.append({
      type: "herdr.provision.outcome",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId },
      payload: {
        agentId,
        state: "replaced",
        reason: "registration_identity_mismatch",
        cleanupOutcome: "retained",
        unknown: true,
      },
    });
  }
  async register(agentId: string, identity: any) {
    const current = this.resources[agentId];
    await this.store.append({
      type: "herdr.provision.outcome",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId },
      payload: {
        agentId,
        state: "registered",
        paneId: identity.paneId,
        terminalId: identity.terminalId,
        sessionId: identity.sessionId,
        generation: identity.generation,
        tokenDigest: current?.tokenDigest,
        parentAgentId: current?.parentAgentId,
        ownerId: agentId,
      },
    });
  }
  async stop() {}
  async close() {}
  async focus() {}
  async interrupt() {}
}
function send(
  socket: Socket,
  method: string,
  params: Record<string, unknown>,
): Promise<Frame> {
  const id = createId("evt");
  socket.write(encodeFrame({ v: 1, type: "request", id, method, params }));
  return new Promise((resolve, reject) => {
    const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
    const timer = setTimeout(
      () => reject(new Error(`timeout ${method}`)),
      5_000,
    );
    const onData = (chunk: Buffer) => {
      for (const item of decoder.push(chunk))
        if (item.ok && item.value.type === "response" && item.value.id === id) {
          clearTimeout(timer);
          socket.off("data", onData);
          resolve(item.value);
        }
    };
    socket.on("data", onData);
  });
}
async function connect(
  paths: ResolvedPaths & { sessionKey: string },
  auth: any,
  kind: string,
  onServerRequest?: (frame: Frame, socket: Socket) => void,
  onEvent?: (frame: Frame) => void,
): Promise<{ socket: Socket; hello: Frame }> {
  const socket = createConnection(paths.socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
  let helloResolve!: (frame: Frame) => void;
  const hello = new Promise<Frame>((resolve) => {
    helloResolve = resolve;
  });
  socket.on("data", (chunk) => {
    for (const item of decoder.push(chunk)) {
      if (!item.ok) continue;
      const frame = item.value;
      if (frame.type === "hello_result") helloResolve(frame);
      else if (frame.type === "server_request")
        onServerRequest?.(frame, socket);
      else if (frame.type === "event") onEvent?.(frame);
    }
  });
  socket.write(
    encodeFrame({
      v: 1,
      type: "hello",
      id: createId("evt"),
      client: {
        kind,
        name: "vertical-test",
        version: "0.1.0",
        capabilities: ["events.replay", "pi.lifecycle", "pi.controls"],
      },
      sessionKey: paths.sessionKey!,
      auth,
    }),
  );
  return { socket, hello: await hello };
}
async function closeSocket(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.end();
  });
}
function ok(frame: Frame): any {
  assert.equal(frame.ok, true, JSON.stringify(frame.error));
  return frame.result;
}
function bounded<T>(
  promise: Promise<T>,
  label: string,
  ms = 5_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

test("parent-bound broker vertical path provisions, assigns, correlates, bounds, replays, and denies cross-parent access", async () => {
  const root = await mkdtemp(join(tmpdir(), "parent-vertical-"));
  const runtime = await mkdtemp(join(tmpdir(), "parent-vertical-runtime-"));
  const paths = {
    sessionKey: sessionKey(join(runtime, "broker.sock")),
    root,
    runtime,
    events: join(root, "events"),
    snapshot: join(root, "snapshot"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
  let fake!: FakeHerdr;
  const broker = new Broker(paths, {
    herdrFactory: async (store) => (fake = new FakeHerdr(store)) as any,
  });
  await broker.start();
  let brokerStopped = false;
  let removeAssignmentAccepted = () => {};
  let removeSecondProvisionReceipt: (() => void) | undefined;
  try {
    const secret = (await readFile(paths.secret, "utf8")).trim();
    const liveEvents: Frame[] = [];
    const requiredEvents = [
      "workflow.created",
      "agent.registered",
      "assignment.delivered",
      "assignment.accepted",
      "run.pi_started",
      "run.pi_settled",
      "result.published",
    ];
    const eventResolvers = new Map<string, (frame: Frame) => void>();
    const eventReceipts = requiredEvents.map(
      (eventName) =>
        new Promise<Frame>((resolve) => {
          eventResolvers.set(eventName, resolve);
        }),
    );
    const recordEvent = (frame: Frame) => {
      liveEvents.push(frame);
      eventResolvers.get(frame.event ?? "")?.(frame);
      eventResolvers.delete(frame.event ?? "");
    };
    const p1 = await connect(
      paths,
      { kind: "client_secret", secret },
      "pi_parent",
      undefined,
      recordEvent,
    );
    const p2 = await connect(
      paths,
      { kind: "client_secret", secret },
      "pi_parent",
    );
    ok(
      await send(p1.socket, "events.subscribe", {
        fromSeq: broker.store.state.lastEventSeq,
        includeSnapshot: false,
        filters: {},
      }),
    );
    const r1 = ok(
      await send(p1.socket, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "root-1",
          terminalId: "root-term-1",
          detectedKind: "pi",
          sessionReference: {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: "integration-session",
          },
          name: "primary-1",
        },
        pi: {
          sessionId: "parent-session-1",
          sessionName: "primary-1",
          capabilities: {},
          state: {},
        },
      }),
    );
    const r2 = ok(
      await send(p2.socket, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "root-2",
          terminalId: "root-term-2",
          detectedKind: "pi",
          sessionReference: {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: "integration-session",
          },
          name: "primary-2",
        },
        pi: {
          sessionId: "parent-session-2",
          sessionName: "primary-2",
          capabilities: {},
          state: {},
        },
      }),
    );
    assert.notEqual(r1.agentId, r2.agentId);
    const p2Snapshot = ok(
      await send(p2.socket, "events.subscribe", {
        fromSeq: 0,
        includeSnapshot: true,
        filters: {},
      }),
    );
    assert.ok(
      p2Snapshot.snapshot.agents.every((agent: any) => agent.id === r2.agentId),
    );
    const dry = ok(
      await send(p1.socket, "delegate.execute", {
        mode: "parallel",
        title: "dry",
        parentAgentId: r1.agentId,
        steps: [{ key: "x", profileId: "scout", title: "X", objective: "x" }],
        dryRun: true,
      }),
    );
    assert.equal(dry.state, "created");
    assert.equal(fake.provisions, 0);
    assert.equal(fake.adoptions, 6);
    const invalidSeq = broker.store.state.lastEventSeq;
    for (const steps of [
      [
        { key: "x", profileId: "scout", objective: "x", dependsOn: [] },
        { key: "x", profileId: "scout", objective: "duplicate", dependsOn: [] },
      ],
      [
        {
          key: "x",
          profileId: "scout",
          objective: "missing",
          dependsOn: ["nope"],
        },
      ],
      [
        { key: "a", profileId: "scout", objective: "cycle", dependsOn: ["b"] },
        { key: "b", profileId: "scout", objective: "cycle", dependsOn: ["a"] },
      ],
    ])
      assert.equal(
        (
          await send(p1.socket, "delegate.execute", {
            mode: "dag",
            title: "invalid",
            steps,
            wait: false,
            waitUntil: [],
            timeoutMs: 1000,
            failureMode: "collect_all",
            dryRun: false,
          })
        ).ok,
        false,
      );
    assert.equal(broker.store.state.lastEventSeq, invalidSeq);
    const spawned = ok(
      await send(p1.socket, "delegate.execute", {
        mode: "chain",
        title: "Inspect",
        steps: [
          {
            key: "root",
            profileId: "scout",
            title: "Root",
            objective: "inspect",
            dependsOn: [],
          },
          {
            key: "dependent",
            profileId: "scout",
            title: "Dependent",
            objective: "continue",
            dependsOn: ["root"],
          },
        ],
        wait: false,
        waitUntil: [],
        timeoutMs: 10_000,
        failureMode: "collect_all",
        dryRun: false,
      }),
    );
    if (Number(fake.provisions) !== 1)
      throw new Error(
        `provision mismatch ${JSON.stringify({ provisions: fake.provisions, tasks: spawned.tasks, state: broker.store.state.tasks })}`,
      );
    const childId = spawned.tasks[0].agentId;
    const taskId = spawned.tasks[0].taskId;
    const runId = spawned.tasks[0].runId;
    const assignmentId = spawned.tasks[0].assignmentId;
    const token = fake.tokens.get(childId)!;
    let deliveryFrame: Frame | undefined;
    let resolveDelivery!: () => void;
    const deliverySeen = new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    });
    let assignmentFrame: { frame: Frame; socket: Socket } | undefined;
    const child = await connect(
      paths,
      {
        kind: "agent_token",
        agentId: childId,
        generation: 1,
        piSessionId: "child-session",
        token,
      },
      "pi_child",
      (frame, socket) => {
        if (frame.method === "question.deliver_answer") {
          deliveryFrame = frame;
          assert.deepEqual(Object.keys(frame.params).sort(), [
            "answer",
            "expected",
            "questionId",
            "runId",
            "state",
            "toolCallId",
          ]);
          assert.equal(frame.params.state, "answered");
          assert.equal(
            broker.store.state.questions?.[frame.params.questionId]?.state,
            "answered",
          );
          assert.equal(frame.params.toolCallId, "tool-question-vertical");
          assert.equal(frame.params.expected.assignmentGeneration, 1);
          socket.write(
            encodeFrame({
              v: 1,
              type: "server_response",
              id: frame.id,
              ok: true,
              result: { accepted: true },
            }),
          );
          resolveDelivery();
          return;
        }
        if (frame.method === "assignment.deliver") {
          assert.deepEqual(Object.keys(frame.params?.expected ?? {}).sort(), [
            "activity",
            "connectionGeneration",
            "piSessionId",
          ]);
          assert.deepEqual(
            {
              piSessionId: frame.params.expected.piSessionId,
              activity: frame.params.expected.activity,
            },
            { piSessionId: "child-session", activity: "idle" },
          );
          assert.equal(
            Number.isSafeInteger(frame.params.expected.connectionGeneration),
            true,
          );
          assignmentFrame = { frame, socket };
          return;
        }
        socket.write(
          encodeFrame({
            v: 1,
            type: "server_response",
            id: frame.id,
            ok: true,
            result:
              frame.method === "assignment.deliver"
                ? { status: "accepted" }
                : { status: "accepted" },
          }),
        );
      },
    );
    const registration = ok(
      await send(child.socket, "agent.register_managed", {
        agentId: childId,
        generation: 1,
        adapterVersion: "0.1.0",
        herdr: {
          paneId: "pane-1",
          terminalId: "term-1",
          detectedKind: "pi",
          sessionReference: {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: "integration-session",
          },
          name: "child",
        },
        pi: {
          sessionId: "child-session",
          sessionName: "child",
          capabilities: {},
          state: {},
        },
      }),
    );
    assert.equal(registration.agentId, childId);
    const connectionGeneration = registration.connectionGeneration;
    assert.equal(
      (
        await send(p1.socket, "agent.prompt", {
          agentId: childId,
          generation: 2,
          message: "stale",
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await send(child.socket, "agent.lifecycle_event", {
          agentId: childId,
          connectionGeneration,
          adapterSeq: 1,
          event: "turn_start",
          piSessionId: "child-session",
          turnIndex: 1,
          agentCycleId: "cycle",
          assignment: { assignmentId, generation: 1 },
          safeData: { toolName: null, contextPercent: 0 },
        })
      ).ok,
      false,
    );
    assert.ok(assignmentFrame);
    const assignmentAccepted = new Promise<void>((resolve) => {
      removeAssignmentAccepted = broker.store.onAppend((event) => {
        if (
          event.type === "assignment.accepted" &&
          event.entityRefs?.runId === runId
        ) {
          removeAssignmentAccepted();
          resolve();
        }
      });
    });
    assignmentFrame.socket.write(
      encodeFrame({
        v: 1,
        type: "server_response",
        id: assignmentFrame.frame.id,
        ok: true,
        result: { status: "accepted" },
      }),
    );
    await bounded(assignmentAccepted, "assignment.accepted append timeout");
    assert.equal(
      broker.store.state.runs[runId]?.assignmentDeliveryState,
      "accepted",
    );
    assert.equal(
      (
        await send(child.socket, "agent.lifecycle_event", {
          agentId: childId,
          connectionGeneration,
          adapterSeq: 2,
          event: "turn_start",
          piSessionId: "wrong-session",
          turnIndex: 1,
          agentCycleId: "cycle",
          assignment: { assignmentId, generation: 2 },
          safeData: { toolName: null, contextPercent: 0 },
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await send(child.socket, "agent.lifecycle_event", {
          agentId: childId,
          connectionGeneration,
          adapterSeq: 3,
          event: "turn_start",
          piSessionId: "wrong-session",
          turnIndex: 1,
          agentCycleId: "cycle",
          assignment: { assignmentId, generation: 1 },
          safeData: { toolName: null, contextPercent: 0 },
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await send(child.socket, "agent.lifecycle_event", {
          agentId: childId,
          connectionGeneration: connectionGeneration + 1,
          adapterSeq: 4,
          event: "turn_start",
          piSessionId: "child-session",
          turnIndex: 1,
          agentCycleId: "cycle",
          assignment: { assignmentId, generation: 1 },
          safeData: { toolName: null, contextPercent: 0 },
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await send(child.socket, "agent.lifecycle_event", {
          agentId: childId,
          connectionGeneration,
          adapterSeq: 5,
          event: "turn_start",
          piSessionId: "child-session",
          turnIndex: -1,
          agentCycleId: "",
          assignment: { assignmentId, generation: 1 },
          safeData: { toolName: null, contextPercent: 0 },
        })
      ).ok,
      true,
    );
    ok(
      await send(child.socket, "agent.lifecycle_event", {
        agentId: childId,
        connectionGeneration,
        adapterSeq: 6,
        event: "turn_start",
        piSessionId: "child-session",
        turnIndex: 1,
        agentCycleId: "cycle",
        assignment: { assignmentId, generation: 1 },
        safeData: { toolName: null, contextPercent: 0 },
      }),
    );
    const question = ok(
      await send(child.socket, "question.open", {
        agentId: childId,
        taskId,
        runId,
        assignmentGeneration: 1,
        toolCallId: "tool-question-vertical",
        question: {
          schemaVersion: 1,
          prompt: "Pick",
          context: null,
          options: [{ id: "a", label: "A", description: null }],
          allowFreeform: false,
          defaultOptionId: "a",
          timeoutMs: 10_000,
        },
      }),
    );
    assert.equal(
      (
        await send(p2.socket, "question.answer", {
          questionId: question.questionId,
          answer: { optionId: "a", text: null },
        })
      ).ok,
      false,
    );
    ok(
      await send(p1.socket, "question.answer", {
        questionId: question.questionId,
        answer: { optionId: "a", text: null },
      }),
    );
    await bounded(deliverySeen, "question delivery timeout");
    assert.equal(deliveryFrame?.params.state, "answered");
    assert.equal(
      (await send(p2.socket, "agent.get", { agentId: childId })).ok,
      false,
    );
    assert.equal(
      (await send(p2.socket, "task.collect", { taskIds: [taskId] })).ok,
      false,
    );
    assert.equal(
      (
        await send(p2.socket, "agent.prompt", {
          agentId: childId,
          message: "bad",
        })
      ).ok,
      false,
    );
    assert.equal(
      (await send(p2.socket, "task.cancel", { taskId, reason: "bad" })).ok,
      false,
    );
    assert.equal(
      (
        await send(p2.socket, "agent.spawn", {
          parentAgentId: r1.agentId,
          profileId: "scout",
          task: { title: "bad", objective: "bad" },
          project: {
            cwd: "/fake",
            workspaceId: "w",
            isolation: "shared-readonly",
          },
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await send(p2.socket, "delegate.execute", {
          parentAgentId: r1.agentId,
          mode: "parallel",
          steps: [{ key: "bad", profileId: "scout", objective: "bad" }],
        })
      ).ok,
      false,
    );
    ok(
      await send(child.socket, "agent.heartbeat", {
        agentId: childId,
        adapterSeq: 7,
        state: { sessionId: "child-session", activity: "idle" },
      }),
    );
    assert.equal(
      (
        await send(child.socket, "agent.lifecycle_event", {
          agentId: childId,
          connectionGeneration,
          adapterSeq: 7,
          event: "agent_settled",
          piSessionId: "child-session",
          turnIndex: 1,
          agentCycleId: "cycle",
          assignment: { assignmentId, generation: 1 },
          safeData: { toolName: null, contextPercent: 0 },
        })
      ).ok,
      false,
    );
    const secondProvisionOutcome = new Promise<void>((resolve) => {
      removeSecondProvisionReceipt = broker.store.onAppend((event) => {
        const payload = event.payload as Record<string, unknown>;
        if (
          event.type === "herdr.provision.outcome" &&
          payload.paneId === "pane-2" &&
          payload.state === "pending"
        ) {
          removeSecondProvisionReceipt?.();
          removeSecondProvisionReceipt = undefined;
          resolve();
        }
      });
    });
    const earlyResult = ok(
      await send(child.socket, "result.publish", {
        agentId: childId,
        taskId,
        runId,
        assignmentGeneration: 1,
        result: resultBody,
      }),
    );
    assert.equal(earlyResult.state, "result_pending");
    assert.notEqual(broker.store.state.tasks[taskId]?.state, "succeeded");
    ok(
      await send(child.socket, "agent.lifecycle_event", {
        agentId: childId,
        connectionGeneration,
        adapterSeq: 8,
        event: "agent_settled",
        piSessionId: "child-session",
        turnIndex: 1,
        agentCycleId: "cycle",
        assignment: { assignmentId, generation: 1 },
        safeData: { toolName: null, contextPercent: 0 },
      }),
    );
    await bounded(
      secondProvisionOutcome,
      "second provision outcome was not appended",
    );
    assert.equal(broker.store.state.tasks[taskId]?.state, "succeeded");
    assert.equal(
      broker.store.state.tasks[taskId]?.workflowId !== undefined,
      true,
    );
    assert.equal(fake.provisions, 2);
    const queueBefore = Object.keys(broker.store.state.tasks).length;
    const queueSteps = Array.from({ length: 20 }, (_, index) => ({
      key: `queue-${index}`,
      profileId: "scout",
      title: `Queue ${index}`,
      objective: "queue",
      dependsOn: [],
    }));
    const queueRequest = () =>
      send(p1.socket, "delegate.execute", {
        mode: "parallel",
        title: "queue-crossing",
        steps: queueSteps,
        wait: false,
        waitUntil: [],
        timeoutMs: 10_000,
        failureMode: "collect_all",
        dryRun: false,
      });
    const [queueOne, queueTwo] = await Promise.all([
      queueRequest(),
      queueRequest(),
    ]);
    assert.equal([queueOne.ok, queueTwo.ok].filter(Boolean).length, 1);
    assert.equal(
      Object.keys(broker.store.state.tasks).length,
      queueBefore + 20,
    );
    const collected = ok(
      await send(p1.socket, "task.collect", {
        taskIds: [taskId],
        maxBytes: 512,
      }),
    );
    assert.equal(collected.items.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(collected)) <= 512);
    assert.equal(
      ok(await send(p1.socket, "result.get", { taskId })).payload.summary,
      "vertical",
    );
    await Promise.all(
      eventReceipts.map((receipt, index) =>
        bounded(receipt, `live event timeout ${requiredEvents[index]}`),
      ),
    );
    const eventSeqs = liveEvents
      .map((frame) => frame.seq)
      .filter((seq): seq is number => typeof seq === "number");
    if (new Set(eventSeqs).size !== eventSeqs.length)
      throw new Error(
        `duplicate live events ${JSON.stringify(liveEvents.map((frame) => ({ seq: frame.seq, event: frame.event })))}`,
      );
    assert.deepEqual(
      requiredEvents.filter((eventName) =>
        liveEvents.some((frame) => frame.event === eventName),
      ),
      requiredEvents,
    );
    await Promise.all([child.socket, p1.socket, p2.socket].map(closeSocket));
    await broker.stop();
    brokerStopped = true;
    const restarted = new Broker(paths, {
      herdrFactory: async (store) => new FakeHerdr(store) as any,
    });
    await restarted.start();
    const after = await connect(
      paths,
      { kind: "client_secret", secret },
      "observer",
    );
    const replay = ok(
      await send(after.socket, "events.subscribe", {
        fromSeq: 0,
        includeSnapshot: true,
        filters: {},
      }),
    );
    assert.equal(replay.snapshot.results.length, 1);
    await closeSocket(after.socket);
    await restarted.stop();
  } finally {
    removeAssignmentAccepted();
    removeSecondProvisionReceipt?.();
    if (!brokerStopped) await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});
