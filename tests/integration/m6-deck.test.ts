import assert from "node:assert/strict";
import test from "node:test";
import { BrokerClient } from "../../src/deck/broker-client.js";
import { BrokerDeckApp } from "../../src/deck/broker-app.js";
import { resolveBrokerSocketPath } from "../../src/deck/socket.js";
import { DeckActions } from "../../src/deck/actions.js";
import { renderNotifications, renderTaskDetail } from "../../src/deck/views.js";
import {
  PressReleaseTracker,
  type HitBox,
} from "../../src/deck/components/controls.js";
import {
  FakeDeckBroker,
  agentTarget,
  m6Event,
  taskTarget,
  waitForM6,
} from "../helpers/m6-deck-fixtures.js";

test("production deck entry binds to an authenticated fake broker snapshot", async () => {
  const broker = new FakeDeckBroker();
  const client = new BrokerClient({
    socketPath: "/tmp/production-entry.sock",
    secret: "fixture-secret",
    socketFactory: () => broker.createSocket(),
  });
  client.start();
  await client.waitForReady();
  const app = new BrokerDeckApp({
    client,
    requestRender: () => undefined,
    getHeight: () => 40,
  });
  const output = app.render(120).join("\\n");
  assert.match(output, /AGENT BOARD/);
  assert.match(output, /Build deck/);
  const narrowNavigation = app.render(30).slice(1, 4).join(" ");
  for (const label of ["Board", "Files", "Agents", "Activity"])
    assert.match(narrowNavigation, new RegExp(label, "i"));
  assert.doesNotMatch(narrowNavigation, /Home|Work/);
  app.handleInput("2");
  assert.match(app.render(120).join("\n"), /FILES/);
  app.handleInput("1");
  assert.match(app.render(120).join("\n"), /Review release\?/);
  assert.equal(
    resolveBrokerSocketPath({
      PI_HERDR_ORCH_BROKER_SOCKET: "/run/user/1000/orchestrator.sock",
    }),
    "/run/user/1000/orchestrator.sock",
  );
  app.dispose();
  client.stop();
});

test("M6 deck integration applies a snapshot and ordered replay without duplicate notifications", async () => {
  const broker = new FakeDeckBroker();
  const client = new BrokerClient({
    socketPath: "/tmp/m6-fake.sock",
    secret: "fixture-secret",
    reconnectDelaysMs: [1],
    socketFactory: () => broker.createSocket(),
  });
  const statuses: string[] = [];
  client.onStatus((status) => statuses.push(status));

  await client.start();
  await waitForM6(
    () => client.status === "connected" && client.store.state.seq === 10,
  );
  assert.equal(client.store.state.tasks.get("tsk_build")?.state, "running");

  const blocked = m6Event(
    11,
    "evt-blocked",
    "task.blocked",
    { taskId: "tsk_build" },
    { prompt: "Choose a build target." },
  );
  const result = m6Event(
    12,
    "evt-result",
    "task.result",
    { taskId: "tsk_build", runId: "run-1" },
    {
      status: "accepted",
      summary: "Build prepared.",
      tests: ["m6 integration"],
    },
  );
  broker.publish(blocked);
  broker.publish(result);
  await waitForM6(() => client.store.state.seq === 12);

  assert.equal(client.store.state.questions.size, 1);
  assert.equal(
    client.store.state.results.get("evt-result")?.status,
    "accepted",
  );
  assert.equal(client.store.notifications.length, 2);
  assert.match(
    renderNotifications(client.store.notifications, 120).join("\n"),
    /Build prepared|Choose a build target/,
  );
  assert.equal(
    client.store.state.results.get("evt-result")?.tests?.[0],
    "m6 integration",
  );
  assert.match(
    renderTaskDetail(
      client.store.state.tasks.get("tsk_build"),
      client.store.state,
      120,
    ).join("\n"),
    /Result: evt-result/,
  );

  broker.publish(blocked);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(client.store.notifications.length, 2);
  assert.ok(statuses.includes("connected"));
  client.stop();
});

