import assert from "node:assert/strict";
import test from "node:test";
import {
  CommandExecutionError,
  PiDeckController,
} from "../../src/bridge/pi-controller.js";
import type { CommandFrame, CommandName } from "../../src/bridge/protocol.js";
import { createFakePiHarness } from "../helpers.js";

function command<N extends CommandName>(
  id: string,
  name: N,
  args: Extract<CommandFrame, { name: N }>["args"],
): CommandFrame {
  return { type: "command", id, name, args } as CommandFrame;
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof CommandExecutionError && error.code === code,
  );
}

test("abort and compact enforce idle/working state", async () => {
  const harness = createFakePiHarness();
  const controller = new PiDeckController(
    harness.pi,
    harness.context,
    "pane-1",
    harness.expansion,
  );
  await expectCode(
    controller.execute(command("a", "abort", {})),
    "invalid_state",
  );
  await controller.execute(command("c", "compact", {}));
  assert.equal(harness.compacted, 1);
  harness.setIdle(false);
  await controller.execute(command("a2", "abort", {}));
  assert.equal(harness.aborted, 1);
  await expectCode(
    controller.execute(command("c2", "compact", {})),
    "invalid_state",
  );
  controller.dispose();
});

test("sendUserMessage validates normal, steer, and followUp delivery state", async () => {
  const harness = createFakePiHarness();
  const controller = new PiDeckController(
    harness.pi,
    harness.context,
    "pane-1",
    harness.expansion,
  );
  await controller.execute(
    command("n", "sendUserMessage", { message: "normal", delivery: "normal" }),
  );
  await expectCode(
    controller.execute(
      command("s0", "sendUserMessage", { message: "steer", delivery: "steer" }),
    ),
    "invalid_state",
  );
  await expectCode(
    controller.execute(
      command("f0", "sendUserMessage", {
        message: "follow",
        delivery: "followUp",
      }),
    ),
    "invalid_state",
  );
  harness.setIdle(false);
  await expectCode(
    controller.execute(
      command("n2", "sendUserMessage", {
        message: "normal",
        delivery: "normal",
      }),
    ),
    "invalid_state",
  );
  await controller.execute(
    command("s", "sendUserMessage", { message: "steer", delivery: "steer" }),
  );
  await controller.execute(
    command("f", "sendUserMessage", {
      message: "follow",
      delivery: "followUp",
    }),
  );
  assert.deepEqual(harness.messages, [
    { text: "normal" },
    { text: "steer", deliverAs: "steer" },
    { text: "follow", deliverAs: "followUp" },
  ]);
  controller.dispose();
});

test("thinking, model, and active-tool commands validate advertised choices", async () => {
  const harness = createFakePiHarness();
  const controller = new PiDeckController(
    harness.pi,
    harness.context,
    "pane-1",
    harness.expansion,
  );
  await controller.execute(command("t", "setThinkingLevel", { level: "high" }));
  assert.equal(harness.thinkingLevel, "high");
  await expectCode(
    controller.execute(
      command("t2", "setThinkingLevel", { level: "impossible" }),
    ),
    "unknown_thinking_level",
  );
  await controller.execute(
    command("m", "setModel", { provider: "test", modelId: "model-2" }),
  );
  assert.equal(harness.model.id, "model-2");
  await expectCode(
    controller.execute(
      command("m2", "setModel", { provider: "other", modelId: "model-2" }),
    ),
    "unknown_model",
  );
  harness.pi.setModel = async () => false;
  await expectCode(
    controller.execute(
      command("m3", "setModel", { provider: "test", modelId: "model-1" }),
    ),
    "model_unavailable",
  );
  await controller.execute(
    command("tools", "setActiveTools", { tools: ["read", "bash"] }),
  );
  assert.deepEqual(harness.activeTools, ["read", "bash"]);
  await expectCode(
    controller.execute(
      command("tools2", "setActiveTools", { tools: ["unknown"] }),
    ),
    "unknown_tool",
  );
  controller.dispose();
});

test("per-tool and bulk expansion commands validate tool IDs", async () => {
  const harness = createFakePiHarness();
  const controller = new PiDeckController(
    harness.pi,
    harness.context,
    "pane-1",
    harness.expansion,
  );
  await controller.execute(
    command("e", "setToolExpanded", { toolCallId: "call-1", expanded: true }),
  );
  assert.deepEqual(harness.expansion.toolChanges, [
    { id: "call-1", expanded: true },
  ]);
  await expectCode(
    controller.execute(
      command("e2", "setToolExpanded", {
        toolCallId: "missing",
        expanded: true,
      }),
    ),
    "unknown_tool_call",
  );
  await controller.execute(
    command("g1", "setToolGroupExpanded", {
      scope: "currentTurn",
      expanded: false,
    }),
  );
  await controller.execute(
    command("g2", "setToolGroupExpanded", { scope: "session", expanded: true }),
  );
  assert.deepEqual(harness.expansion.groupChanges, [
    { scope: "currentTurn", expanded: false },
    { scope: "session", expanded: true },
  ]);
  controller.dispose();
});

