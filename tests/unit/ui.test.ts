import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TuiMouseEvent } from "@pi-herdr-deck/tui";
import { BridgeClient } from "../../src/bridge/client.js";
import { BridgeServer } from "../../src/bridge/server.js";
import { DeckApp } from "../../src/deck/app.js";
import {
  type HitBox,
  PressReleaseTracker,
} from "../../src/deck/components/controls.js";
import { PanePicker } from "../../src/deck/components/picker.js";
import { HerdrApi } from "../../src/herdr/api.js";
import { FakeController, waitFor } from "../helpers.js";

function mouse(
  type: "press" | "release" | "move",
  x: number,
  y: number,
  button: "left" | "right" = "left",
): TuiMouseEvent {
  return { type, button, x, y, shift: false, alt: false, ctrl: false };
}

test("one left press/release activates, dragging cancels, right-click is unused", () => {
  const tracker = new PressReleaseTracker();
  let activations = 0;
  const boxes: HitBox[] = [
    {
      id: "button",
      x: 2,
      y: 3,
      width: 8,
      height: 1,
      disabled: false,
      activate: () => {
        activations += 1;
      },
    },
  ];
  assert.equal(tracker.handle(mouse("press", 3, 3), boxes), true);
  assert.equal(tracker.handle(mouse("release", 3, 3), boxes), true);
  assert.equal(activations, 1);
  tracker.handle(mouse("press", 3, 3), boxes);
  tracker.handle(mouse("move", 4, 3), boxes);
  tracker.handle(mouse("release", 3, 3), boxes);
  assert.equal(activations, 1);
  assert.equal(tracker.handle(mouse("press", 3, 3, "right"), boxes), false);
});

test("disabled controls do not activate", () => {
  const tracker = new PressReleaseTracker();
  let activations = 0;
  const boxes: HitBox[] = [
    {
      id: "disabled",
      x: 0,
      y: 0,
      width: 10,
      height: 1,
      disabled: true,
      activate: () => {
        activations += 1;
      },
    },
  ];
  tracker.handle(mouse("press", 1, 0), boxes);
  tracker.handle(mouse("release", 1, 0), boxes);
  assert.equal(activations, 0);
});

test("pane picker has equivalent keyboard and mouse activation", () => {
  const agents = [
    { terminalId: "t1", paneId: "p1", agent: "pi", name: "one", focused: true },
    {
      terminalId: "t2",
      paneId: "p2",
      agent: "pi",
      name: "two",
      focused: false,
    },
  ];
  const selected: string[] = [];
  const picker = new PanePicker({
    agents,
    reason: "Select",
    onSelect: (agent) => selected.push(agent.paneId),
    onCancel: () => selected.push("cancel"),
    requestRender: () => undefined,
  });
  picker.render(80);
  picker.handleInput("\x1b[B");
  picker.handleInput("\r");
  assert.deepEqual(selected, ["p2"]);
  selected.length = 0;
  picker.render(80);
  picker.handleMouse(mouse("press", 2, 4));
  picker.handleMouse(mouse("release", 2, 4));
  assert.deepEqual(selected, ["p1"]);
});

test("deck renders disconnected controls as disabled and supports keyboard tab switching", () => {
  const client = new BridgeClient({
    socketPath: "/tmp/does-not-exist.sock",
    reconnectDelaysMs: [],
  });
  const herdr = new HerdrApi({
    runner: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
  });
  const app = new DeckApp({
    client,
    herdr,
    targetPaneId: "p1",
    requestRender: () => undefined,
    getHeight: () => 40,
  });
  const overview = app.render(80).join("\n");
  assert.match(overview, /Not connected/);
  assert.match(overview, /\(Stop\)/);
  assert.match(overview, /\(Send\)/);
  app.handleInput("2");
  const tools = app.render(80).join("\n");
  assert.match(tools, /Expanded: 0\/0/);
  assert.match(tools, /Controls disabled while disconnected/);
  app.dispose();
});

test("deck controls activate through both keyboard focus and component mouse events", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "pi-deck-ui-"));
  const controller = new FakeController();
  const server = new BridgeServer({
    controller,
    runtimeDirectory,
    statePushIntervalMs: 5,
  });
  await server.start();
  const client = new BridgeClient({
    socketPath: server.socketPath,
    reconnectDelaysMs: [10],
  });
  const herdr = new HerdrApi({
    runner: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
  });
  const app = new DeckApp({
    client,
    herdr,
    targetPaneId: "pane-1",
    requestRender: () => undefined,
    getHeight: () => 40,
  });
  try {
    client.start();
    await waitFor(() => client.connected && Boolean(client.state));
    app.render(80);
    for (let index = 0; index < 5; index += 1) app.handleInput("\t");
    app.handleInput("\r");
    await waitFor(
      () =>
        controller.commands.filter((command) => command.name === "compact")
          .length === 1,
    );

    const lines = app.render(80);
    const y = lines.findIndex((line) => line.includes("[Compact]"));
    assert.notEqual(y, -1);
    const x = lines[y]!.indexOf("[Compact]") + 1;
    app.handleMouse(mouse("press", x, y));
    app.handleMouse(mouse("release", x, y));
    await waitFor(
      () =>
        controller.commands.filter((command) => command.name === "compact")
          .length === 2,
    );
  } finally {
    app.dispose();
    client.stop();
    await server.close();
  }
});
