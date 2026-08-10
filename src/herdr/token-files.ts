import { mkdir, unlink, open, lstat, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { randomToken, tokenDigest } from "./names.js";
export interface ManagedToken {
  token: string;
  digest: string;
  generation: number;
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
    await h.writeFile(token.token + "\n", "utf8");
    await h.sync();
  } finally {
    await h.close();
  }
  return path;
}
export async function verifyManagedTokenFile(
  path: string,
  expectedDigest: string,
): Promise<boolean> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    return false;
  const value = (await readFile(path, "utf8")).trimEnd();
  const actual = Buffer.from(tokenDigest(value), "utf8");
  const expected = Buffer.from(expectedDigest, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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
    await h.writeFile(content, "utf8");
    await h.sync();
  } finally {
    await h.close();
  }
  return path;
}
export async function deletePromptFile(path: string): Promise<void> {
  await unlink(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
}
