import { chmod, lstat, open, readFile, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
export interface LockIdentity {
  dev: number;
  ino: number;
  uid: number;
}
async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export class BrokerLock {
  #handle: FileHandle | undefined;
  #identity: LockIdentity | undefined;
  constructor(readonly path: string) {}
  get identity(): LockIdentity | undefined {
    return this.#identity;
  }
  async acquire(): Promise<void> {
    for (;;) {
      try {
        this.#handle = await open(this.path, "wx", 0o600);
        await this.#handle.write(`${process.pid}\n`);
        await this.#handle.sync();
        await chmod(this.path, 0o600);
        const stat = await lstat(this.path);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          (process.getuid?.() !== undefined && stat.uid !== process.getuid())
        )
          throw new Error("Unsafe broker lock.");
        this.#identity = { dev: stat.dev, ino: stat.ino, uid: stat.uid };
        return;
      } catch (error) {
        await this.#handle?.close().catch(() => undefined);
        this.#handle = undefined;
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const text = await readFile(this.path, "utf8").catch(() => "");
        const pid = Number(text.trim().split("\n")[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0 || (await alive(pid)))
          throw new Error(
            "Broker lock is held by a live or unverifiable process.",
          );
        const stat = await lstat(this.path);
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error("Refusing unsafe stale broker lock.");
        await unlink(this.path);
      }
    }
  }
  async release(): Promise<void> {
    const expected = this.#identity;
    if (expected) {
      const stat = await lstat(this.path).catch(() => undefined);
      if (
        stat &&
        (stat.dev !== expected.dev ||
          stat.ino !== expected.ino ||
          stat.uid !== expected.uid)
      )
        throw new Error("Broker lock identity changed.");
    }
    await this.#handle?.close();
    this.#handle = undefined;
    this.#identity = undefined;
    if (expected)
      await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}
