import { mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { randomToken, tokenDigest } from "./names.js";
export interface ManagedToken {
  token: string;
  digest: string;
  generation: number;
}
export interface FileIdentity {
  dev: number;
  ino: number;
}
interface FileClaim extends FileIdentity {}
export type ManagedFileCleanupResult = "wiped" | "retained" | "missing";
interface ManagedFileHooks {
  /** Test-only synchronization point after open and the first stat. */
  afterOpen?: () => Promise<void>;
}
const fileClaims = new Map<string, FileClaim>();
function claim(path: string, stat: { dev: number; ino: number }): void {
  fileClaims.set(path, { dev: stat.dev, ino: stat.ino });
}
function isClaimed(path: string, stat: { dev: number; ino: number }): boolean {
  const expected = fileClaims.get(path);
  return (
    expected !== undefined &&
    expected.dev === stat.dev &&
    expected.ino === stat.ino
  );
}
export function createManagedToken(generation = 1): ManagedToken {
  const token = randomToken();
  return { token, digest: tokenDigest(token), generation };
}
export async function createManagedTokenFile(
  root: string,
  agentId: string,
  token: ManagedToken,
): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `.token-${agentId}-${randomToken().slice(0, 12)}`);
  const h = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    claim(path, await h.stat());
    await h.writeFile(token.token + "\n", "utf8");
    await h.sync();
  } finally {
    await h.close();
  }
  return path;
}
export async function managedFileIdentity(path: string): Promise<FileIdentity> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
      throw new Error("Managed file is unsafe.");
    return { dev: stat.dev, ino: stat.ino };
  } finally {
    await handle.close();
  }
}
function sameIdentity(actual: FileIdentity, expected?: FileIdentity): boolean {
  return (
    !expected || (actual.dev === expected.dev && actual.ino === expected.ino)
  );
}
function isSafeManagedStat(stat: {
  isFile: () => boolean;
  nlink: number;
  mode: number;
}): boolean {
  return stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0;
}
export async function verifyManagedTokenFile(
  path: string,
  expectedDigest: string,
  expectedIdentity?: FileIdentity,
  hooks?: ManagedFileHooks,
): Promise<boolean> {
  let handle;
  try {
    // Open the claimed inode before any await. Do not verify one pathname and
    // read another inode after a replacement.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!isSafeManagedStat(stat)) return false;
    if (!sameIdentity(stat, expectedIdentity)) return false;
    if (expectedIdentity === undefined && !isClaimed(path, stat)) return false;
    await hooks?.afterOpen?.();
    // Revalidate after the last await and before reading private bytes. A
    // hard-link added while the handle was open must be retained untouched.
    const beforeRead = await handle.stat();
    if (
      !isSafeManagedStat(beforeRead) ||
      !sameIdentity(beforeRead, stat) ||
      (expectedIdentity === undefined && !isClaimed(path, beforeRead))
    )
      return false;
    const value = (await handle.readFile("utf8")).trimEnd();
    const actual = Buffer.from(tokenDigest(value), "utf8");
    const expected = Buffer.from(expectedDigest, "utf8");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  } catch (error) {
    if (
      ["ENOENT", "ELOOP", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return false;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function createPromptFile(
  root: string,
  agentId: string,
  content: string,
): Promise<string> {
  if (Buffer.byteLength(content) > 256 * 1024 || /[\u0000]/u.test(content))
    throw new Error("Prompt file is invalid or too large.");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `.prompt-${agentId}-${randomToken().slice(0, 12)}`);
  const h = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    claim(path, await h.stat());
    await h.writeFile(content, "utf8");
    await h.sync();
  } finally {
    await h.close();
  }
  return path;
}
export async function deletePromptFile(
  path: string,
  expectedIdentity?: FileIdentity,
  hooks?: ManagedFileHooks,
): Promise<ManagedFileCleanupResult> {
  let handle;
  try {
    // This is a claimed-inode wipe. There is no safe compare-and-unlink API
    // here, so never unlink a pathname that may now name a replacement.
    handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!isSafeManagedStat(stat)) return "retained";
    if (!sameIdentity(stat, expectedIdentity)) return "retained";
    if (expectedIdentity === undefined && !isClaimed(path, stat))
      return "retained";
    await hooks?.afterOpen?.();
    // Revalidate after the last await and before changing private bytes. There
    // is no compare-and-remove primitive, so an ambiguous file is retained.
    const beforeWipe = await handle.stat();
    if (
      !isSafeManagedStat(beforeWipe) ||
      !sameIdentity(beforeWipe, stat) ||
      (expectedIdentity === undefined && !isClaimed(path, beforeWipe))
    )
      return "retained";
    for (let offset = 0; offset < beforeWipe.size;) {
      const current = await handle.stat();
      if (
        !isSafeManagedStat(current) ||
        !sameIdentity(current, beforeWipe) ||
        (expectedIdentity === undefined && !isClaimed(path, current))
      )
        return "retained";
      const length = Math.min(64 * 1024, beforeWipe.size - offset);
      await handle.write(Buffer.alloc(length), 0, length, offset);
      offset += length;
    }
    const beforeTruncate = await handle.stat();
    if (
      !isSafeManagedStat(beforeTruncate) ||
      !sameIdentity(beforeTruncate, beforeWipe) ||
      (expectedIdentity === undefined && !isClaimed(path, beforeTruncate))
    )
      return "retained";
    await handle.truncate(0);
    await handle.sync();
    fileClaims.delete(path);
    return "wiped";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
