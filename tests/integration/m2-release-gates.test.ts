import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createManagedToken,
  createManagedTokenFile,
  verifyManagedTokenFile,
  retainManagedFileForCleanup,
} from "../../src/herdr/token-files.js";
import {
  projectCapabilities,
  CapabilityCache,
} from "../../src/herdr/capabilities.js";
import { reconcileAgents } from "../../src/herdr/reconciler.js";
import {
  NdjsonDecoder,
  encodeFrame,
  ProtocolError,
} from "../../src/shared/protocol/codec.js";
import { emptyState, reduce } from "../../src/state/reducer.js";
import { createId } from "../../src/shared/ids.js";
import { parsePorcelainV2 } from "../../src/git/porcelain.js";
import {
  HerdrProcessRunner,
  HerdrProcessError,
} from "../../src/herdr/runner.js";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";

const agentId = () => createId("agt");
const modelValidator = { validate: async () => undefined };

test("managed token file is owner-only and verifies by digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-token-"));
  const token = createManagedToken();
  const path = await createManagedTokenFile(root, agentId(), token);
  assert.equal(await verifyManagedTokenFile(path, token.digest), true);
  assert.equal(await verifyManagedTokenFile(path, "0".repeat(64)), false);
  assert.equal((await readFile(path, "utf8")).trim(), token.token);
});
test("token verification rejects replacement text", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-token-replace-"));
  const token = createManagedToken();
  const path = await createManagedTokenFile(root, agentId(), token);
  await writeFile(path, "wrong\n");
  assert.equal(await verifyManagedTokenFile(path, token.digest), false);
});
test("token cleanup retains claimed bytes and rejects replacements", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-token-clean-"));
  const token = createManagedToken();
  const path = await createManagedTokenFile(root, agentId(), token);
  const saved = join(root, "saved");
  await rename(path, saved);
  await writeFile(path, "replacement\n");
  await retainManagedFileForCleanup(path);
  assert.equal(await readFile(path, "utf8"), "replacement\n");
  assert.equal(await readFile(saved, "utf8"), token.token + "\n");
  await rename(path, join(root, "replacement-saved"));
  await rename(saved, path);
  assert.equal(await retainManagedFileForCleanup(path), "retained");
  assert.equal(await readFile(path, "utf8"), token.token + "\n");
  const target = join(root, "sentinel");
  await writeFile(target, "keep\n");
  await symlink(target, path + ".link");
  await assert.rejects(
    () => retainManagedFileForCleanup(path + ".link"),
    /ELOOP|symbolic/,
  );
  assert.equal(await readFile(target, "utf8"), "keep\n");
  assert.equal(await retainManagedFileForCleanup(path), "retained");
  assert.equal(await readFile(path, "utf8"), token.token + "\n");
});

test("token cleanup is idempotent for a missing path", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-token-clean-missing-"));
  const path = join(root, "missing");
  assert.equal(await retainManagedFileForCleanup(path), "missing");
  assert.equal(await retainManagedFileForCleanup(path), "missing");
  assert.deepEqual(await readdir(root), []);
});
test("registration retention inventory is redacted and bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-retention-budget-"));
  for (let i = 0; i < 127; i += 1)
    await writeFile(join(root, `.prompt-${i}`), "retained\n", { mode: 0o600 });
  const provisioner = new HerdrProvisioner(
    {} as never,
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    modelValidator,
  );
  const status = await provisioner.registrationRetentionStatus();
  assert.equal(status.files, 127);
  assert.equal(status.unsafeFiles, 0);
  assert.equal(status.maxFiles, 128);
  assert.equal(JSON.stringify(status).includes(".prompt-"), false);
  await assert.rejects(
    () =>
      provisioner.provision({
        agentId: "agent",
        parentAgentId: "parent",
        role: "worker",
        workspaceId: "workspace",
        cwd: root,
        profileId: "profile",
        isolation: "shared-readonly",
        prompt: "new prompt",
      }),
    /HERDR_REGISTRATION_RETENTION_BUDGET_EXCEEDED/,
  );
});

test("registration retention admission serializes concurrent provisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-retention-concurrent-"));
  let sequence = 0;
  const cli = {
    createTab: async () => {
      sequence += 1;
      return { tab_id: `tab-${sequence}`, root_pane_id: `pane-${sequence}` };
    },
    startPi: async (input: { paneId: string }) => ({ pane_id: input.paneId }),
  } as never;
  const provisioner = new HerdrProvisioner(
    cli,
    root,
    () => [],
    true,
    undefined,
    undefined,
    modelValidator,
  );
  const aliasRoot = `${root}-alias`;
  await symlink(root, aliasRoot);
  const aliasProvisioner = new HerdrProvisioner(
    cli,
    aliasRoot,
    () => [],
    true,
    undefined,
    undefined,
    modelValidator,
  );
  const attempts = await Promise.allSettled(
    Array.from({ length: 65 }, (_, index) =>
      (index % 2 === 0 ? provisioner : aliasProvisioner).provision({
        agentId: `agent-${index}`,
        parentAgentId: "parent",
        role: "worker",
        workspaceId: "workspace",
        cwd: root,
        profileId: "profile",
        isolation: "shared-readonly",
        prompt: "bounded prompt",
      }),
    ),
  );
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    64,
  );
  assert.equal(
    attempts.filter((result) => result.status === "rejected").length,
    1,
  );
  const status = await provisioner.registrationRetentionStatus();
  assert.equal(status.files, 128);
  assert.equal(status.files <= status.maxFiles, true);
});

