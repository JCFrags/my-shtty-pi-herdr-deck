import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../../src/results/artifact-store.js";
import {
  validateQuestion,
  validateResult,
} from "../../src/results/validation.js";
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
  prompt: "Choose",
  context: null,
  options: [
    { id: "A", label: "one", description: null },
    { id: "B", label: "two", description: null },
  ],
  allowFreeform: false,
  defaultOptionId: "A",
  timeoutMs: 10000,
};
test("M4 result and question validators reject invalid input", () => {
  validateResult(body);
  validateQuestion(question);
  assert.throws(() => validateResult({ ...body, extra: true }));
  assert.throws(() => validateResult({ ...body, summary: "api_key=secret" }));
  assert.throws(() =>
    validateResult({
      ...body,
      questions: [{ questionId: "bad", summary: "x", answered: false }],
    }),
  );
  assert.throws(() => validateQuestion({ ...question, extra: true }));
});
test("artifact store is owner-only, digest checked, bounded, and traversal-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "m4-artifacts-"));
  try {
    const store = new ArtifactStore(root);
    const ref = await store.put({
      kind: "report",
      name: "evidence.txt",
      content: "hello",
      mediaType: "text/plain",
    });
    assert.equal((await store.read(ref)).content.toString(), "hello");
    assert.equal(await readFile(join(root, ref.relativePath), "utf8"), "hello");
    await assert.rejects(() =>
      store.put({
        kind: "text",
        name: "../escape",
        content: "x",
        mediaType: "text/plain",
      }),
    );
    await assert.rejects(() => store.read({ ...ref, sha256: "0".repeat(64) }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
