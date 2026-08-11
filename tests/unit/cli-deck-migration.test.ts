import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const timeoutMilliseconds = 10_000;

async function doesNotExist(path: string): Promise<void> {
  await assert.rejects(access(path), { code: "ENOENT" });
}

test("production deck command fails closed outside a canonical Herdr context", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "orch-cli-deck-"));
  try {
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, "bin", "pi-herdr-orchestrator"), "deck"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: timeoutMilliseconds,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          HERDR_ENV: "1",
          HERDR_PANE_ID: "test-pane",
          PI_HERDR_ORCH_STATE_ROOT: join(temporaryRoot, "state"),
          PI_HERDR_ORCH_RUNTIME_ROOT: join(temporaryRoot, "runtime"),
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /HERDR_SOCKET_PATH is unavailable|active Herdr socket/u,
    );
    await doesNotExist(join(temporaryRoot, "state"));
    await doesNotExist(join(temporaryRoot, "runtime"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("legacy binary prints one deprecation notice and launches the new deck target", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "orch-deck-shim-"));
  try {
    const binDirectory = join(temporaryRoot, "bin");
    const deckDirectory = join(temporaryRoot, "dist", "src", "deck");
    await mkdir(binDirectory, { recursive: true });
    await mkdir(deckDirectory, { recursive: true });

    const shim = await readFile(
      join(repositoryRoot, "bin", "pi-herdr-deck"),
      "utf8",
    );
    const shimPath = join(binDirectory, "pi-herdr-deck");
    await writeFile(shimPath, shim, { mode: 0o755 });
    await writeFile(
      join(deckDirectory, "main.js"),
      'export async function main() { process.stdout.write("new-deck-main\\n"); }\n',
    );

    const result = spawnSync(process.execPath, [shimPath], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: timeoutMilliseconds,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.error, undefined);
    assert.equal(result.stdout, "new-deck-main\n");
    assert.equal(
      result.stderr,
      "pi-herdr-deck is deprecated and retained for one release; use pi-herdr-orchestrator deck.\n",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