test("registration retention age and unsafe files fail provisioning closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-retention-age-"));
  const old = join(root, ".prompt-old");
  await writeFile(old, "retained\n", { mode: 0o600 });
  const expired = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  await utimes(old, expired, expired);
  const provisioner = new HerdrProvisioner(
    {} as never,
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    modelValidator,
  );
  await assert.rejects(
    () =>
      provisioner.provision({
        agentId: "agent",
        parentAgentId: "parent",
        role: "worker",
        workspaceId: "workspace",
        cwd: root,
        profileId: "profile",
        isolation: "shared-readonly",
        prompt: "new prompt",
      }),
    /HERDR_REGISTRATION_RETENTION_EXPIRED/,
  );
  await symlink(old, join(root, ".token-unsafe"));
  await writeFile(join(root, ".unexpected"), "unexpected\n", { mode: 0o600 });
  assert.equal(
    (await provisioner.registrationRetentionStatus()).unsafeFiles,
    2,
  );
});

test("capability projection fails closed for schema drift", () => {
  const caps = projectCapabilities({ methods: ["session.snapshot"] }, "fake-1");
  assert.equal(caps.supports("events.subscribe"), false);
  assert.throws(() => caps.require(["events.subscribe"]), /CAPABILITY_MISSING/);
});
test("capability cache is keyed by binary, schema, and adapter", () => {
  const cache = new CapabilityCache();
  const caps = projectCapabilities({ methods: [] });
  cache.set(
    { binaryIdentity: "a", schemaHash: "b", adapterIdentity: "c" },
    caps,
  );
  assert.equal(
    cache.get({ binaryIdentity: "a", schemaHash: "b", adapterIdentity: "c" }),
    caps,
  );
  assert.equal(
    cache.get({ binaryIdentity: "a", schemaHash: "b", adapterIdentity: "d" }),
    undefined,
  );
});
test("reconciliation classifies missing and empty panes as distinct", () => {
  const id = agentId();
  const results = reconcileAgents(
    [{ id, state: "idle", generation: 1, paneId: "p1" }],
    {
      panes: [{ id: "p1" }],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    },
  );
  assert.equal(results[0]?.kind, "orphaned");
  const missing = reconcileAgents(
    [{ id, state: "idle", generation: 1, paneId: "p2" }],
    { panes: [], tabs: [], workspaces: [], agents: [], worktrees: [] },
  );
  assert.equal(missing[0]?.kind, "missing");
});
test("reconciliation detects replacement by terminal identity", () => {
  const id = agentId();
  const results = reconcileAgents(
    [{ id, state: "idle", generation: 1, paneId: "p1", terminalId: "t1" }],
    {
      panes: [{ id: "p1", terminalId: "t2", occupant: { terminalId: "t2" } }],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    },
  );
  assert.equal(results[0]?.kind, "replaced");
});
test("NDJSON rejects invalid UTF-8 and continues after oversized line", () => {
  const decoder = new NdjsonDecoder(
    (value) => value as Record<string, unknown>,
  );
  assert.equal(decoder.push(Buffer.from([0xff, 0x0a]))[0]?.ok, false);
  const result = decoder.push(Buffer.from("{}\n"));
  assert.equal(result[0]?.ok, true);
  assert.throws(
    () => encodeFrame({ x: "x".repeat(2_000_000) }),
    (e: unknown) => e instanceof ProtocolError,
  );
});
test("state reducer records durable resource identity and deadline", () => {
  const id = agentId();
  let state = emptyState();
  state = reduce(state, {
    type: "herdr.provision.intent",
    actor: { principalId: "system", kind: "system" },
    entityRefs: { agentId: id },
    payload: { agentId: id },
  });
  state = reduce(state, {
    type: "herdr.provision.outcome",
    actor: { principalId: "system", kind: "system" },
    entityRefs: { agentId: id },
    payload: {
      agentId: id,
      state: "pending",
      paneId: "p",
      generation: 2,
      tokenDigest: "d",
      registrationDeadline: "2026-01-01T00:00:00Z",
      orphaned: false,
    },
  });
  assert.equal(state.herdrResources?.[id]?.generation, 2);
  assert.equal(
    state.herdrResources?.[id]?.registrationDeadline,
    "2026-01-01T00:00:00Z",
  );
});
test("porcelain parser handles NUL-safe rename names", () => {
  const result = parsePorcelainV2(
    Buffer.from(
      "2 R. N... 100644 100644 100644 abc def R100\tnew name\0old name\0",
      "utf8",
    ),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.path, "new name");
});
test("process runner rejects caller environment overrides", async () => {
  const runner = new HerdrProcessRunner({
    binary: "/bin/true",
    env: { SECRET: "no" },
  });
  assert.throws(
    () => runner.run([]),
    (e: unknown) =>
      e instanceof HerdrProcessError && e.code === "HERDR_COMMAND_FAILED",
  );
});
test("process runner rejects missing executable without shell fallback", async () => {
  const runner = new HerdrProcessRunner({ binary: "/no/such/herdr" });
  await assert.rejects(
    runner.run([]),
    (e: unknown) =>
      e instanceof HerdrProcessError && e.code === "HERDR_UNAVAILABLE",
  );
});
test("process runner rejects invalid timeout bounds", async () => {
  const runner = new HerdrProcessRunner({ binary: "/bin/true", timeoutMs: 1 });
  await assert.rejects(runner.run([]), /3001-300000/);
});
test("managed files do not expose token in a directory listing name", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-private-"));
  const token = createManagedToken();
  const path = await createManagedTokenFile(root, "agent", token);
  assert.match(path, /\.token-agent-/);
  assert.doesNotMatch(path, new RegExp(token.token));
});
