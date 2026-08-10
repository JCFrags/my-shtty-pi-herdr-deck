import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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
  const store = new EventStore(path);
  await store.open();
  assert.equal(store.readOnly, true);
  assert.match(store.corruption ?? "", /incomplete/);
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
