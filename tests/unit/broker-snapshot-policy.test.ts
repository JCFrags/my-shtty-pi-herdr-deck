import assert from "node:assert/strict";
import test from "node:test";
import {
  HEARTBEAT_SNAPSHOT_INTERVAL,
  shouldCheckpointRequestState,
} from "../../src/broker/broker.js";

test("heartbeat maintenance uses a deterministic bounded checkpoint interval", () => {
  assert.equal(HEARTBEAT_SNAPSHOT_INTERVAL, 64);
  assert.equal(shouldCheckpointRequestState("task.get", null), false);
  assert.equal(shouldCheckpointRequestState("result.publish", 1), true);
  assert.equal(shouldCheckpointRequestState("agent.heartbeat", 1), false);
  assert.equal(shouldCheckpointRequestState("agent.heartbeat", 63), false);
  assert.equal(shouldCheckpointRequestState("agent.heartbeat", 64), true);
  assert.equal(shouldCheckpointRequestState("agent.heartbeat", 65), false);
  assert.equal(shouldCheckpointRequestState("agent.heartbeat", 128), true);
});
