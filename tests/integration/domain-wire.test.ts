import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import { resolvePaths, sessionKey } from "../../src/shared/paths.js";
import { createId } from "../../src/shared/ids.js";
import { encodeFrame, NdjsonDecoder } from "../../src/shared/protocol/codec.js";

type Frame = {
  type?: string;
  ok?: boolean;
  result?: any;
  error?: any;
  id?: string;
};
const body = {
  schemaVersion: 1 as const,
  status: "succeeded" as const,
  summary: "done",
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
const question = {
  schemaVersion: 1 as const,
  prompt: "Continue?",
  context: null,
  options: [{ id: "yes", label: "Yes", description: null }],
  allowFreeform: false,
  defaultOptionId: "yes",
  timeoutMs: 10_000,
};

function request(
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
      for (const item of decoder.push(chunk)) {
        if (!item.ok || item.value.id !== id) continue;
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
  secret: string,
  kind = "pi_parent",
): Promise<Socket> {
  const socket = createConnection(paths.socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    encodeFrame({
      v: 1,
      type: "hello",
      id: createId("evt"),
      client: {
        kind,
        name: "domain-test",
        version: "0.1.0",
        capabilities: ["events.replay"],
      },
      sessionKey: sessionKey(paths.socket),
      auth: { kind: "client_secret", secret },
    }),
  );
  await new Promise<void>((resolve, reject) => {
    const decoder = new NdjsonDecoder<Frame>((value) => value as Frame);
    const timer = setTimeout(() => reject(new Error("hello timeout")), 5_000);
    const onData = (chunk: Buffer) => {
      for (const item of decoder.push(chunk)) {
        if (!item.ok || item.value.type !== "hello_result") continue;
        clearTimeout(timer);
        socket.off("data", onData);
        if (item.value.ok !== true) reject(new Error("hello rejected"));
        else resolve();
      }
    };
    socket.on("data", onData);
  });
  return socket;
}
function resultOf(frame: Frame): any {
  assert.equal(frame.ok, true, JSON.stringify(frame.error));
  return frame.result;
}

test("broker domain wire persists correlated result, question, workflow, and replay across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "domain-wire-"));
  const runtime = await mkdtemp(join(tmpdir(), "domain-wire-runtime-"));
  const paths = {
    ...resolvePaths(join(runtime, "herdr.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
  const broker = new Broker(paths);
  await broker.start();
  try {
    const secret = await readFile(paths.secret, "utf8").then((value) =>
      value.trim(),
    );
    let socket = await connect(paths, secret);
    const registered = resultOf(
      await request(socket, "agent.register_adopted", {
        adapterVersion: "0.1.0",
        herdr: { paneId: "pane", terminalId: "terminal" },
        pi: { sessionId: "session", capabilities: {}, state: {} },
      }),
    );
    const workflow = resultOf(
      await request(socket, "workflow.create", {
        objective: "inspect",
        parentAgentId: registered.agentId,
        definition: {
          version: 1,
          id: "single",
          name: "Single",
          description: "test",
          mode: "single",
          failureMode: "collect_all",
          maxCorrectionLoops: 0,
          steps: [
            {
              key: "one",
              profileId: "scout",
              title: "One",
              objectiveTemplate: "{{input.objective}}",
              constraints: [],
              dependsOn: [],
              resultProjection: [],
              isolationMode: "shared-readonly",
            },
          ],
        },
      }),
    );
    const taskId = workflow.tasks[0].taskId;
    const run = resultOf(
      await request(socket, "run.create", {
        taskId,
        agentId: registered.agentId,
        assignmentGeneration: 1,
      }),
    );
    const opened = resultOf(
      await request(socket, "question.open", {
        agentId: registered.agentId,
        taskId,
        runId: run.runId,
        assignmentGeneration: 1,
        question,
      }),
    );
    const operator = await connect(paths, secret, "human");
    resultOf(
      await request(operator, "question.answer", {
        questionId: opened.id,
        answer: { optionId: "yes" },
      }),
    );
    operator.destroy();
    resultOf(
      await request(socket, "result.publish", {
        agentId: registered.agentId,
        taskId,
        runId: run.runId,
        assignmentGeneration: 1,
        result: body,
      }),
    );
    const got = resultOf(
      await request(socket, "result.get", {
        resultId: (await request(socket, "task.collect", { taskIds: [taskId] }))
          .result.items[0].id,
      }),
    );
    assert.equal(got.payload.summary, "done");
    socket.destroy();
    await broker.stop();
    const restarted = new Broker(paths);
    await restarted.start();
    socket = await connect(paths, secret);
    const replay = resultOf(
      await request(socket, "events.subscribe", {
        fromSeq: 0,
        includeSnapshot: true,
        filters: { events: ["question.*", "result.*", "workflow.*"] },
      }),
    );
    assert.equal(replay.snapshot.workflows.length, 1);
    assert.equal(replay.snapshot.questions.length, 1);
    assert.equal(replay.snapshot.results.length, 1);
    socket.destroy();
    await restarted.stop();
  } finally {
    await broker.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});
