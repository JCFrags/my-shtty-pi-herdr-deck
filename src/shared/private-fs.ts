import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
const noFollow =
  (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
export async function openPrivateRegular(path: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | noFollow);
  const stat = await handle.stat();
  const uid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (uid !== undefined && stat.uid !== uid)
  ) {
    await handle.close();
    throw new Error(`Unsafe private file: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) await handle.chmod(0o600);
  return handle;
}
export async function readPrivateRegular(path: string): Promise<string> {
  const handle = await openPrivateRegular(path);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
export async function createPrivateExclusive(
  path: string,
  content: string,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}
export async function verifyPrivatePath(path: string): Promise<void> {
  const stat = await lstat(path);
  const uid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error(`Unsafe private file: ${path}`);
}
