import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  authoritativeHerdrBinary,
  revalidateHerdrBinary,
} from "../../src/herdr/binary.js";

const canonicalError = "HERDR_BIN_PATH must be a canonical absolute path.";
const unsafeError = "HERDR_BIN_PATH is missing, replaced, or unsafe.";

async function executable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
}

test("authoritative Herdr binary rejects missing and malformed paths deterministically", async () => {
  const previous = process.env.HERDR_BIN_PATH;
  delete process.env.HERDR_BIN_PATH;
  try {
    await assert.rejects(
      () => authoritativeHerdrBinary(),
      new Error("HERDR_UNAVAILABLE: HERDR_BIN_PATH is not configured."),
    );
  } finally {
    if (previous === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = previous;
  }
  await assert.rejects(
    () => authoritativeHerdrBinary(`/${"é".repeat(2048)}`),
    new Error(canonicalError),
  );
  await assert.rejects(
    () => authoritativeHerdrBinary("relative/herdr"),
    new Error(canonicalError),
  );

  const root = await mkdtemp(join(tmpdir(), "herdr-binary-path-"));
  try {
    const binary = join(root, "herdr");
    await executable(binary);
    const noncanonical = `${root}/../${basename(root)}/herdr`;
    assert.notEqual(noncanonical, binary);
    await assert.rejects(
      () => authoritativeHerdrBinary(noncanonical),
      new Error(canonicalError),
    );
    const identity = await authoritativeHerdrBinary(binary);
    assert.equal(identity.path, binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authoritative Herdr binary rejects unsafe file identities and modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-binary-safety-"));
  try {
    const target = join(root, "target");
    const symbolic = join(root, "symbolic");
    await executable(target);
    await symlink(target, symbolic);
    await assert.rejects(
      () => authoritativeHerdrBinary(symbolic),
      new Error(unsafeError),
    );

    const hardlinkTarget = join(root, "hardlink-target");
    const hardlinkPath = join(root, "hardlink");
    await executable(hardlinkTarget);
    await link(hardlinkTarget, hardlinkPath);
    await assert.rejects(
      () => authoritativeHerdrBinary(hardlinkTarget),
      new Error(unsafeError),
    );

    const directory = join(root, "directory");
    await mkdir(directory, { mode: 0o700 });
    await assert.rejects(
      () => authoritativeHerdrBinary(directory),
      new Error(unsafeError),
    );

    for (const [name, fileMode] of [
      ["group-writable", 0o720],
      ["other-writable", 0o702],
    ] as const) {
      const writable = join(root, name);
      await executable(writable);
      await chmod(writable, fileMode);
      await assert.rejects(
        () => authoritativeHerdrBinary(writable),
        new Error(unsafeError),
      );
    }

    const nonexecutable = join(root, "nonexecutable");
    await writeFile(nonexecutable, "not executable\n", { mode: 0o600 });
    await assert.rejects(
      () => authoritativeHerdrBinary(nonexecutable),
      new Error(unsafeError),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retained Herdr binary rejects replacement, mode, and link mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-binary-retained-"));
  try {
    const replacement = join(root, "replacement");
    const moved = join(root, "moved");
    await executable(replacement);
    const replacementIdentity = await authoritativeHerdrBinary(replacement);
    await rename(replacement, moved);
    await executable(replacement);
    await assert.rejects(
      () => revalidateHerdrBinary(replacementIdentity),
      /HERDR_BIN_PATH changed after broker startup/u,
    );

    const modePath = join(root, "mode");
    await executable(modePath);
    const modeIdentity = await authoritativeHerdrBinary(modePath);
    await chmod(modePath, 0o500);
    await assert.rejects(
      () => revalidateHerdrBinary(modeIdentity),
      /HERDR_BIN_PATH changed after broker startup/u,
    );

    const linkPath = join(root, "link-target");
    await executable(linkPath);
    const linkIdentity = await authoritativeHerdrBinary(linkPath);
    const addedLink = join(root, "new-link");
    await link(linkPath, addedLink);
    await unlink(addedLink);
    await assert.rejects(
      () => revalidateHerdrBinary(linkIdentity),
      /HERDR_BIN_PATH changed after broker startup/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
