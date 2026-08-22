import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPiHerd, PI_HERD_ARGV } from "../../src/herdr/pi-herd-command.js";

test("pi-herd rejects missing Herdr context", async () => {
  await assert.rejects(() => openPiHerd({}), /only inside Herdr/);
});

test("pi-herd uses the documented right-split argv", () => {
  assert.deepEqual(
    [...PI_HERD_ARGV],
    [
      "plugin",
      "pane",
      "open",
      "--plugin",
      "pi.herdr.orchestrator",
      "--entrypoint",
      "deck",
      "--placement",
      "split",
      "--target-pane",
      "--direction",
      "right",
      "--focus",
    ],
  );
});

test("pi-herd reuses a target registry and falls back after stale focus", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-herd-test-"));
  const log = join(dir, "calls");
  const fake = join(dir, "herdr");
  await writeFile(
    fake,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
if [ "$3" = focus ] && [ "$FAIL_FOCUS" = 1 ]; then exit 7; fi
if [ "$3" = open ]; then
  if [ "$JSON_OUTPUT" = 1 ]; then
    printf '{"result":{"plugin_pane":{"pane":{"pane_id":"deck-%s"}}}}\\n' "$OPEN_ID"
  else
    printf 'deck-%s\\n' "$OPEN_ID"
  fi
fi
`,
  );
  await chmod(fake, 0o755);
  const env = {
    ...process.env,
    HERDR_BIN_PATH: fake,
    HERDR_PANE_ID: "pi-target",
    HERDR_PI_HERD_REGISTRY: join(dir, "registry.json"),
    CALL_LOG: log,
    OPEN_ID: "one",
  };
  const { openPiHerd } = await import("../../src/herdr/pi-herd-command.js");
  await openPiHerd(env);
  await openPiHerd(env);
  const reused = await readFile(log, "utf8");
  assert.match(reused, /plugin pane focus deck-one/);
  const fallback = { ...env, FAIL_FOCUS: "1", OPEN_ID: "two" };
  await openPiHerd(fallback);
  const calls = await readFile(log, "utf8");
  assert.match(calls, /plugin pane open/);
  assert.match(await readFile(join(dir, "registry.json"), "utf8"), /deck-two/);

  const jsonTarget = {
    ...env,
    HERDR_PANE_ID: "json-target",
    JSON_OUTPUT: "1",
    OPEN_ID: "json",
  };
  await openPiHerd(jsonTarget);
  await openPiHerd(jsonTarget);
  assert.match(await readFile(log, "utf8"), /plugin pane focus deck-json/);
});