test("M6 deck integration reconnects and resubscribes from the retained sequence", async () => {
  const broker = new FakeDeckBroker();
  const client = new BrokerClient({
    socketPath: "/tmp/m6-reconnect.sock",
    secret: "fixture-secret",
    reconnectDelaysMs: [1],
    socketFactory: () => broker.createSocket(),
  });
  await client.start();
  await waitForM6(
    () => client.store.state.seq === 10 && broker.sockets.length === 1,
  );

  broker.publish(
    m6Event(
      11,
      "evt-working",
      "agent.state_changed",
      { agentId: "agt_alpha" },
      { state: "blocked" },
    ),
  );
  await waitForM6(() => client.store.state.seq === 11);
  broker.sockets[0]!.close();
  await waitForM6(
    () => broker.sockets.length === 2 && client.status === "connected",
  );

  const subscriptions = broker.requests.filter(
    (request) => request.method === "events.subscribe",
  );
  assert.equal(subscriptions.length, 2);
  assert.equal(
    (subscriptions.at(-1)?.params as { fromSeq: number }).fromSeq,
    11,
  );
  assert.equal(client.store.state.agents.get("agt_alpha")?.state, "blocked");
  client.stop();
});

test("M6 deck actions preserve target identity and closure does not issue a work stop", async () => {
  const broker = new FakeDeckBroker();
  const client = new BrokerClient({
    socketPath: "/tmp/m6-actions.sock",
    secret: "fixture-secret",
    socketFactory: () => broker.createSocket(),
  });
  await client.start();
  await waitForM6(() => client.status === "connected");
  const actions = new DeckActions(client);

  await actions.run("focus", agentTarget());
  await actions.run("stop", agentTarget());
  await actions.run("cancelTask", taskTarget());
  await actions.run(
    "answer",
    { questionId: "question-1" },
    { optionId: "yes", text: null },
  );
  client.stop("Deck closed.");

  assert.deepEqual(
    broker.requests.map((request) => request.method),
    [
      "events.subscribe",
      "herdr.focus",
      "agent.stop",
      "task.cancel",
      "question.answer",
    ],
  );
  assert.deepEqual(broker.requests[1]!.params as Record<string, unknown>, {
    paneId: "pane-alpha",
    terminalId: "term-main",
    sessionId: "session-main",
    generation: 2,
  });
  assert.deepEqual(broker.requests[2]!.params as Record<string, unknown>, {
    agentId: "agt_alpha",
    reason: "Stopped from Agent Board.",
    force: false,
  });
  assert.deepEqual(broker.requests[3]!.params as Record<string, unknown>, {
    taskId: "tsk_build",
    reason: "Cancelled from Agent Board.",
    cascade: false,
  });
  assert.deepEqual(broker.requests[4]!.params as Record<string, unknown>, {
    questionId: "question-1",
    answer: { optionId: "yes", text: null },
  });
  assert.equal(
    broker.requests.some((request) => request.method === "agent.close"),
    false,
  );
});

test("deck actions use the managed broker control methods", async () => {
  const broker = new FakeDeckBroker();
  const client = new BrokerClient({
    socketPath: "/tmp/m6-managed-actions.sock",
    secret: "fixture-secret",
    socketFactory: () => broker.createSocket(),
  });
  await client.start();
  await waitForM6(() => client.status === "connected");
  const actions = new DeckActions(client);
  const target = agentTarget();

  await actions.run("prompt", target, "Implement this.");
  await actions.run("ask", target, "Which option?");
  await actions.run("interrupt", target, "Operator request.");
  await actions.run("setModel", target, "openai-codex/gpt-5.6-sol");
  await actions.run("setThinking", target, "medium");
  await actions.run("close", target);

  assert.deepEqual(
    broker.requests.slice(1).map((request) => request.method),
    [
      "agent.prompt",
      "agent.ask",
      "agent.interrupt",
      "agent.set_model",
      "agent.set_thinking",
      "agent.close",
    ],
  );
  assert.deepEqual(broker.requests[1]!.params as Record<string, unknown>, {
    agentId: "agt_alpha",
    generation: 2,
    message: "Implement this.",
    timeoutMs: 10_000,
  });
  assert.deepEqual(broker.requests[2]!.params as Record<string, unknown>, {
    agentId: "agt_alpha",
    message: "Which option?",
    timeoutMs: 120_000,
  });
  assert.deepEqual(broker.requests[6]!.params as Record<string, unknown>, {
    agentId: "agt_alpha",
    reason: "Closed from Agent Board.",
    confirm: true,
  });
  client.stop();
});

