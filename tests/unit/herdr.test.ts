import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  HerdrApi,
  HerdrApiError,
  schemaSupportsMethod,
  type HerdrCommandResult,
} from "../../src/herdr/api.js";
import {
  parseHerdrPluginContext,
  resolveTargetPane,
  type HerdrAgentInfo,
} from "../../src/herdr/context.js";

const agents: HerdrAgentInfo[] = [
  {
    terminalId: "t1",
    paneId: "pane-a",
    agent: "pi",
    name: "alpha",
    focused: true,
    cwd: "/a",
  },
  {
    terminalId: "t2",
    paneId: "pane-b",
    displayAgent: "Pi",
    name: "beta",
    focused: false,
    cwd: "/b",
  },
  {
    terminalId: "t3",
    paneId: "pane-c",
    agent: "codex",
    name: "gamma",
    focused: false,
  },
];

test("Herdr schema gating detects supported methods and mocked removals", async () => {
  const schema = JSON.parse(
    await readFile(
      join(process.cwd(), "tests", "fixtures", "herdr-schema-0.8.0.min.json"),
      "utf8",
    ),
  );
  assert.equal(schemaSupportsMethod(schema, "agent.list"), true);
  assert.equal(schemaSupportsMethod(schema, "agent.focus"), true);
  assert.equal(schemaSupportsMethod(schema, "pane.send_keys"), false);
  assert.equal(
    schemaSupportsMethod({ description: "agent.list" }, "agent.list"),
    false,
  );
  assert.equal(
    schemaSupportsMethod(
      { properties: { method: { enum: ["agent.list"] } } },
      "agent.list",
    ),
    true,
  );
  const calls: string[][] = [];
  const api = new HerdrApi({
    runner: async (argv) => {
      calls.push([...argv]);
      return argv[0] === "api"
        ? {
            stdout: JSON.stringify({
              oneOf: [{ properties: { method: { const: "agent.list" } } }],
            }),
            stderr: "",
            exitCode: 0,
          }
        : {
            stdout: JSON.stringify({ result: { agents: [] } }),
            stderr: "",
            exitCode: 0,
          };
    },
  });
  await api.readSchema();
  await assert.rejects(
    api.focusPane("pane-a"),
    (error: unknown) =>
      error instanceof HerdrApiError && error.code === "unsupported_api",
  );
  assert.deepEqual(calls, [["api", "schema", "--json"]]);
});

test("Herdr API uses argv CLI wrappers and parses agent.list response", async () => {
  const calls: string[][] = [];
  const runner = async (
    argv: readonly string[],
  ): Promise<HerdrCommandResult> => {
    calls.push([...argv]);
    if (argv[0] === "api") {
      return {
        stdout: JSON.stringify({ methods: ["agent.list", "agent.focus"] }),
        stderr: "",
        exitCode: 0,
      };
    }
    if (argv[0] === "agent") {
      return {
        stdout: JSON.stringify({
          result: {
            agents: [
              {
                terminal_id: "t1",
                pane_id: "pane-a",
                agent: "pi",
                agent_status: "idle",
                focused: true,
                foreground_cwd: "/a",
              },
            ],
          },
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    return {
      stdout: JSON.stringify({ result: { ok: true } }),
      stderr: "",
      exitCode: 0,
    };
  };
  const api = new HerdrApi({ runner });
  await api.readSchema();
  const listed = await api.listAgents();
  assert.deepEqual(listed, [
    {
      terminalId: "t1",
      paneId: "pane-a",
      agent: "pi",
      status: "idle",
      cwd: "/a",
      focused: true,
    },
  ]);
  await api.focusPane("pane-a");
  assert.deepEqual(calls, [
    ["api", "schema", "--json"],
    ["agent", "list"],
    ["agent", "focus", "pane-a"],
  ]);
});

test("target resolution accepts the exact Herdr 0.8.2 plugin pane context", () => {
  const context = parseHerdrPluginContext(
    JSON.stringify({
      workspace_id: "w54",
      workspace_label: "unified-ui-accept",
      workspace_cwd: "/home/mainpc/Projects/my-shtty-pi-herdr-deck",
      tab_id: "w54:t1",
      tab_label: "1",
      focused_pane_id: "w54:p1",
      focused_pane_cwd: "/home/mainpc/Projects/my-shtty-pi-herdr-deck",
      focused_pane_agent: "pi",
      focused_pane_status: "done",
      invocation_source: "api",
      correlation_id: "plugin-pane",
    }),
    "w54:p2",
  );
  assert.deepEqual(context.targetPaneCandidates, ["w54:p1"]);
  const resolution = resolveTargetPane(context, [
    {
      terminalId: "term-pi",
      paneId: "w54:p1",
      agent: "pi",
      status: "done",
      focused: true,
    },
  ]);
  assert.equal(resolution.kind, "resolved");
  if (resolution.kind === "resolved") assert.equal(resolution.paneId, "w54:p1");
});

test("target resolution honors one context target and never chooses arbitrarily", () => {
  const selected = parseHerdrPluginContext(
    JSON.stringify({ invocation: { target_pane_id: "pane-b" } }),
    "deck-pane",
  );
  assert.deepEqual(selected.targetPaneCandidates, ["pane-b"]);
  const resolution = resolveTargetPane(selected, agents);
  assert.equal(resolution.kind, "resolved");
  if (resolution.kind === "resolved") {
    assert.equal(resolution.paneId, "pane-b");
    assert.equal(resolution.source, "context");
  }

  const ambiguous = resolveTargetPane(
    parseHerdrPluginContext("{}", "deck-pane"),
    agents,
  );
  assert.equal(ambiguous.kind, "picker");
  if (ambiguous.kind === "picker")
    assert.deepEqual(
      ambiguous.agents.map((agent) => agent.paneId),
      ["pane-a", "pane-b"],
    );
});

test("Herdr detection labels override misleading human-assigned pane names", () => {
  const context = parseHerdrPluginContext("{}", "deck-pane");
  const resolution = resolveTargetPane(context, [
    {
      terminalId: "t-codex",
      paneId: "pane-codex",
      agent: "codex",
      name: "pi",
      focused: false,
    },
    {
      terminalId: "t-pi",
      paneId: "pane-pi",
      agent: "pi",
      name: "worker",
      focused: false,
    },
  ]);
  assert.equal(resolution.kind, "picker");
  if (resolution.kind === "picker")
    assert.deepEqual(
      resolution.agents.map((agent) => agent.paneId),
      ["pane-pi"],
    );
});

test("Herdr CLI failures do not disclose output or argv details", async () => {
  const api = new HerdrApi({
    runner: async () => ({
      stdout: "SECRET_STDOUT",
      stderr: "SECRET_STDERR",
      exitCode: 2,
    }),
  });
  await assert.rejects(api.readSchema(), (error: unknown) => {
    assert.ok(error instanceof HerdrApiError);
    assert.equal(error.code, "cli_failed");
    assert.equal(error.message.includes("SECRET"), false);
    assert.equal(error.message.includes("api schema"), true);
    return true;
  });
});

test("target resolution shows a picker even for one discovered Pi pane and reports none", () => {
  const context = parseHerdrPluginContext("{}", "deck-pane");
  const one = resolveTargetPane(context, [agents[0]!, agents[2]!]);
  assert.equal(one.kind, "picker");
  if (one.kind === "picker")
    assert.deepEqual(
      one.agents.map((agent) => agent.paneId),
      ["pane-a"],
    );
  const none = resolveTargetPane(context, [agents[2]!]);
  assert.equal(none.kind, "missing");
});
