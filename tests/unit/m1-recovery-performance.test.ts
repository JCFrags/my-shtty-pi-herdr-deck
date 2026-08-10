import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EventStore } from "../../src/state/event-store.js";
import { canonicalJson, sha256 } from "../../src/shared/canonical-json.js";
import { SnapshotStore } from "../../src/state/snapshot-store.js";

test("incomplete final event enters read-only recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-corrupt-"));
  const path = join(root, "events.jsonl");
  await writeFile(path, '{"incomplete":');
  await chmod(path, 0o600);
  const store = new EventStore(path);
  await store.open();
  assert.equal(store.readOnly, true);
  assert.match(store.corruption ?? "", /incomplete/);
});

test("oversized unterminated event line enters read-only recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-oversize-"));
  const path = join(root, "events.jsonl");
  await writeFile(path, "x".repeat(1_048_577));
  await chmod(path, 0o600);
  const store = new EventStore(path);
  await store.open();
  assert.equal(store.readOnly, true);
  assert.match(store.corruption ?? "", /maximum size/);
});

test("event-specific task transitions fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-schema-"));
  const path = join(root, "events.jsonl");
  const base = {
    schemaVersion: 1 as const,
    seq: 1,
    id: "evt_00000000000000000000000000",
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "task.state_changed",
    actor: { principalId: "prn_test", kind: "human" },
    entityRefs: { taskId: "tsk_missing" },
    payload: { to: "not-a-task-state" },
    prevHash: "0".repeat(64),
  };
  await writeFile(
    path,
    `${canonicalJson({ ...base, hash: sha256(canonicalJson(base)) })}\n`,
  );
  await chmod(path, 0o600);
  const store = new EventStore(path);
  await store.open();
  assert.equal(store.readOnly, true);
  assert.match(store.corruption ?? "", /payload|transition|Event/);
});

test("valid snapshot selects state and replays its disk suffix", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-suffix-"));
  const path = join(root, "events.jsonl");
  const first = new EventStore(path);
  await first.open();
  const id = "tsk_00000000000000000000000000";
  await first.append({
    type: "task.created",
    actor: { principalId: "prn_test", kind: "human" },
    entityRefs: { taskId: id },
    payload: {
      id,
      title: "snapshot",
      objective: "suffix",
      createdAt: new Date().toISOString(),
    },
  });
  const snapshot = new SnapshotStore(join(root, "snapshot.json"));
  await snapshot.write(first.state);
  await first.append({
    type: "audit.action",
    actor: { principalId: "prn_test", kind: "human" },
    payload: { action: "suffix" },
  });
  const recovered = new EventStore(path);
  await recovered.open(await snapshot.read());
  assert.equal(recovered.state.tasks[id]?.title, "snapshot");
  assert.equal(recovered.state.lastEventSeq, 2);
});

test("disk history remains available below the replay ring floor", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-history-"));
  const store = new EventStore(join(root, "events.jsonl"));
  await store.open();
  for (let index = 0; index < 1_001; index++)
    await store.append({
      type: "audit.action",
      actor: { principalId: "prn_test", kind: "human" },
      payload: { action: "fixture" },
    });
  assert.equal(store.events.length, 1_000);
  assert.equal((await store.readEventsFrom(0)).length, 1_001);
});

test("snapshots verify their checksum and state cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-snapshot-"));
  const store = new EventStore(join(root, "events.jsonl"));
  await store.open();
  const snapshot = new SnapshotStore(join(root, "snapshot.json"));
  await snapshot.write(store.state);
  assert.equal((await snapshot.read())?.lastEventSeq, 0);
});

test("replays a 100000-event fixture under 5 seconds and 256 MiB RSS", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-perf-"));
  const path = join(root, "events.jsonl");
  const lines: string[] = [];
  let previous = "0".repeat(64);
  for (let index = 0; index < 100_000; index++) {
    const task = index < 1_000;
    const id = task ? `tsk_${String(index).padStart(26, "0")}` : undefined;
    const base = {
      schemaVersion: 1 as const,
      seq: index + 1,
      id: `evt_${String(index).padStart(26, "0")}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: task ? "task.created" : "audit.action",
      actor: { principalId: "prn_test", kind: "human" },
      entityRefs: task ? { taskId: id } : {},
      payload: task
        ? {
            id,
            title: "fixture",
            objective: "bounded",
            createdAt: "2026-01-01T00:00:00.000Z",
          }
        : { action: "fixture" },
      prevHash: previous,
    };
    const event = { ...base, hash: sha256(canonicalJson(base)) };
    previous = event.hash;
    lines.push(canonicalJson(event));
  }
  await writeFile(path, `${lines.join("\n")}\n`);
  await chmod(path, 0o600);
  lines.length = 0;
  lines.length = 0;
  const child = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--input-type=module",
      "-e",
      `import { EventStore } from './dist/src/state/event-store.js'; const start = performance.now(); const store = new EventStore(process.argv[1]); await store.open(); global.gc?.(); console.log(JSON.stringify({ elapsed: performance.now() - start, events: store.events.length, seq: store.state.lastEventSeq, tasks: Object.keys(store.state.tasks).length, rss: process.memoryUsage().rss }));`,
      path,
    ],
    { encoding: "utf8", cwd: process.cwd() },
  );
  assert.equal(child.status, 0, child.stderr);
  const evidence = JSON.parse(child.stdout.trim()) as {
    elapsed: number;
    events: number;
    seq: number;
    tasks: number;
    rss: number;
  };
  assert.equal(evidence.events, 1_000);
  assert.equal(evidence.seq, 100_000);
  assert.equal(evidence.tasks, 1_000);
  assert.ok(evidence.elapsed < 5_000, `replay took ${evidence.elapsed}ms`);
  assert.ok(
    evidence.rss < 256 * 1024 * 1024,
    `absolute replay RSS was ${evidence.rss} bytes`,
  );
});
