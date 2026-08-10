import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { readPrivateLines } from "../../src/shared/private-fs.js";

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
