import type { Component, ProcessTerminal as ProcessTerminalType, TUI as TuiType } from "@pi-herdr-deck/tui";
import { BridgeClient } from "../bridge/client.js";
import { hasComponentMouseApi, PI_COMPATIBILITY_MESSAGE } from "../bridge/capabilities.js";
import { socketLocationForPane } from "../bridge/server.js";
import { HerdrApi } from "../herdr/api.js";
import { parseHerdrPluginContext, resolveTargetPane, type HerdrAgentInfo } from "../herdr/context.js";
import { DeckApp } from "./app.js";
import { PanePicker } from "./components/picker.js";

interface TuiRuntimeModule {
  TUI: new (terminal: ProcessTerminalType, showHardwareCursor?: boolean) => TuiType;
  ProcessTerminal: new () => ProcessTerminalType;
  parseMouseInput(data: string): unknown;
}

function conciseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function selectAgent(
  tui: TuiType,
  agents: HerdrAgentInfo[],
  reason: string,
  requestRender: () => void,
): Promise<HerdrAgentInfo | undefined> {
  return await new Promise<HerdrAgentInfo | undefined>((resolve) => {
    let settled = false;
    const finish = (agent: HerdrAgentInfo | undefined): void => {
      if (settled) return;
      settled = true;
      tui.removeChild(picker);
      resolve(agent);
    };
    const picker = new PanePicker({
      agents,
      reason,
      onSelect: (agent) => finish(agent),
      onCancel: () => finish(undefined),
      requestRender,
    });
    tui.addChild(picker);
    tui.setFocus(picker);
    requestRender();
  });
}

export async function main(): Promise<void> {
  if (process.platform !== "linux") {
    console.error("pi-herdr-deck version 0.1.0 supports Linux only.");
    process.exitCode = 1;
    return;
  }
  let imported: unknown;
  for (const specifier of ["@earendil-works/pi-tui", "@pi-herdr-deck/tui"] as const) {
    try {
      const candidate: unknown = await import(specifier);
      if (hasComponentMouseApi(candidate)) {
        imported = candidate;
        break;
      }
    } catch {
      // Try the exact-version standalone fallback after an unavailable host peer.
    }
  }
  if (!imported) {
    console.error(PI_COMPATIBILITY_MESSAGE);
    process.exitCode = 2;
    return;
  }
  const tuiModule = imported as TuiRuntimeModule;
  const terminal = new tuiModule.ProcessTerminal();
  const tui = new tuiModule.TUI(terminal, true);
  terminal.setTitle("Pi Deck");
  tui.start();
  tui.setMouseTracking(true);
  const requestRender = (): void => tui.requestRender();

  let app: DeckApp | undefined;
  let client: BridgeClient | undefined;
  const shutdown = (): void => {
    app?.dispose();
    client?.stop("Deck closed.");
    tui.setMouseTracking(false);
    tui.stop();
  };

  try {
    const herdr = new HerdrApi(process.env.HERDR_BIN_PATH ? { binaryPath: process.env.HERDR_BIN_PATH } : {});
    await herdr.readSchema();
    herdr.requireMethods(["agent.list", "agent.focus"]);
    const context = parseHerdrPluginContext(process.env.HERDR_PLUGIN_CONTEXT_JSON, process.env.HERDR_PANE_ID);
    const agents = await herdr.listAgents();
    const resolution = resolveTargetPane(context, agents);
    let target: HerdrAgentInfo | undefined;
    if (resolution.kind === "resolved") target = resolution.agent;
    else if (resolution.kind === "picker") target = await selectAgent(tui, resolution.agents, resolution.reason, requestRender);
    else throw new Error(resolution.reason);
    if (!target) {
      process.exitCode = 1;
      return;
    }
    const socketPath = socketLocationForPane(target.paneId).socketPath;
    client = new BridgeClient({
      socketPath,
      log: (message) => process.stderr.write(`pi-herdr-deck: ${message}\n`),
    });
    app = new DeckApp({
      client,
      herdr,
      targetPaneId: target.paneId,
      requestRender,
      getHeight: () => terminal.rows,
    });
    tui.addChild(app as Component);
    tui.setFocus(app as Component);
    client.start();
    requestRender();
    await new Promise<void>((resolve) => {
      const finish = (): void => resolve();
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      process.once("SIGHUP", finish);
    });
  } catch (error) {
    process.stderr.write(`Pi Deck: ${conciseError(error)}\n`);
    process.exitCode = 1;
  } finally {
    shutdown();
  }
}
