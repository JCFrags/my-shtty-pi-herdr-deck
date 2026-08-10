import assert from "node:assert/strict";
import test from "node:test";
import {
  createRegistrationPayload,
  validateRegistrationPayload,
} from "../../src/pi/registration.js";
import { PiStateReporter } from "../../src/pi/state-reporter.js";
import type { PiSafeState } from "../../src/pi/types.js";
const state: PiSafeState = {
  agentId: "agt_01",
  generation: 1,
  sessionId: "session-1",
  idle: true,
  pendingMessages: 0,
  activity: "idle",
  activeTools: [],
  capabilities: {
    core: true,
    prompt: true,
    steer: true,
    followUp: true,
    abort: true,
    compact: true,
    model: true,
    thinking: true,
    tools: true,
    toolExpansion: false,
  },
};
const herdr = {
  paneId: "pane-1",
  terminalId: "term-1",
  detectedKind: "pi" as const,
};
test("M3 registration validates a minimal safe payload and rejects secret-shaped additions", () => {
  const payload = createRegistrationPayload(state, { herdr });
  assert.equal(payload.pi.sessionId, "session-1");
  assert.throws(
    () => validateRegistrationPayload({ ...payload, token: "secret" }),
    /PAYLOAD_INVALID/,
  );
  assert.throws(
    () =>
      validateRegistrationPayload({
        ...payload,
        pi: {
          ...payload.pi,
          capabilities: { ...payload.pi.capabilities, extra: true },
        },
      }),
    /CAPABILITIES_INVALID/,
  );
});
test("M3 state reporter sends one heartbeat and coalesces to the newest state", async () => {
  let release!: () => void;
  const calls: PiSafeState[] = [];
  const transport = {
    heartbeat: async (value: PiSafeState) => {
      calls.push(value);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
  const reporter = new PiStateReporter(transport, { heartbeatMs: 0 });
  assert.equal(reporter.report(state), "sent");
  assert.equal(reporter.report({ ...state, activity: "working" }), "coalesced");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.activity, "working");
  reporter.dispose();
});
test("M3 state reporter applies a bounded interval without retaining more than one state", async () => {
  let now = 1000;
  const timers: (() => void)[] = [];
  const calls: PiSafeState[] = [];
  const reporter = new PiStateReporter(
    {
      heartbeat: async (value) => {
        calls.push(value);
      },
    },
    {
      heartbeatMs: 5000,
      now: () => now,
      setTimer: (callback) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    },
  );
  reporter.report(state);
  await new Promise<void>((resolve) => setImmediate(resolve));
  reporter.report({ ...state, turnIndex: 2 });
  reporter.report({ ...state, turnIndex: 3 });
  assert.equal(calls.length, 1);
  assert.equal(timers.length, 1);
  now = 6000;
  timers.shift()!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls[1]?.turnIndex, 3);
  reporter.dispose();
});
