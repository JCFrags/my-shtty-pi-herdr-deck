import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../../src/results/artifact-store.js";
import { LIMITS } from "../../src/shared/limits.js";

async function withStore(
  run: (store: ArtifactStore, root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "m4-artifact-security-"));
  try {
    await run(new ArtifactStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("artifact writes reject path, media type, and size boundary violations", async () => {
  await withStore(async (store) => {
    const oversized = Buffer.alloc(LIMITS.maxArtifactBytes + 1);
    for (const name of [
      "../escape",
      "nested/file",
      "/absolute",
      "back\\slash",
    ]) {
      await assert.rejects(
        () =>
          store.put({
            kind: "text",
            name,
            content: "x",
            mediaType: "text/plain",
          }),
        /invalid/i,
      );
    }
    await assert.rejects(() =>
      store.put({ kind: "text", name: "x", content: "x", mediaType: "" }),
    );
    await assert.rejects(() =>
      store.put({
        kind: "text",
        name: "x",
        content: "x",
        mediaType: "m".repeat(129),
      }),
    );
    await assert.rejects(() =>
      store.put({
        kind: "text",
        name: "x",
        content: oversized,
        mediaType: "text/plain",
      }),
    );
  });
});

test("artifact reads enforce safe integer bounds and return only the requested window", async () => {
  await withStore(async (store) => {
    const ref = await store.put({
      kind: "text",
      name: "bounded.txt",
      content: "0123456789",
      mediaType: "text/plain",
    });
    assert.equal((await store.read(ref, 3, 4)).content.toString(), "3456");
    assert.equal((await store.read(ref, 99, 4)).content.toString(), "");
    for (const [offset, limit] of [
      [-1, 1],
      [0.5, 1],
      [Number.NaN, 1],
      [0, -1],
      [0, 0.5],
      [0, Number.NaN],
      [0, LIMITS.maxArtifactBytes + 1],
    ]) {
      await assert.rejects(() => store.read(ref, offset, limit));
    }
  });
});

test("artifact reads reject traversal, symlink, permission, and hardlink substitutions", async () => {
  await withStore(async (store, root) => {
    const ref = await store.put({
      kind: "text",
      name: "private.txt",
      content: "private",
      mediaType: "text/plain",
    });
    const path = join(root, ref.relativePath);
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside", { mode: 0o600 });

    await assert.rejects(() =>
      store.read({ ...ref, relativePath: "../outside.txt" }),
    );

    await unlink(path);
    await symlink(outside, path);
    await assert.rejects(() => store.read(ref));

    await unlink(path);
    await writeFile(path, "private", { mode: 0o600 });
    await chmod(path, 0o640);
    await assert.rejects(() => store.read(ref));

    await chmod(path, 0o600);
    await unlink(path);
    await link(outside, path);
    const stat = await lstat(path);
    assert.equal(stat.nlink, 2);
    await assert.rejects(() => store.read(ref));
  });
});

test("artifact digest and byte-length references are verified before reads", async () => {
  await withStore(async (store, root) => {
    const ref = await store.put({
      kind: "text",
      name: "verified.txt",
      content: "original",
      mediaType: "text/plain",
    });
    const path = join(root, ref.relativePath);
    await writeFile(path, "tampered", { mode: 0o600 });
    await assert.rejects(() => store.read(ref));
    await writeFile(path, "original", { mode: 0o600 });
    await assert.rejects(() =>
      store.read({ ...ref, byteLength: ref.byteLength + 1 }),
    );
    await assert.rejects(() => store.read({ ...ref, sha256: "0".repeat(64) }));
    assert.equal(await readFile(path, "utf8"), "original");
  });
});
