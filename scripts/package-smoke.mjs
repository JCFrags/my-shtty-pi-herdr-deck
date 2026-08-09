import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const manifest = readFileSync(new URL("../herdr-plugin.toml", import.meta.url), "utf8");
assert.deepEqual(packageJson.os, ["linux"]);
assert.equal(packageJson.engines.node, ">=22.19.0");
assert.equal(packageJson.dependencies["@pi-herdr-deck/tui"], "npm:@earendil-works/pi-tui@0.83.0");
assert.equal(packageJson.dependencies["@earendil-works/pi-tui"], undefined);
for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]) {
  assert.equal(packageJson.peerDependencies[name], "*", `${name} must remain an unbundled Pi peer dependency`);
  assert.equal(packageJson.dependencies?.[name], undefined, `${name} must not be bundled as a runtime dependency`);
}
assert.deepEqual(packageJson.pi.extensions, ["./dist/extensions/pi-herdr-deck.js"]);
for (const expected of [
  'id = "pi.herdr.deck"',
  'min_herdr_version = "0.7.2"',
  'platforms = ["linux"]',
  'command = ["npm", "run", "build"]',
  'id = "deck"',
  'title = "Pi Deck"',
  'placement = "split"',
  'command = ["./bin/pi-herdr-deck"]',
]) {
  assert.match(manifest, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

const npmExecPath = process.env.npm_execpath;
const packed = npmExecPath
  ? spawnSync(process.execPath, [npmExecPath, "pack", "--ignore-scripts", "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    })
  : spawnSync("npm", ["pack", "--ignore-scripts", "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout || "npm pack failed");
const metadata = JSON.parse(packed.stdout);
const filename = metadata[0]?.filename;
assert.ok(filename, "npm pack did not report an archive");
const archivePath = fileURLToPath(new URL(`../${filename}`, import.meta.url));
try {
  const listed = spawnSync("tar", ["-tf", archivePath], { encoding: "utf8" });
  if (listed.status !== 0) throw new Error(listed.stderr || "tar listing failed");
  const files = listed.stdout.trim().split("\n");
  for (const required of [
    "package/package.json",
    "package/herdr-plugin.toml",
    "package/bin/pi-herdr-deck",
    "package/dist/extensions/pi-herdr-deck.js",
    "package/dist/src/deck/main.js",
    "package/dist/src/bridge/protocol.js",
  ]) {
    assert.ok(files.includes(required), `package is missing ${required}`);
  }
  assert.equal(files.some((file) => file.includes("node_modules/")), false, "package must not bundle Pi or node_modules");
  process.stdout.write(`package smoke: ${filename} (${files.length} files)\n`);
} finally {
  rmSync(archivePath, { force: true });
}