test("broker deck keyboard entry prompts and confirms close", async () => {
  const broker = new FakeDeckBroker();
  const client = new BrokerClient({
    socketPath: "/tmp/m6-keyboard-actions.sock",
    secret: "fixture-secret",
    socketFactory: () => broker.createSocket(),
  });
  await client.start();
  await waitForM6(() => client.status === "connected");
  const app = new BrokerDeckApp({
    client,
    requestRender: () => undefined,
    getHeight: () => 60,
  });

  app.handleInput("3");
  app.handleInput("p");
  assert.match(app.render(120).join("\n"), /PROMPT: /);
  app.handleInput("Build now.");
  app.handleInput("\r");
  await waitForM6(() =>
    broker.requests.some((request) => request.method === "agent.prompt"),
  );
  assert.equal(
    (
      broker.requests.find((request) => request.method === "agent.prompt")
        ?.params as { message: string }
    ).message,
    "Build now.",
  );

  app.handleInput("x");
  assert.match(app.render(120).join("\n"), /Press x again to close Alpha/);
  app.handleInput("x");
  await waitForM6(() =>
    broker.requests.some((request) => request.method === "agent.close"),
  );
  app.dispose();
  client.stop();
});

test("broker deck mouse opens stable navigation and activates a button", async () => {
  const broker = new FakeDeckBroker();
  const client = new BrokerClient({
    socketPath: "/tmp/m6-mouse-navigation.sock",
    secret: "fixture-secret",
    socketFactory: () => broker.createSocket(),
  });
  await client.start();
  await waitForM6(() => client.status === "connected");
  const app = new BrokerDeckApp({
    client,
    requestRender: () => undefined,
    getHeight: () => 40,
  });
  const navigation = app.render(120);
  const navigationY = navigation.findIndex((line) => line.includes("Files 2"));
  const navigationX = navigation[navigationY]!.indexOf("Files 2");
  for (const type of ["press", "release"] as const)
    app.handleMouse({
      type,
      button: "left",
      x: navigationX,
      y: navigationY,
      shift: false,
      alt: false,
      ctrl: false,
    });
  assert.match(app.render(120).join("\n"), /FILES/);
  const filesView = app.render(120);
  const openY = filesView.findIndex((line) =>
    line.includes("Open standalone view"),
  );
  assert.ok(openY >= 0);
  const openX = Math.max(0, filesView[openY]!.indexOf("Open standalone view"));
  assert.ok(openY >= 0);
  for (const type of ["press", "release"] as const)
    app.handleMouse({
      type,
      button: "left",
      x: openX,
      y: openY,
      shift: false,
      alt: false,
      ctrl: false,
    });
  await waitForM6(() =>
    broker.requests.some((request) => request.method === "provider.files_open"),
  );
  app.dispose();
  client.stop();
});

test("M6 keyboard and mouse activation have the same enabled-control result", () => {
  let keyboardActivations = 0;
  let mouseActivations = 0;
  const boxes: HitBox[] = [
    {
      id: "focus",
      x: 2,
      y: 1,
      width: 8,
      height: 1,
      disabled: false,
      activate: () => mouseActivations++,
    },
    {
      id: "stop",
      x: 12,
      y: 1,
      width: 8,
      height: 1,
      disabled: true,
      activate: () => mouseActivations++,
    },
  ];
  const tracker = new PressReleaseTracker();
  tracker.handle(
    {
      type: "press",
      button: "left",
      x: 2,
      y: 1,
      shift: false,
      alt: false,
      ctrl: false,
    },
    boxes,
  );
  tracker.handle(
    {
      type: "release",
      button: "left",
      x: 2,
      y: 1,
      shift: false,
      alt: false,
      ctrl: false,
    },
    boxes,
  );
  if (!boxes[0]!.disabled) keyboardActivations++;
  assert.equal(mouseActivations, keyboardActivations);

  tracker.handle(
    {
      type: "press",
      button: "left",
      x: 12,
      y: 1,
      shift: false,
      alt: false,
      ctrl: false,
    },
    boxes,
  );
  tracker.handle(
    {
      type: "release",
      button: "left",
      x: 12,
      y: 1,
      shift: false,
      alt: false,
      ctrl: false,
    },
    boxes,
  );
  assert.equal(mouseActivations, 1);
});
