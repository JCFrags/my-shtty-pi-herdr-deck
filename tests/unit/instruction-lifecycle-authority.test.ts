import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("provisioning uses managed prompt files and does not create AGENTS.md", async () => {
  const source = await readFile(
    new URL("../../src/herdr/provisioner.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /AGENTS\.md/u);
  assert.match(source, /--append-system-prompt/u);
  assert.match(source, /createPromptFile/u);
  assert.match(source, /archiveManagedFileForCleanup/u);
});

test("worktree cleanup remains owned by exact Herdr resource identity", async () => {
  const source = await readFile(
    new URL("../../src/herdr/service.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /identity\.worktreePath !== resource\.worktreePath/u);
  assert.match(source, /removeWorktree\(identity\.workspaceId\)/u);
});
