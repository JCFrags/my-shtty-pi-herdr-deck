import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const legacyNames = [
  "agent_start_or_reuse",
  "agent_attach",
  "agent_dispatch",
  "agent_status",
  "agent_question",
  "agent_report",
  "agent_plan",
  "agent_progress",
  "agent_events",
  "agent_cancel",
];

test("package loads only the current orchestrator extension and keeps legacy source inert", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    pi: { extensions: string[] };
    files: string[];
  };
  assert.deepEqual(manifest.pi.extensions, [
    "./dist/extensions/pi-herdr-orchestrator.js",
  ]);
  assert.ok(manifest.files.includes("archive"));
  assert.equal(
    manifest.pi.extensions.some((path) => path.includes("legacy")),
    false,
  );

  const currentSource = await readFile(
    "extensions/pi-herdr-orchestrator.ts",
    "utf8",
  );
  for (const name of legacyNames)
    assert.doesNotMatch(
      currentSource,
      new RegExp(`registerTool\\([^)]*${name}`, "u"),
    );
});
