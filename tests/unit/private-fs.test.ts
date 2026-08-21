import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  readPrivateLines,
  replacePrivateRegular,
} from "../../src/shared/private-fs.js";

test("replacePrivateRegular preserves private mode and refuses a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "private-fs-replace-"));
  const path = join(root, "config.json");
  const target = join(root, "target.json");
  try {
    await writeFile(path, "old\n", { mode: 0o600 });
    await replacePrivateRegular(path, "new\n");
    assert.equal(await readFile(path, "utf8"), "new\n");
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await rm(path);
    await writeFile(target, "keep\n", { mode: 0o600 });
    await symlink(target, path);
    await assert.rejects(
      replacePrivateRegular(path, "bad\n"),
      /Unsafe private file/u,
    );
    assert.equal(await readFile(target, "utf8"), "keep\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readPrivateLines closes one owned stream on early generator cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "private-fs-cancel-"));
  const path = join(root, "events.log");
  const content = `first\n${"payload\n".repeat(1_000_000)}`;
  await writeFile(path, content, { mode: 0o600 });
  let uncaught = 0;
  const monitor = (error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === "EBADF") uncaught++;
  };
  process.on("uncaughtExceptionMonitor", monitor);
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      const iterator = readPrivateLines(path);
      const first = await iterator.next();
      assert.equal(first.value, "first");
      await iterator.return(undefined);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(uncaught, 0);
  } finally {
    process.off("uncaughtExceptionMonitor", monitor);
    await rm(root, { recursive: true, force: true });
  }
});
