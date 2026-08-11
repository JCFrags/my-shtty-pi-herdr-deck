import {
  copyFile,
  mkdir,
  readdir,
  lstat,
  readFile,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ResolvedPaths } from "../shared/paths.js";

export interface RetentionCandidate {
  path: string;
  bytes: number;
  reason: "expired-log" | "stale-runtime";
}
export interface RetentionPlan {
  dryRun: true;
  candidates: RetentionCandidate[];
  retained: string[];
}

export async function planRetention(
  root: string,
  now = Date.now(),
  maxAgeMs = 7 * 86400000,
): Promise<RetentionPlan> {
  const candidates: RetentionCandidate[] = [];
  const retained: string[] = [];
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of names) {
    const path = join(root, name);
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid())
    ) {
      retained.push(name);
      continue;
    }
    if (
      name.endsWith(".events.jsonl") ||
      name.endsWith(".snapshot.json") ||
      name.endsWith(".secret")
    ) {
      retained.push(name);
      continue;
    }
    if (
      name.startsWith("broker-") &&
      name.endsWith(".jsonl") &&
      now - stat.mtimeMs > maxAgeMs
    )
      candidates.push({ path, bytes: stat.size, reason: "expired-log" });
    else retained.push(name);
  }
  return { dryRun: true, candidates, retained };
}
export async function exportState(
  paths: ResolvedPaths,
  output: string,
): Promise<{ output: string; manifest: string[] }> {
  const destination = resolve(output);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const manifest: string[] = [];
  for (const source of [paths.events, paths.snapshot]) {
    try {
      const stat = await lstat(source);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())
      )
        throw new Error("Unsafe state file.");
      const target = join(destination, basename(source));
      await copyFile(source, target);
      const digest = createHash("sha256")
        .update(await readFile(target))
        .digest("hex");
      manifest.push(`${basename(source)} sha256:${digest}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await writeFile(
    join(destination, "MANIFEST.txt"),
    `${manifest.join("\n")}\n`,
    { mode: 0o600 },
  );
  return { output: destination, manifest };
}
