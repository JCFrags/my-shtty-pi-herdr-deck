import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeClient } from "../../src/bridge/client.js";
import { BridgeServer } from "../../src/bridge/server.js";
import { HerdrApi } from "../../src/herdr/api.js";
import { parseHerdrPluginContext, resolveTargetPane } from "../../src/herdr/context.js";
import { FakeController, waitFor } from "../helpers.js";

test("fake Pi bridge and fake Herdr CLI smoke test requires no model API key", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-deck-integration-"));
  const logPath = join(root, "herdr-argv.jsonl");
  const cliPath = join(root, "fake-herdr.mjs");
  await writeFile(cliPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.HERDR_CONFIG, JSON.stringify(args) + "\\n");
if (args.join(" ") === "api schema --json") {
  console.log(JSON.stringify({ methods: ["agent.list", "agent.focus"] }));
} else if (args.join(" ") === "agent list") {
  console.log(JSON.stringify({ result: { agents: [
    { terminal_id: "terminal-pi", pane_id: "pi-pane", agent: "pi", display_agent: "Pi", agent_status: "working", focused: false, cwd: "/fake/project" },
    { terminal_id: "terminal-other", pane_id: "other-pane", agent: "codex", agent_status: "idle", focused: true }
  ] } }));
} else if (args[0] === "agent" && args[1] === "focus") {
  console.log(JSON.stringify({ result: { focused: args[2] } }));
} else {
  console.error("unsupported fake command", args.join(" "));
  process.exitCode = 2;
}
`);
  await chmod(cliPath, 0o755);
  const previousLog = process.env.HERDR_CONFIG;
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.HERDR_CONFIG = logPath;
  process.env.XDG_RUNTIME_DIR = root;
  delete process.env.OPENAI_API_KEY;
  const controller = new FakeController();
  controller.state = { ...controller.state, herdrPaneId: "pi-pane", activity: "working" };
  const bridge = new BridgeServer({ controller });
  try {
    const herdr = new HerdrApi({ binaryPath: cliPath });
    await herdr.readSchema();
    const agents = await herdr.listAgents();
    const context = parseHerdrPluginContext(JSON.stringify({ invocation: { target_pane_id: "pi-pane" } }), "deck-pane");
    const resolution = resolveTargetPane(context, agents);
    assert.equal(resolution.kind, "resolved");
    if (resolution.kind !== "resolved") throw new Error("target did not resolve");
    assert.equal(resolution.agent.cwd, "/fake/project");

    await bridge.start();
    const client = new BridgeClient({ socketPath: bridge.socketPath, reconnectDelaysMs: [10, 20] });
    client.start();
    await waitFor(() => client.connected && client.state?.activity === "working");
    await client.send("abort", {});
    await client.send("setToolExpanded", { toolCallId: "call-1", expanded: true });
    assert.deepEqual(controller.commands.map((command) => command.name), ["abort", "setToolExpanded"]);
    await herdr.focusPane(resolution.paneId);
    client.stop();

    const invocations = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(invocations, [
      ["api", "schema", "--json"],
      ["agent", "list"],
      ["agent", "focus", "pi-pane"],
    ]);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
  } finally {
    await bridge.close();
    if (previousLog === undefined) delete process.env.HERDR_CONFIG;
    else process.env.HERDR_CONFIG = previousLog;
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});
