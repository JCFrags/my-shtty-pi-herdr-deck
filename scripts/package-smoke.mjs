import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const manifest = readFileSync(
  new URL("../herdr-plugin.toml", import.meta.url),
  "utf8",
);
assert.deepEqual(packageJson.os, ["linux"]);
assert.equal(packageJson.engines.node, ">=22.19.0");
for (const name of [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
])
  assert.equal(packageJson.peerDependencies[name], "*");
assert.deepEqual(packageJson.pi.extensions, [
  "./dist/extensions/pi-herdr-orchestrator.js",
]);
function assertExactPluginManifest(value, source) {
  assert.equal(
    (value.match(/^\[\[startup\]\]\s*$/gm) ?? []).length,
    1,
    `${source} must contain exactly one startup entry`,
  );
  assert.equal(
    (value.match(/^\[\[panes\]\]\s*$/gm) ?? []).length,
    1,
    `${source} must contain exactly one managed pane`,
  );
  const startup = value.match(
    /^\[\[startup\]\]\s*$([\s\S]*?)(?=^\[\[|(?![\s\S]))/m,
  )?.[1];
  assert.ok(startup, `${source} is missing its startup body`);
  assert.deepEqual(
    JSON.parse(
      startup.match(/^command\s*=\s*(\[[^\n]+\])\s*$/m)?.[1] ?? "null",
    ),
    ["./bin/pi-herdr-orchestrator", "broker", "startup"],
    `${source} has the wrong startup command`,
  );
}
assertExactPluginManifest(manifest, "source manifest");
for (const expected of [
  'id = "pi.herdr.orchestrator"',
  'min_herdr_version = "0.8.0"',
  'platforms = ["linux"]',
  'command = ["npm", "run", "build"]',
  'id = "deck"',
  'title = "Pi Herd"',
])
  assert.ok(manifest.includes(expected), `manifest is missing ${expected}`);
const packed = spawnSync(
  process.env.npm_execpath ? process.execPath : "npm",
  process.env.npm_execpath
    ? [process.env.npm_execpath, "pack", "--ignore-scripts", "--json"]
    : ["pack", "--ignore-scripts", "--json"],
  { cwd: repositoryRoot, encoding: "utf8" },
);
if (packed.status !== 0)
  throw new Error(packed.stderr || packed.stdout || "npm pack failed");
const metadata = JSON.parse(packed.stdout);
const filename = metadata[0]?.filename;
assert.ok(filename);
const archivePath = fileURLToPath(new URL(`../${filename}`, import.meta.url));
try {
  const listed = spawnSync("tar", ["-tf", archivePath], { encoding: "utf8" });
  if (listed.status !== 0) throw new Error(listed.stderr);
  const files = listed.stdout.trim().split("\n");
  for (const required of [
    "package/package.json",
    "package/herdr-plugin.toml",
    "package/bin/pi-herdr-orchestrator",
    "package/bin/pi-herdr-deck",
    "package/dist/extensions/pi-herdr-orchestrator.js",
    "package/dist/src/broker/broker.js",
    "package/schemas/event.schema.json",
  ])
    assert.ok(files.includes(required), `package is missing ${required}`);
  assert.equal(
    files.some((file) => file.includes("node_modules/")),
    false,
  );
  const packedManifest = spawnSync(
    "tar",
    ["-xOf", archivePath, "package/herdr-plugin.toml"],
    { encoding: "utf8" },
  );
  if (packedManifest.status !== 0) throw new Error(packedManifest.stderr);
  assertExactPluginManifest(packedManifest.stdout, "packed manifest");
  assert.equal(
    packedManifest.stdout,
    manifest,
    "packed manifest bytes differ from the reviewed source manifest",
  );
  process.stdout.write(`package smoke: ${filename} (${files.length} files)\n`);
} finally {
  rmSync(archivePath, { force: true });
}
