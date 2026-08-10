import { createHash } from "node:crypto";
import { mkdir, lstat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
export interface ResolvedPaths {
  root: string;
  runtime: string;
  events: string;
  snapshot: string;
  lock: string;
  socket: string;
  secret: string;
}
export function sessionKey(socketPath: string): string {
  return createHash("sha256").update(socketPath).digest("hex").slice(0, 24);
}
export function resolvePaths(socketPath = "herdr"): ResolvedPaths {
  const root =
    process.env.PI_HERDR_ORCH_STATE_ROOT ??
    join(homedir(), ".pi", "agent", "pi-herdr-orchestrator");
  const runtime =
    process.env.PI_HERDR_ORCH_RUNTIME_ROOT ??
    join(
      process.env.XDG_RUNTIME_DIR ?? tmpdir(),
      `pi-herdr-orchestrator-${process.getuid?.() ?? 0}`,
    );
  const key = sessionKey(socketPath);
  return {
    root,
    runtime,
    events: join(root, `${key}.events.jsonl`),
    snapshot: join(root, `${key}.snapshot.json`),
    lock: join(runtime, `${key}.lock`),
    socket: join(runtime, `${key}.sock`),
    secret: join(runtime, `${key}.secret`),
  };
}
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Unsafe private directory: ${path}`);
  if (process.getuid?.() !== undefined && stat.uid !== process.getuid())
    throw new Error("Private directory has the wrong owner.");
}
