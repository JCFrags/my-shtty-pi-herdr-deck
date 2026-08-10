import type {
  Component,
  ProcessTerminal as ProcessTerminalType,
  TUI as TuiType,
} from "@pi-herdr-deck/tui";
import {
  hasComponentMouseApi,
  PI_COMPATIBILITY_MESSAGE,
} from "../bridge/capabilities.js";
import { BrokerClient } from "./broker-client.js";
import { BrokerDeckApp } from "./broker-app.js";
import { resolveBrokerSocketPath } from "./socket.js";

interface TuiRuntimeModule {
  TUI: new (
    terminal: ProcessTerminalType,
    showHardwareCursor?: boolean,
  ) => TuiType;
  ProcessTerminal: new () => ProcessTerminalType;
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
  terminal.setTitle("Pi Herdr Deck");
  tui.start();
  tui.setMouseTracking(true);
  const requestRender = (): void => tui.requestRender();
  let client: BrokerClient | undefined;
  let app: BrokerDeckApp | undefined;
  let finish: (() => void) | undefined;
  const close = (): void => finish?.();

  try {
    const socketPath = resolveBrokerSocketPath();
    client = new BrokerClient({ socketPath });
    app = new BrokerDeckApp({
      client,
      requestRender,
      getHeight: () => terminal.rows,
      onClose: close,
    });
    tui.addChild(app as Component);
    tui.setFocus(app as Component);
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
    process.stderr.write(`Pi Herdr Deck: ${conciseError(error)}\n`);
    process.exitCode = 1;
  } finally {
    app?.dispose();
    client?.stop("Deck closed.");
    tui.setMouseTracking(false);
    tui.stop();
  }
}
