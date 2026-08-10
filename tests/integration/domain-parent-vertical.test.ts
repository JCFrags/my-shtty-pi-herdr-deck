import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import { digest } from "../../src/broker/authentication.js";
import { createId } from "../../src/shared/ids.js";
import { resolvePaths, sessionKey } from "../../src/shared/paths.js";
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
  paths: ReturnType<typeof resolvePaths>,
  auth: any,
  kind: string,
  onServerRequest?: (frame: Frame, socket: Socket) => void,
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
      sessionKey: sessionKey(paths.socket),
      auth,
    }),
  );
  return { socket, hello: await hello };
}
function ok(frame: Frame): any {
  assert.equal(frame.ok, true, JSON.stringify(frame.error));
  return frame.result;
}

test("parent-bound broker vertical path provisions, assigns, correlates, bounds, replays, and denies cross-parent access", async () => {
  const root = await mkdtemp(join(tmpdir(), "parent-vertical-"));
  const runtime = await mkdtemp(join(tmpdir(), "parent-vertical-runtime-"));
  const paths = {
    ...resolvePaths(join(runtime, "herdr.sock")),
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
  try {
    const secret = (await readFile(paths.secret, "utf8")).trim();
    const p1 = await connect(
      paths,
      { kind: "client_secret", secret },
      "pi_parent",
    );
    const p2 = await connect(
      paths,
      { kind: "client_secret", secret },
      "pi_parent",
    );
    const r1 = ok(
      await send(p1.socket, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: { paneId: "root-1", terminalId: "root-term-1" },
        pi: { sessionId: "parent-session-1", capabilities: {}, state: {} },
      }),
    );
    const r2 = ok(
      await send(p2.socket, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: { paneId: "root-2", terminalId: "root-term-2" },
        pi: { sessionId: "parent-session-2", capabilities: {}, state: {} },
      }),
    );
    assert.notEqual(r1.agentId, r2.agentId);
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
    assert.equal((await broker.readSnapshot())?.lastEventSeq, 2);
    const spawned = ok(
      await send(p1.socket, "agent.spawn", {
        profileId: "scout",
        task: { title: "Inspect", objective: "inspect", constraints: [] },
        project: {
          cwd: "/fake",
          workspaceId: "w",
          isolation: "shared-readonly",
        },
      }),
    );
    assert.equal(fake.provisions, 1);
    const childId = spawned.tasks[0].agentId;
    const taskId = spawned.tasks[0].taskId;
    const runId = spawned.tasks[0].runId;
    const assignmentId = spawned.tasks[0].assignmentId;
    const token = fake.tokens.get(childId)!;
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
        herdr: { paneId: "pane-1", terminalId: "term-1" },
        pi: { sessionId: "child-session", capabilities: {}, state: {} },
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
          assignment: {
            assignmentId,
            taskId,
            runId,
            generation: 2,
            assignmentGeneration: 1,
          },
          safeData: {},
        })
      ).ok,
      false,
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
          assignment: {
            assignmentId,
            taskId,
            runId,
            generation: 1,
            assignmentGeneration: 2,
          },
          safeData: {},
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
          assignment: {
            assignmentId,
            taskId,
            runId,
            generation: 1,
            assignmentGeneration: 1,
          },
          safeData: {},
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
          assignment: {
            assignmentId,
            taskId,
            runId,
            generation: 1,
            assignmentGeneration: 1,
          },
          safeData: {},
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
          assignment: {
            assignmentId,
            taskId,
            runId,
            generation: 1,
            assignmentGeneration: 1,
          },
          safeData: {},
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
        assignment: {
          assignmentId,
          taskId,
          runId,
          generation: 1,
          assignmentGeneration: 1,
        },
        safeData: {},
      }),
    );
    const question = ok(
      await send(child.socket, "question.open", {
        agentId: childId,
        taskId,
        runId,
        assignmentGeneration: 1,
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
          questionId: question.id,
          answer: { optionId: "a" },
        })
      ).ok,
      false,
    );
    ok(
      await send(p1.socket, "question.answer", {
        questionId: question.id,
        answer: { optionId: "a" },
      }),
    );
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
      await send(child.socket, "agent.lifecycle_event", {
        agentId: childId,
        connectionGeneration,
        adapterSeq: 7,
        event: "agent_settled",
        piSessionId: "child-session",
        turnIndex: 1,
        agentCycleId: "cycle",
        assignment: {
          assignmentId,
          taskId,
          runId,
          generation: 1,
          assignmentGeneration: 1,
        },
        safeData: {},
      }),
    );
    ok(
      await send(child.socket, "result.publish", {
        agentId: childId,
        taskId,
        runId,
        assignmentGeneration: 1,
        result: resultBody,
      }),
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
    child.socket.destroy();
    p1.socket.destroy();
    p2.socket.destroy();
    await broker.stop();
    const restarted = new Broker(paths, {
      herdrFactory: async (store) => new FakeHerdr(store) as any,
    });
    await restarted.start();
    const after = await connect(
      paths,
      { kind: "client_secret", secret },
      "pi_parent",
    );
    const replay = ok(
      await send(after.socket, "events.subscribe", {
        fromSeq: 0,
        includeSnapshot: true,
        filters: {},
      }),
    );
    assert.equal(replay.snapshot.results.length, 1);
    after.socket.destroy();
    await restarted.stop();
  } finally {
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});
