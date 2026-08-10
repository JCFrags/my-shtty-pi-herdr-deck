import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  link,
  mkdtemp,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createManagedToken,
  createManagedTokenFile,
  createPromptFile,
  managedFileIdentity,
} from "../../src/herdr/token-files.js";

const run = promisify(execFile);

async function child(
  modulePath: string,
  mode: string,
  path: string,
  digest: string,
  identity: { dev: number; ino: number },
  sentinel?: string,
): Promise<string> {
  const script = `
    const m = await import(process.env.MODULE);
    const identity = JSON.parse(process.env.IDENTITY);
    const hooks = process.env.SENTINEL ? {
      afterOpen: async () => {
        const { link, unlink } = await import("node:fs/promises");
        await link(process.env.PATH, process.env.SENTINEL);
        await unlink(process.env.PATH);
        await link(process.env.SENTINEL, process.env.PATH);
      },
    } : undefined;
    const result = process.env.MODE === "verify"
      ? await m.verifyManagedTokenFile(process.env.PATH, process.env.DIGEST, identity, hooks)
      : await m.deletePromptFile(process.env.PATH, identity, hooks);
    process.stdout.write(JSON.stringify(result));
  `;
  const result = await run(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        MODULE: `file://${modulePath}`,
        MODE: mode,
        PATH: path,
        DIGEST: digest,
        IDENTITY: JSON.stringify(identity),
        ...(sentinel ? { SENTINEL: sentinel } : {}),
      },
    },
  );
  return result.stdout;
}

test("M2 claimed token inode survives a separate Node process restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-token-restart-"));
  const token = createManagedToken();
  const path = await createManagedTokenFile(root, "agent", token);
  const identity = await managedFileIdentity(path);
  const modulePath = join(process.cwd(), "dist/src/herdr/token-files.js");
  assert.equal(
    await child(modulePath, "verify", path, token.digest, identity),
    "true",
  );
  await child(modulePath, "delete", path, token.digest, identity);
  assert.equal(await readFile(path, "utf8"), "");
});

test("M2 separate process refuses hard-link sentinel custody attacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-token-hardlink-"));
  const token = createManagedToken();
  const tokenPath = await createManagedTokenFile(root, "agent", token);
  const tokenIdentity = await managedFileIdentity(tokenPath);
  const tokenSentinel = join(root, "token-sentinel");
  await link(tokenPath, tokenSentinel);
  await unlink(tokenPath);
  await link(tokenSentinel, tokenPath);
  const modulePath = join(process.cwd(), "dist/src/herdr/token-files.js");
  assert.equal(
    await child(modulePath, "verify", tokenPath, token.digest, tokenIdentity),
    "false",
  );
  assert.equal(await readFile(tokenPath, "utf8"), token.token + "\n");
  assert.equal(await readFile(tokenSentinel, "utf8"), token.token + "\n");

  const promptPath = await createPromptFile(root, "agent", "prompt sentinel\n");
  const promptIdentity = await managedFileIdentity(promptPath);
  const promptSentinel = join(root, "prompt-sentinel");
  await link(promptPath, promptSentinel);
  await unlink(promptPath);
  await link(promptSentinel, promptPath);
  await child(modulePath, "delete", promptPath, "unused", promptIdentity);
  assert.equal(await readFile(promptPath, "utf8"), "prompt sentinel\n");
  assert.equal(await readFile(promptSentinel, "utf8"), "prompt sentinel\n");
});

test("M2 post-open hard-link race retains token and prompt bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-token-hardlink-race-"));
  const modulePath = join(process.cwd(), "dist/src/herdr/token-files.js");
  const token = createManagedToken();
  const tokenPath = await createManagedTokenFile(root, "agent", token);
  const tokenIdentity = await managedFileIdentity(tokenPath);
  const tokenSentinel = join(root, "token-race-sentinel");
  assert.equal(
    await child(
      modulePath,
      "verify",
      tokenPath,
      token.digest,
      tokenIdentity,
      tokenSentinel,
    ),
    "false",
  );
  assert.equal(await readFile(tokenPath, "utf8"), token.token + "\n");
  assert.equal(await readFile(tokenSentinel, "utf8"), token.token + "\n");

  const promptPath = await createPromptFile(root, "agent", "prompt race\n");
  const promptIdentity = await managedFileIdentity(promptPath);
  const promptSentinel = join(root, "prompt-race-sentinel");
  assert.equal(
    await child(
      modulePath,
      "delete",
      promptPath,
      "unused",
      promptIdentity,
      promptSentinel,
    ),
    JSON.stringify("retained"),
  );
  assert.equal(await readFile(promptPath, "utf8"), "prompt race\n");
  assert.equal(await readFile(promptSentinel, "utf8"), "prompt race\n");
});

test("M2 separate process refuses replacement and symlink custody attacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-token-attacks-"));
  const token = createManagedToken();
  const path = await createManagedTokenFile(root, "agent", token);
  const identity = await managedFileIdentity(path);
  const modulePath = join(process.cwd(), "dist/src/herdr/token-files.js");
  await unlink(path);
  await writeFile(path, "replacement\n", { mode: 0o600 });
  assert.equal(
    await child(modulePath, "verify", path, token.digest, identity),
    "false",
  );
  assert.equal(await readFile(path, "utf8"), "replacement\n");

  const target = join(root, "target");
  await writeFile(target, "target\n", { mode: 0o600 });
  await unlink(path);
  await symlink(target, path);
  assert.equal(
    await child(modulePath, "verify", path, token.digest, identity),
    "false",
  );
  assert.equal(await readFile(target, "utf8"), "target\n");
});

test("M2 post-open replacement cannot redirect a claimed inode", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-token-post-open-"));
  const token = createManagedToken();
  const path = await createManagedTokenFile(root, "agent", token);
  const identity = await managedFileIdentity(path);
  const ready = join(root, "ready");
  const release = join(root, "release");
  const script = `
    import { constants } from "node:fs";
    import { open, writeFile, readFile, access } from "node:fs/promises";
    const { tokenDigest } = await import(process.env.MODULE);
    const h = await open(process.env.PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
    const s = await h.stat();
    if (s.dev !== Number(process.env.DEV) || s.ino !== Number(process.env.INO)) process.exit(2);
    await writeFile(process.env.READY, "ready");
    while (true) { try { await access(process.env.RELEASE); break; } catch {} await new Promise(r => setTimeout(r, 5)); }
    process.stdout.write(tokenDigest((await h.readFile("utf8")).trimEnd()));
    await h.close();
  `;
  const proc = execFile(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        MODULE: `file://${namesModulePathForTests()}`,
        PATH: path,
        DEV: String(identity.dev),
        INO: String(identity.ino),
        READY: ready,
        RELEASE: release,
      },
    },
  );
  while (true) {
    try {
      await readFile(ready);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  await unlink(path);
  await writeFile(path, "attacker\n", { mode: 0o600 });
  let stdout = "";
  proc.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  await writeFile(release, "go");
  const result = await new Promise<void>((resolve, reject) =>
    proc
      .on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`child ${code}`)),
      )
      .on("error", reject),
  );
  void result;
  assert.equal(stdout, token.digest);
  assert.equal(await readFile(path, "utf8"), "attacker\n");
});

function namesModulePathForTests(): string {
  return join(process.cwd(), "dist/src/herdr/names.js");
}
