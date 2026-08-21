import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  modelSelectionMatches,
  resolveSpawnPolicy,
  validateModelSelection,
  type ModelSelection,
} from "../../src/broker/model-policy.js";
import {
  InstalledPiCapabilities,
  parsePiCapabilities,
} from "../../src/pi/model-capabilities.js";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";
import type { HerdrCli } from "../../src/herdr/cli.js";
import { validateConfig } from "../../src/ops/config.js";
import { EventStore } from "../../src/state/event-store.js";
import { HerdrService } from "../../src/herdr/service.js";

const luna: ModelSelection = {
  provider: "openai-codex",
  modelId: "gpt-5.6-luna",
  thinkingLevel: "medium",
};
const sol: ModelSelection = {
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "medium",
};

const piHelp =
  "  --thinking <level> Set thinking level: off, minimal, low, medium, high, xhigh, max\n";
const piModels = `provider model context max-out thinking images
openai-codex gpt-5.6-luna 272K 128K yes yes
openai-codex gpt-5.6-sol 272K 128K yes yes
`;

test("model policy defaults task agents to visible current-workspace Luna", () => {
  const resolved = resolveSpawnPolicy({ taskProfileId: "reviewer" });
  assert.deepEqual(resolved.requested, {});
  assert.deepEqual(resolved.effective, {
    placement: "current-workspace",
    modelProfileId: "subagent",
    model: luna,
  });
  assert.match(resolved.policyHash, /^[0-9a-f]{64}$/u);
});

test("scoped model defaults use task, project, role, then global precedence", () => {
  const global = { ...luna, thinkingLevel: "low" as const };
  const role = { ...luna, thinkingLevel: "high" as const };
  const project = { ...sol, thinkingLevel: "xhigh" as const };
  const explicit = { ...sol, thinkingLevel: "max" as const };
  const config = {
    defaults: {
      global,
      roles: { implementer: role },
      projects: { "/project": project },
    },
    allowlist: [global, role, project, explicit],
  };
  assert.deepEqual(
    resolveSpawnPolicy({ taskProfileId: "scout" }, config).effective.model,
    global,
  );
  assert.deepEqual(
    resolveSpawnPolicy({ taskProfileId: "implementer" }, config).effective
      .model,
    role,
  );
  assert.deepEqual(
    resolveSpawnPolicy(
      { taskProfileId: "implementer", projectKey: "/project" },
      config,
    ).effective.model,
    project,
  );
  assert.deepEqual(
    resolveSpawnPolicy(
      { taskProfileId: "implementer", projectKey: "/project", model: explicit },
      config,
    ).effective.model,
    explicit,
  );
});

test("model policy assigns dedicated workspace agents to Sol", () => {
  const resolved = resolveSpawnPolicy({
    taskProfileId: "implementer",
    placement: "new-workspace",
    modelProfileId: "manager",
  });
  assert.deepEqual(resolved.requested, {
    placement: "new-workspace",
    modelProfileId: "manager",
  });
  assert.deepEqual(resolved.effective.model, sol);
  assert.throws(
    () =>
      resolveSpawnPolicy({
        taskProfileId: "reviewer",
        placement: "current-workspace",
        modelProfileId: "manager",
      }),
    /not compatible/u,
  );
});

test("model policy enforces optional task compatibility and the allowlist", () => {
  assert.throws(
    () =>
      resolveSpawnPolicy(
        { taskProfileId: "custom", placement: "new-workspace" },
        { compatibility: { custom: ["subagent"] } },
      ),
    /not compatible/u,
  );
  assert.throws(
    () =>
      resolveSpawnPolicy({ taskProfileId: "reviewer" }, { allowlist: [sol] }),
    /allowlist/u,
  );
  assert.deepEqual(validateModelSelection({ ...sol, thinkingLevel: "max" }), {
    ...sol,
    thinkingLevel: "max",
  });
  assert.throws(
    () => validateModelSelection({ ...sol, thinkingLevel: "extreme" }),
    /invalid/u,
  );
});

test("installed Pi capability parser validates exact available model and thinking", async () => {
  const parsed = parsePiCapabilities(piHelp, piModels);
  assert.equal(parsed.models.length, 2);
  const calls: string[][] = [];
  const capabilities = new InstalledPiCapabilities("pi", async (argv) => {
    calls.push([...argv]);
    return {
      status: 0,
      stdout: argv.includes("--help") ? piHelp : piModels,
    };
  });
  await capabilities.validate(luna);
  await assert.rejects(
    () => capabilities.validate({ ...luna, modelId: "missing" }),
    /PI_MODEL_UNAVAILABLE/u,
  );
  assert.deepEqual(calls, [["--help"], ["--list-models"]]);
});

