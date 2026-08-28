import assert from "node:assert/strict";
import test from "node:test";
import {
  HEARTBEAT_SNAPSHOT_INTERVAL,
  shouldWriteRequestSnapshot,
} from "../../src/broker/broker.js";

test("heartbeat snapshots use a deterministic bounded checkpoint interval", () => {
  assert.equal(HEARTBEAT_SNAPSHOT_INTERVAL, 64);
  assert.equal(shouldWriteRequestSnapshot("task.get", 1), true);
  assert.equal(shouldWriteRequestSnapshot("agent.heartbeat", 1), false);
  assert.equal(shouldWriteRequestSnapshot("agent.heartbeat", 63), false);
  assert.equal(shouldWriteRequestSnapshot("agent.heartbeat", 64), true);
  assert.equal(shouldWriteRequestSnapshot("agent.heartbeat", 65), false);
  assert.equal(shouldWriteRequestSnapshot("agent.heartbeat", 128), true);
});
