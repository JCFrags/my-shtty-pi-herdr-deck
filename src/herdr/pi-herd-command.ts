import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

export const PI_HERD_ARGV = [
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
] as const;

type Registry = Record<string, { paneId: string; updatedAt: number }>;

function registryPath(env: NodeJS.ProcessEnv): string {
  return (
    env.HERDR_PI_HERD_REGISTRY ??
    join(env.XDG_RUNTIME_DIR ?? "/tmp", "pi-herdr-decks.json")
  );
}

async function loadRegistry(path: string): Promise<Registry> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Registry)
      : {};
  } catch {
    return {};
  }
}

async function saveRegistry(path: string, registry: Registry): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function invoke(
  binary: string,
  argv: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv.split("\u0000"), {
      shell: false,
      env: environment,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code: code ?? 1, output: output.trim() }),
    );
  });
}

function openedPaneId(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as {
      result?: { plugin_pane?: { pane?: { pane_id?: unknown } } };
    };
    const paneId = parsed.result?.plugin_pane?.pane?.pane_id;
    if (typeof paneId === "string" && paneId.length > 0) return paneId;
  } catch {
    // Older Herdr versions can return the pane ID as plain text.
  }
  const plain = output.trim();
  return /^[A-Za-z0-9:_-]{1,256}$/u.test(plain) ? plain : undefined;
}

export async function openPiHerd(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const binary = env.HERDR_BIN_PATH;
  const targetPaneId = env.HERDR_PANE_ID?.trim();
  if (!binary || !binary.startsWith("/"))
    throw new Error(
      "Agent Board is available only inside Herdr (missing absolute HERDR_BIN_PATH).",
    );
  if (!targetPaneId)
    throw new Error(
      "Agent Board is available only inside Herdr (missing HERDR_PANE_ID).",
    );
  try {
    await access(binary, constants.X_OK);
  } catch {
    throw new Error(
      "Agent Board cannot open: HERDR_BIN_PATH is not executable.",
    );
  }

  const path = registryPath(env);
  const registry = await loadRegistry(path);
  const entry = registry[targetPaneId];
  if (entry?.paneId) {
    const focused = await invoke(
      binary,
      ["plugin", "pane", "focus", entry.paneId].join("\u0000"),
      env,
    );
    if (focused.code === 0) {
      registry[targetPaneId] = { ...entry, updatedAt: Date.now() };
      await saveRegistry(path, registry);
      return "Agent Board focused the existing pane.";
    }
  }

  const open = await invoke(
    binary,
    [
      ...PI_HERD_ARGV.slice(0, 10),
      targetPaneId,
      ...PI_HERD_ARGV.slice(10),
    ].join("\u0000"),
    env,
  );
  if (open.code !== 0)
    throw new Error(`Agent Board did not open (exit ${open.code}).`);
  // Herdr returns the new pane identity as JSON. Older versions can return plain text.
  const createdPaneId = openedPaneId(open.output);
  if (createdPaneId)
    registry[targetPaneId] = { paneId: createdPaneId, updatedAt: Date.now() };
  await saveRegistry(path, registry);
  return "Agent Board opened as a focused right split.";
}
