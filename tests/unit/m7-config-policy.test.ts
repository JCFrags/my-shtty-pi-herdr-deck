import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigPolicy,
  DEFAULT_CONFIG,
  allowedEnvironmentOverrides,
  assertTrustedProjectConfigPath,
  effectiveConfig,
} from "../../src/ops/config-policy.js";

test("configuration precedence applies only trusted project and permitted request fields", () => {
  const snapshot = effectiveConfig(
    {
      user: {
        scheduler: { maxActiveAgents: 8 },
        security: { allowSharedWrites: true },
      },
      project: { scheduler: { maxActiveAgents: 4 } },
      request: { scheduler: { maxActiveAgents: 2 } },
    },
    { trustedProject: true, requestFields: ["scheduler.maxActiveAgents"] },
  );
  assert.equal(snapshot.config.scheduler.maxActiveAgents, 2);
  assert.equal(snapshot.config.security.allowSharedWrites, true);
  assert.throws(() => effectiveConfig({ project: {} }), /trusted-project/);
  assert.throws(
    () => effectiveConfig({ request: { scheduler: { maxActiveAgents: 2 } } }),
    /permitted by profile/,
  );
});

test("project and request layers cannot raise effective safety policy", () => {
  assert.throws(
    () =>
      effectiveConfig(
        {
          user: { scheduler: { maxActiveAgents: 2 } },
          project: { scheduler: { maxActiveAgents: 3 } },
        },
        { trustedProject: true },
      ),
    /only narrow/,
  );
  assert.throws(
    () =>
      effectiveConfig(
        {
          user: { security: { allowSharedWrites: false } },
          project: { security: { allowSharedWrites: true } },
        },
        { trustedProject: true },
      ),
    /may not enable/,
  );
});

test("effective snapshots are hashed, immutable, and generation-stable on no-op reload", () => {
  const policy = new ConfigPolicy({
    user: { scheduler: { maxQueuedTasks: 10 } },
  });
  const first = policy.snapshot;
  assert.equal(first.config.scheduler.maxQueuedTasks, 10);
  assert.throws(
    () =>
      ((first.config.scheduler as { maxQueuedTasks: number }).maxQueuedTasks =
        1),
    TypeError,
  );
  const result = policy.reload({ user: { scheduler: { maxQueuedTasks: 10 } } });
  assert.equal(result.accepted, true);
  assert.equal(result.snapshot.hash, first.hash);
  assert.equal(result.snapshot.generation, first.generation);
  const changed = policy.reload({ user: { scheduler: { maxQueuedTasks: 9 } } });
  assert.equal(changed.accepted, true);
  assert.equal(changed.snapshot.generation, first.generation + 1);
  assert.notEqual(changed.snapshot.hash, first.hash);
});

test("invalid reload retains the last valid effective policy", () => {
  const policy = new ConfigPolicy({
    user: { scheduler: { maxActiveAgents: 4 } },
  });
  const before = policy.snapshot;
  const result = policy.reload({ user: { scheduler: { maxActiveAgents: 0 } } });
  assert.equal(result.accepted, false);
  assert.equal(result.snapshot.hash, before.hash);
  assert.equal(result.snapshot.generation, before.generation);
  assert.equal(policy.snapshot.config.scheduler.maxActiveAgents, 4);
});

test("unknown fields, secret values, and arbitrary environment are rejected", () => {
  assert.throws(
    () => effectiveConfig({ user: { scheduler: { command: 1 } } as never }),
    /Unknown configuration field/,
  );
  assert.throws(
    () =>
      effectiveConfig({
        user: { logging: { level: "Bearer secret" } } as never,
      }),
    /Secret-like|invalid/,
  );
  assert.deepEqual(
    allowedEnvironmentOverrides({ PI_HERDR_ORCH_LOG_LEVEL: "warn" }),
    { logLevel: "warn" },
  );
  assert.throws(
    () => allowedEnvironmentOverrides({ PI_HERDR_ORCH_UNSAFE: "1" }),
    /Unsupported/,
  );
});

test("trusted project config path rejects symlink and writable paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-m7-config-"));
  const configDir = join(root, ".pi", "orchestrator");
  const configPath = join(configDir, "config.json");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG), { mode: 0o600 });
  await assertTrustedProjectConfigPath(root, configPath);
  await chmod(configPath, 0o602);
  await assert.rejects(
    () => assertTrustedProjectConfigPath(root, configPath),
    /unsafe/,
  );
  const linkRoot = `${root}-link`;
  await symlink(root, linkRoot);
  await assert.rejects(
    () =>
      assertTrustedProjectConfigPath(
        linkRoot,
        join(linkRoot, ".pi", "orchestrator", "config.json"),
      ),
    /unsafe|outside/,
  );
});
