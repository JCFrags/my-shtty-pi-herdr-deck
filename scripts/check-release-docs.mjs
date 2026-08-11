import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, "..");

function tomlString(source, key) {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, "m"));
  assert(match, `herdr-plugin.toml must define ${key}.`);
  return match[1];
}

function paneBlock(source) {
  const match = source.match(/^\[\[panes\]\]\s*$([\s\S]*)/m);
  assert(match, "herdr-plugin.toml must define one managed pane.");
  return match[1];
}

function tomlCommand(source) {
  const match = source.match(/^command\s*=\s*\[([^\]]+)\]\s*$/m);
  assert(match, "The managed pane must define a command array.");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function requireText(source, text, label) {
  assert(source.includes(text), `README.md must document ${label}: ${text}`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireTableValue(source, label, value) {
  const row = new RegExp(
    `^\\|\\s*${escapeRegex(label)}\\s*\\|\\s*\\x60${escapeRegex(value)}\\x60\\s*\\|$`,
    "m",
  );
  assert(row.test(source), `README.md must document ${label}: ${value}`);
}

export function validateReleaseDocs({ readme, packageJson, pluginToml }) {
  const packageData = JSON.parse(packageJson);
  const extension = packageData.pi?.extensions?.[0];
  assert.equal(
    extension,
    "./dist/extensions/pi-herdr-orchestrator.js",
    "package.json must expose the orchestrator extension.",
  );

  const pluginId = tomlString(pluginToml, "id");
  const minimumHerdr = tomlString(pluginToml, "min_herdr_version");
  const pane = paneBlock(pluginToml);
  const paneId = tomlString(pane, "id");
  const paneTitle = tomlString(pane, "title");
  const paneCommand = tomlCommand(pane);
  const expectedCommand = [packageData.bin?.["pi-herdr-orchestrator"], paneId];

  assert.equal(
    pluginId,
    "pi.herdr.orchestrator",
    "The primary plugin ID is stale.",
  );
  assert.equal(minimumHerdr, "0.8.0", "The minimum Herdr version is stale.");
  assert.equal(paneId, "deck", "The managed pane entrypoint is stale.");
  assert.equal(paneTitle, "Pi Herd", "The managed pane title is stale.");
  assert.deepEqual(
    paneCommand,
    expectedCommand,
    "The managed pane command and package binary differ.",
  );

  const compatibilityHeading = "## Compatibility: legacy Pi Deck";
  const compatibilityIndex = readme.indexOf(compatibilityHeading);
  assert(
    compatibilityIndex >= 0,
    "README.md must isolate legacy behavior in a compatibility section.",
  );
  const primaryReadme = readme.slice(0, compatibilityIndex);

  requireText(primaryReadme, extension, "the Pi extension path");
  requireText(
    primaryReadme,
    "/orchestrator-status",
    "the primary Pi status command",
  );
  requireText(primaryReadme, pluginId, "the Herdr plugin ID");
  requireTableValue(primaryReadme, "Managed pane entrypoint", paneId);
  requireTableValue(primaryReadme, "Managed pane title", paneTitle);
  requireTableValue(
    primaryReadme,
    "Managed pane command",
    paneCommand.join(" "),
  );
  requireTableValue(primaryReadme, "Minimum Herdr", minimumHerdr);
  requireText(
    primaryReadme,
    `--plugin ${pluginId}`,
    "the pane-open plugin identifier",
  );
  requireText(
    primaryReadme,
    `herdr plugin unlink ${pluginId}`,
    "the unlink plugin identifier",
  );

  assert(
    !primaryReadme.includes("pi.herdr.deck"),
    "The old plugin ID cannot appear as a primary identifier.",
  );
  assert(
    !readme.includes("dist/extensions/pi-herdr-deck.js"),
    "The old Pi extension path cannot appear in release documentation.",
  );

  return { extension, pluginId, paneId, paneTitle, paneCommand, minimumHerdr };
}

async function loadInputs(root) {
  const [readme, packageJson, pluginToml] = await Promise.all([
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "package.json"), "utf8"),
    readFile(join(root, "herdr-plugin.toml"), "utf8"),
  ]);
  return { readme, packageJson, pluginToml };
}

export function runNegativeMutationProof(inputs) {
  const oldIdMutation = {
    ...inputs,
    readme: inputs.readme.replace("pi.herdr.orchestrator", "pi.herdr.deck"),
  };
  assert.throws(
    () => validateReleaseDocs(oldIdMutation),
    /old plugin ID|Herdr plugin ID/,
    "The check must reject the old primary plugin ID.",
  );

  const oldPathMutation = {
    ...inputs,
    readme: inputs.readme.replace(
      "./dist/extensions/pi-herdr-orchestrator.js",
      "dist/extensions/pi-herdr-deck.js",
    ),
  };
  assert.throws(
    () => validateReleaseDocs(oldPathMutation),
    /Pi extension path|old Pi extension path/,
    "The check must reject the old primary extension path.",
  );
}

async function main() {
  const inputs = await loadInputs(defaultRoot);
  const result = validateReleaseDocs(inputs);
  runNegativeMutationProof(inputs);
  console.log(
    JSON.stringify({
      status: "ok",
      check: "release-docs",
      negativeMutationProofs: 2,
      ...result,
    }),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
