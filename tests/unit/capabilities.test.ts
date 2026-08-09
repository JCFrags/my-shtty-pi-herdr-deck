import assert from "node:assert/strict";
import test from "node:test";
import { detectPiCapabilities, hasComponentMouseApi, PI_COMPATIBILITY_MESSAGE } from "../../src/bridge/capabilities.js";

class CapableTerminal {}
class CapableTui {
  setMouseTracking(_enabled: boolean): void {}
}
const capableTui = { parseMouseInput: () => undefined, TUI: CapableTui, ProcessTerminal: CapableTerminal };

test("capability detection accepts component mouse and normalized expansion object", () => {
  const listeners = new Set<() => void>();
  const context = {
    ui: {
      toolExpansion: {
        getSnapshot: () => ({ tools: [{ toolCallId: "x", toolName: "read", expanded: true, status: "done", turn: 2 }] }),
        setToolExpanded: () => undefined,
        setGroupExpanded: () => undefined,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      },
    },
  };
  const result = detectPiCapabilities(context, capableTui);
  assert.equal(result.compatible, true);
  assert.deepEqual(result.expansion?.getStates(), [{ id: "x", name: "read", expanded: true, status: "complete", turnIndex: 2 }]);
});

test("capability detection rejects stock-style TUI without component mouse API", () => {
  const context = {
    ui: {
      toolExpansion: {
        getStates: () => [],
        setToolExpanded: () => undefined,
        setGroupExpanded: () => undefined,
        subscribe: () => () => undefined,
      },
    },
  };
  assert.equal(hasComponentMouseApi({ TUI: class {}, ProcessTerminal: class {} }), false);
  const result = detectPiCapabilities(context, { TUI: class {}, ProcessTerminal: class {}, parseMouseInput: () => undefined });
  assert.equal(result.compatible, false);
  assert.ok(result.missing.includes("component mouse events"));
});

test("capability detection rejects global-only expansion and missing subscription with one shared message", () => {
  const context = { ui: { getToolsExpanded: () => false, setToolsExpanded: () => undefined } };
  const result = detectPiCapabilities(context, capableTui);
  assert.equal(result.compatible, false);
  assert.ok(result.missing.some((item) => item.includes("per-tool expansion")));
  assert.equal(
    PI_COMPATIBILITY_MESSAGE,
    "Pi Deck requires Pi with component mouse events, per-tool expansion state and bulk selectors, and expansion-change subscription. The installed Pi API is incompatible.",
  );
});