test("model and thinking fallbacks never advertise unscoped registry choices", () => {
  const harness = createFakePiHarness();
  delete harness.pi.getScopedModels;
  harness.context.scopedModels = [{ model: harness.model }];
  delete harness.pi.getAllowedThinkingLevels;
  delete harness.pi.getAvailableThinkingLevels;
  const controller = new PiDeckController(
    harness.pi,
    harness.context,
    "pane-1",
    harness.expansion,
  );
  const snapshot = controller.snapshot();
  assert.deepEqual(
    snapshot.modelChoices.map((choice) => choice.id),
    ["model-1"],
  );
  assert.deepEqual(snapshot.allowedThinkingLevels, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  controller.dispose();
});

test("thinking-level fallback follows model reasoning metadata", () => {
  const harness = createFakePiHarness();
  delete harness.pi.getAllowedThinkingLevels;
  delete harness.pi.getAvailableThinkingLevels;
  harness.context.model = {
    ...harness.model,
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: null },
  };
  const controller = new PiDeckController(
    harness.pi,
    harness.context,
    "pane-1",
    harness.expansion,
  );
  assert.deepEqual(controller.snapshot().allowedThinkingLevels, [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  harness.context.model = { ...harness.model, reasoning: false };
  harness.pi.getThinkingLevel = () => "off";
  assert.deepEqual(controller.snapshot().allowedThinkingLevels, ["off"]);
  controller.dispose();
});

test("an empty ExtensionContext scopedModels snapshot advertises all available models", () => {
  const harness = createFakePiHarness();
  delete harness.pi.getScopedModels;
  harness.context.scopedModels = [];
  const controller = new PiDeckController(
    harness.pi,
    harness.context,
    "pane-1",
    harness.expansion,
  );
  assert.deepEqual(
    controller.snapshot().modelChoices.map((choice) => choice.id),
    ["model-1", "model-2"],
  );
  controller.dispose();
});

test("refreshState returns a complete safe snapshot and state events update turn/tool status", async () => {
  const harness = createFakePiHarness();
  const controller = new PiDeckController(
    harness.pi,
    harness.context,
    "pane-1",
    harness.expansion,
  );
  controller.recordEvent("turn_start", { turnIndex: 3 }, harness.context);
  controller.recordEvent(
    "tool_execution_start",
    { toolCallId: "call-1", toolName: "read" },
    harness.context,
  );
  const value = await controller.execute(command("r", "refreshState", {}));
  assert.deepEqual(value, controller.snapshot());
  const snapshot = controller.snapshot();
  assert.equal(snapshot.turnIndex, 3);
  assert.equal(snapshot.tools[0]?.status, "running");
  assert.equal(snapshot.herdrPaneId, "pane-1");
  assert.equal(JSON.stringify(snapshot).includes("OPENAI_API_KEY"), false);
  controller.dispose();
});

test("tool completion recognizes Pi isError events without serializing tool output", () => {
  const harness = createFakePiHarness();
  const controller = new PiDeckController(
    harness.pi,
    harness.context,
    "pane-1",
    harness.expansion,
  );
  controller.recordEvent("turn_start", { turnIndex: 4 }, harness.context);
  controller.recordEvent(
    "tool_execution_start",
    { toolCallId: "call-1", toolName: "read" },
    harness.context,
  );
  controller.recordEvent(
    "tool_execution_end",
    {
      toolCallId: "call-1",
      toolName: "read",
      isError: true,
      result: { content: [{ type: "text", text: "SECRET TOOL OUTPUT" }] },
    },
    harness.context,
  );
  const snapshot = controller.snapshot();
  assert.equal(snapshot.tools[0]?.status, "error");
  assert.equal(snapshot.lastError, "read failed.");
  assert.equal(JSON.stringify(snapshot).includes("SECRET TOOL OUTPUT"), false);
  controller.dispose();
});

test("arbitrary Pi and tool errors are sanitized before crossing the control socket", async () => {
  const harness = createFakePiHarness();
  const controller = new PiDeckController(
    harness.pi,
    harness.context,
    "pane-1",
    harness.expansion,
  );
  harness.pi.sendUserMessage = async () => {
    throw new Error("OPENAI_API_KEY=secret PROMPT CONTENT /work/private.txt");
  };
  await assert.rejects(
    controller.execute(
      command("secret", "sendUserMessage", {
        message: "hello",
        delivery: "normal",
      }),
    ),
    (error: unknown) =>
      error instanceof CommandExecutionError &&
      error.code === "operation_failed" &&
      error.message === "Pi could not complete the requested operation.",
  );
  let serialized = JSON.stringify(controller.snapshot());
  assert.equal(serialized.includes("OPENAI_API_KEY"), false);
  assert.equal(serialized.includes("PROMPT CONTENT"), false);
  assert.equal(serialized.includes("private.txt"), false);

  controller.recordEvent(
    "tool_execution_end",
    {
      toolCallId: "call-1",
      toolName: "read",
      error: "SECRET TOOL OUTPUT and /work/private.txt",
    },
    harness.context,
  );
  const snapshot = controller.snapshot();
  assert.equal(snapshot.lastError, "read failed.");
  serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("SECRET TOOL OUTPUT"), false);
  assert.equal(serialized.includes("private.txt"), false);
  controller.dispose();
});
