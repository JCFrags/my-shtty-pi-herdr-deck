import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectCapabilities } from "../../src/herdr/capabilities.js";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";
import {
  HerdrService,
  runProductionPreflight,
} from "../../src/herdr/service.js";
import { EventStore } from "../../src/state/event-store.js";

const methods = [
  "session.snapshot",
  "events.subscribe",
  "workspace.list",
  "workspace.get",
  "workspace.focus",
  "workspace.close",
  "tab.create",
  "tab.get",
  "tab.close",
  "pane.list",
  "pane.get",
  "pane.focus",
  "pane.close",
  "agent.list",
  "agent.get",
  "agent.start",
  "agent.focus",
  "worktree.list",
  "worktree.create",
  "worktree.open",
  "worktree.remove",
];
const cases = [
  "absent-socket",
  "wrong-socket",
  "missing-adapter",
  "wrong-adapter",
  "schema-drift",
  "cache-identity",
  "binary-identity",
  "lock-failure",
  "config-failure",
  "profile-failure",
  "stale-resource",
] as const;

test("M2 actual production preflight failures cause zero Herdr or Git mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-preflight-"));
  const socketPath = join(root, "herdr.sock");
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const validSchema = { methods };
  const expectedHash = projectCapabilities(validSchema, "/bin/true").schemaHash;
  const previous = {
    lock: process.env.PI_HERDR_ORCH_BROKER_LOCK,
    config: process.env.PI_HERDR_ORCH_CONFIG_PATH,
    profile: process.env.PI_HERDR_ORCH_PROFILE_ID,
  };
  process.env.PI_HERDR_ORCH_BROKER_LOCK = "test-lock";
  process.env.PI_HERDR_ORCH_CONFIG_PATH = "test-config";
  process.env.PI_HERDR_ORCH_PROFILE_ID = "test-profile";
  try {
    for (const failure of cases) {
      let mutations = 0;
      let schema: unknown = validSchema;
      const runner = { json: async () => schema } as never;
      let adapter = "pi-herdr-orchestrator";
      let expected = expectedHash;
      let binaryIdentity = "/bin/true";
      let expectedBinary = "/bin/true";
      let stale = true;
      let socket = socketPath;
      if (failure === "absent-socket" || failure === "wrong-socket")
        socket = join(root, `${failure}.sock`);
      if (failure === "missing-adapter") adapter = undefined as never;
      if (failure === "wrong-adapter") adapter = "other-adapter";
      if (failure === "schema-drift")
        schema = { methods: ["session.snapshot"] };
      if (failure === "cache-identity") expected = "0".repeat(64);
      if (failure === "binary-identity") expectedBinary = "/expected/herdr";
      if (failure === "lock-failure")
        delete process.env.PI_HERDR_ORCH_BROKER_LOCK;
      if (failure === "config-failure")
        delete process.env.PI_HERDR_ORCH_CONFIG_PATH;
      if (failure === "profile-failure")
        delete process.env.PI_HERDR_ORCH_PROFILE_ID;
      if (failure === "stale-resource") stale = false;
      const cli = {
        requireMutationCapabilities: () => {
          mutations++;
        },
        createTab: async () => {
          mutations++;
          return { tab_id: "tab", root_pane_id: "pane" };
        },
        startPi: async () => {
          mutations++;
          return { pane_id: "pane" };
        },
        snapshot: async () => {
          mutations++;
          return {
            panes: [],
            tabs: [],
            workspaces: [],
            agents: [],
            worktrees: [],
          };
        },
      } as never;
      const store = new EventStore(join(root, `${failure}.events.ndjson`));
      await store.open();
      const service = new HerdrService({
        store,
        cli,
        provisioner: new HerdrProvisioner(cli, join(root, "prompts")),
        preflight: () =>
          runProductionPreflight({
            runner,
            binary: "/bin/true",
            socketPath: socket,
            expectedSchemaHash: expected,
            adapterIdentity: adapter,
            expectedBinaryIdentity: expectedBinary,
            binaryIdentity,
            staleResourceCheck: async () => stale,
          }),
      });
      await assert.rejects(() =>
        service.provision({
          agentId: `agent-${failure}`,
          parentAgentId: "parent",
          role: "worker",
          workspaceId: "workspace",
          cwd: root,
          profileId: "test-runner",
          isolation: "shared-readonly",
          prompt: "preflight",
        }),
      );
      assert.equal(mutations, 0, failure);
      process.env.PI_HERDR_ORCH_BROKER_LOCK = "test-lock";
      process.env.PI_HERDR_ORCH_CONFIG_PATH = "test-config";
      process.env.PI_HERDR_ORCH_PROFILE_ID = "test-profile";
    }
  } finally {
    server.close();
    for (const [key, value] of Object.entries({
      PI_HERDR_ORCH_BROKER_LOCK: previous.lock,
      PI_HERDR_ORCH_CONFIG_PATH: previous.config,
      PI_HERDR_ORCH_PROFILE_ID: previous.profile,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