test("model validation occurs before any registration or Herdr resource", async () => {
  const parent = await mkdtemp(join(tmpdir(), "model-preflight-"));
  const root = join(parent, "not-created");
  let herdrCalls = 0;
  const cli = new Proxy(
    {},
    {
      get: () => () => {
        herdrCalls++;
        throw new Error("HERDR_MUST_NOT_RUN");
      },
    },
  ) as HerdrCli;
  const provisioner = new HerdrProvisioner(
    cli,
    root,
    () => [],
    true,
    undefined,
    undefined,
    {
      validate: async () => {
        throw new Error("PI_MODEL_UNAVAILABLE");
      },
    },
  );
  try {
    await assert.rejects(
      () =>
        provisioner.provision({
          agentId: "agt_preflight",
          parentAgentId: "agt_parent",
          role: "reviewer",
          workspaceId: "w1",
          cwd: parent,
          profileId: "reviewer",
          isolation: "shared-readonly",
          placement: "current-workspace",
          model: luna,
          prompt: "Review.",
        }),
      /PI_MODEL_UNAVAILABLE/u,
    );
    await assert.rejects(access(root));
    assert.equal(herdrCalls, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("task agent starts in a current-workspace tab with explicit model arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-current-"));
  let startArgs: readonly string[] = [];
  let validated = false;
  let tabWorkspace = "";
  const cli = {
    createTab: async (input: { workspaceId: string }) => {
      tabWorkspace = input.workspaceId;
      return { tab_id: "tab1", root_pane_id: "pane1" };
    },
    startPi: async (input: { args: readonly string[] }) => {
      startArgs = input.args;
      return { pane_id: "pane1" };
    },
  } as unknown as HerdrCli;
  const provisioner = new HerdrProvisioner(
    cli,
    root,
    () => [],
    true,
    undefined,
    undefined,
    {
      validate: async (model) => {
        validated = model === luna;
      },
    },
  );
  try {
    const result = await provisioner.provision({
      agentId: "agt_current",
      parentAgentId: "agt_parent",
      role: "reviewer",
      workspaceId: "w1",
      cwd: root,
      profileId: "reviewer",
      isolation: "shared-readonly",
      placement: "current-workspace",
      model: luna,
      prompt: "Review.",
    });
    assert.equal(validated, true);
    assert.equal(tabWorkspace, "w1");
    assert.deepEqual(startArgs.slice(2, 10), [
      "--provider",
      "openai-codex",
      "--model",
      "openai-codex/gpt-5.6-luna",
      "--thinking",
      "medium",
      "--append-system-prompt",
      result.promptPath,
    ]);
    assert.deepEqual(result.model, luna);
    assert.equal(result.placement, "current-workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace agent creates a visible new workspace before explicit Sol start", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-workspace-"));
  const calls: string[] = [];
  const cli = {
    createWorkspace: async () => {
      calls.push("workspace");
      return {
        workspace: { workspace_id: "w2" },
        tab: { tab_id: "tab2" },
        root_pane: { pane_id: "pane2" },
      };
    },
    startPi: async (input: { args: readonly string[] }) => {
      calls.push("start");
      assert.ok(input.args.includes("openai-codex/gpt-5.6-sol"));
      return { pane_id: "pane2" };
    },
  } as unknown as HerdrCli;
  const provisioner = new HerdrProvisioner(
    cli,
    root,
    () => [],
    true,
    undefined,
    undefined,
    { validate: async () => undefined },
  );
  try {
    const result = await provisioner.provision({
      agentId: "agt_workspace",
      parentAgentId: "agt_parent",
      role: "reviewer",
      workspaceId: "w1",
      cwd: root,
      profileId: "reviewer",
      isolation: "shared-readonly",
      placement: "new-workspace",
      model: sol,
      prompt: "Lead.",
    });
    assert.deepEqual(calls, ["workspace", "start"]);
    assert.equal(result.workspaceId, "w2");
    assert.equal(result.createdWorkspace, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registration mismatch compensates pending visible resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-mismatch-"));
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  let compensated = 0;
  let cleaned = 0;
  const result = {
    name: "reviewer-1",
    paneId: "pane-1",
    tabId: "tab-1",
    workspaceId: "workspace-1",
    createdWorkspace: true,
    token: { token: "private", digest: "a".repeat(64) },
    tokenFilePath: join(root, ".token-test"),
  };
  const provisioner = {
    provision: async () => result,
    compensate: async () => {
      compensated++;
    },
    cleanupRegistration: async () => {
      cleaned++;
    },
  };
  const service = new HerdrService({
    store,
    cli: { requireMutationCapabilities: () => undefined } as never,
    provisioner: provisioner as never,
  });
  try {
    await service.provision({
      agentId: "agt_mismatch",
      parentAgentId: "agt_parent",
      role: "reviewer",
      workspaceId: "workspace-1",
      cwd: root,
      profileId: "reviewer",
      isolation: "shared-readonly",
      placement: "new-workspace",
      model: sol,
      prompt: "Review.",
    });
    await service.recordRegistrationMismatch("agt_mismatch");
    assert.equal(compensated, 1);
    assert.equal(cleaned, 1);
    assert.equal(store.state.herdrResources?.agt_mismatch?.state, "replaced");
    assert.equal(
      store.state.herdrResources?.agt_mismatch?.cleanupOutcome,
      "registration_mismatch_compensated",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requested effective and actual model matching is exact", () => {
  assert.equal(
    modelSelectionMatches(luna, {
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      thinkingLevel: "medium",
    }),
    true,
  );
  assert.equal(
    modelSelectionMatches(luna, {
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "medium",
    }),
    false,
  );
});

test("broker model configuration validates controlled overrides", () => {
  const config = validateConfig({
    version: 1,
    modelPolicy: {
      profiles: { subagent: luna, manager: sol },
      allowlist: [luna, sol],
      compatibility: { reviewer: ["subagent"] },
    },
  });
  assert.deepEqual(config.modelPolicy?.profiles?.subagent, luna);
  assert.deepEqual(
    validateConfig({
      version: 1,
      modelPolicy: { defaults: { global: { ...sol, thinkingLevel: "max" } } },
    }).modelPolicy?.defaults?.global,
    { ...sol, thinkingLevel: "max" },
  );
  assert.throws(
    () =>
      validateConfig({
        version: 1,
        modelPolicy: {
          defaults: { global: { ...sol, thinkingLevel: "extreme" } },
        },
      }),
    /invalid/u,
  );
});
