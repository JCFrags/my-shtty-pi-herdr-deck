import type {
  Component,
  ProcessTerminal as ProcessTerminalType,
  TUI as TuiType,
} from "@pi-herdr-deck/tui";
import { BrokerClient } from "./broker-client.js";
import { BrokerDeckApp } from "./broker-app.js";
import { resolveBrokerContext } from "./socket.js";
import { parseHerdrPluginContext } from "../herdr/context.js";
import { installMouseRouter, type MouseRouter } from "./mouse-router.js";

interface DeckTui extends TuiType {
  setLayoutRoot(component: Component | undefined): void;
}

interface TuiRuntimeModule {
  TuiAltScreen: new (
    terminal: ProcessTerminalType,
    showHardwareCursor?: boolean,
    logDirectory?: string,
    options?: { mouse?: boolean },
  ) => DeckTui;
  ProcessTerminal: new () => ProcessTerminalType;
}

export const DECK_TUI_COMPATIBILITY_MESSAGE =
  "Agent Board requires Pi TUI with TuiAltScreen and ProcessTerminal.";

export function hasDeckTuiApi(value: unknown): value is TuiRuntimeModule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.TuiAltScreen === "function" &&
    typeof candidate.ProcessTerminal === "function"
  );
}

function conciseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function main(): Promise<void> {
  if (process.platform !== "linux") {
    console.error("pi-herdr-deck version 0.1.0 supports Linux only.");
    process.exitCode = 1;
    return;
  }
  let imported: unknown;
  for (const specifier of [
    "@earendil-works/pi-tui",
    "@pi-herdr-deck/tui",
  ] as const) {
    try {
      const candidate: unknown = await import(specifier);
      if (hasDeckTuiApi(candidate)) {
        imported = candidate;
        break;
      }
    } catch {
      // Try the exact-version standalone fallback after an unavailable host peer.
    }
  }
  if (!imported) {
    console.error(DECK_TUI_COMPATIBILITY_MESSAGE);
    process.exitCode = 2;
    return;
  }

  const tuiModule = imported as TuiRuntimeModule;
  const terminal = new tuiModule.ProcessTerminal();
  // The stock TuiAltScreen mouse consumer handles selection and does not
  // forward events to the sidecar app. Route SGR events ourselves instead.
  const tui = new tuiModule.TuiAltScreen(terminal, true, undefined, {
    mouse: false,
  });
  terminal.setTitle("Agent Board");
  tui.start();
  const requestRender = (): void => tui.requestRender();
  let client: BrokerClient | undefined;
  let app: BrokerDeckApp | undefined;
  let finish: (() => void) | undefined;
  let mouseRouter: MouseRouter | undefined;
  const close = (): void => finish?.();

  try {
    const broker = await resolveBrokerContext();
    client = new BrokerClient(broker);
    const pluginContext = parseHerdrPluginContext(
      process.env.HERDR_PLUGIN_CONTEXT_JSON,
      process.env.HERDR_PANE_ID,
    );
    const targetPaneId =
      pluginContext.targetPaneCandidates.length === 1
        ? pluginContext.targetPaneCandidates[0]
        : undefined;
    app = new BrokerDeckApp({
      client,
      requestRender,
      ...(targetPaneId ? { targetPaneId } : {}),
      getHeight: () => terminal.rows,
      onClose: close,
    });
    tui.setLayoutRoot(app);
    tui.setFocus(app);
    mouseRouter = installMouseRouter(process.stdin, process.stdout, (event) =>
      app!.handleMouse(event),
    );
    client.start();
    await client.waitForReady();
    requestRender();
    await new Promise<void>((resolve) => {
      finish = resolve;
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
      process.once("SIGHUP", resolve);
    });
  } catch (error) {
    process.stderr.write(`Agent Board: ${conciseError(error)}\n`);
    process.exitCode = 1;
  } finally {
    mouseRouter?.close();
    app?.dispose();
    client?.stop("Deck closed.");
    tui.setLayoutRoot(undefined);
    tui.stop();
  }
}
