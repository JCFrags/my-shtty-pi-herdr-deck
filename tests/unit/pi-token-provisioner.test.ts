import assert from "node:assert/strict";
import {
  mkdtemp,
  chmod,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";
import {
  readBrokerSecretFile,
  readManagedTokenFile,
  siblingSecretPath,
} from "../../src/pi/token-file.js";
import { resolvePaths } from "../../src/shared/paths.js";

test("provisioner inserts the created owner-only token path into the tab environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-provision-"));
  let tabEnv: Record<string, string> | undefined;
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async (input: { env: Record<string, string> }) => {
      tabEnv = input.env;
      return { tab_id: "tab", root_pane_id: "pane" };
    },
    startPi: async () => ({ pane_id: "pane" }),
    snapshot: async () => ({ panes: [], tabs: [] }),
  };
  const result = await new HerdrProvisioner(
    cli as never,
    join(root, "private"),
    () => [],
    true,
    undefined,
    {
      socketPath: "/tmp/owned-runtime/broker.sock",
      sessionKey: "0123456789abcdef01234567",
    },
  ).provision({
    agentId: "agt",
    parentAgentId: "parent",
    role: "scout",
    workspaceId: "ws",
    cwd: root,
    profileId: "scout",
    isolation: "shared-readonly",
    prompt: "prompt",
  });
  assert.ok(tabEnv?.PI_HERDR_ORCH_TOKEN_FILE);
  assert.equal(tabEnv?.PI_HERDR_ORCH_TOKEN_FILE, result.tokenFilePath);
  assert.notEqual(tabEnv?.PI_HERDR_ORCH_TOKEN_FILE, "");
  assert.equal(
    await readManagedTokenFile(tabEnv!.PI_HERDR_ORCH_TOKEN_FILE),
    result.token.token,
  );
  assert.equal(Object.hasOwn(tabEnv!, "PI_HERDR_ORCH_AGENT_TOKEN"), false);
  assert.equal(
    tabEnv?.PI_HERDR_ORCH_BROKER_SOCKET,
    "/tmp/owned-runtime/broker.sock",
  );
  assert.equal(tabEnv?.PI_HERDR_ORCH_SESSION_KEY, "0123456789abcdef01234567");
  assert.equal(
    Object.values(tabEnv!).some((value) => value.includes("secret")),
    false,
  );
});

test("provisioner always rejects caller broker and session overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-override-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let mutations = 0;
  const cli = {
    createTab: async () => {
      mutations += 1;
      return {};
    },
  };
  const provisioner = new HerdrProvisioner(cli as never, join(root, "private"));
  for (const env of [
    { PI_HERDR_ORCH_BROKER_SOCKET: "/tmp/caller.sock" },
    { PI_HERDR_ORCH_SESSION_KEY: "f".repeat(24) },
  ])
    await assert.rejects(
      provisioner.provision({
        agentId: "agt",
        parentAgentId: "parent",
        role: "scout",
        workspaceId: "ws",
        cwd: root,
        profileId: "scout",
        isolation: "shared-readonly",
        prompt: "prompt",
        env,
      }),
      /Managed environment override rejected/u,
    );
  assert.equal(mutations, 0);
});

test("adopted secret resolution uses the real resolvePaths sibling and ignores sock.secret decoys", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-adopted-path-"));
  const prior = process.env.PI_HERDR_ORCH_RUNTIME_ROOT;
  process.env.PI_HERDR_ORCH_RUNTIME_ROOT = root;
  try {
    const paths = resolvePaths("adopted-test");
    await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
    await writeFile(
      paths.secret,
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi012345_-\n",
      { mode: 0o600 },
    );
    await writeFile(`${paths.socket}.secret`, "decoy-secret\n", {
      mode: 0o600,
    });
    assert.equal(siblingSecretPath(paths.socket), paths.secret);
    assert.equal(
      await readBrokerSecretFile(paths.secret),
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi012345_-",
    );
    assert.notEqual(siblingSecretPath(paths.socket), `${paths.socket}.secret`);
    assert.throws(
      () => siblingSecretPath("/tmp/not-a-socket"),
      /PI_SOCKET_PATH_INVALID/,
    );
  } finally {
    if (prior === undefined) delete process.env.PI_HERDR_ORCH_RUNTIME_ROOT;
    else process.env.PI_HERDR_ORCH_RUNTIME_ROOT = prior;
  }
});

test("managed token reader rejects unsafe, oversized, and symlink token files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-token-reader-"));
  const path = join(root, "token");
  await writeFile(path, "valid-token-value-01234567890123456789\n", {
    mode: 0o600,
  });
  await chmod(path, 0o644);
  await assert.rejects(
    () => readManagedTokenFile(path),
    /Unsafe private file|PI_TOKEN_FILE_INVALID/,
  );
  await chmod(path, 0o600);
  await symlink(path, join(root, "link"));
  await assert.rejects(
    () => readManagedTokenFile(join(root, "link")),
    /Unsafe private file|PI_TOKEN_FILE_INVALID/,
  );
});
