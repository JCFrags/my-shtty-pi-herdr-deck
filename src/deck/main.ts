import type {
  Component,
  ProcessTerminal as ProcessTerminalType,
  TUI as TuiType,
} from "@pi-herdr-deck/tui";
import { BrokerClient } from "./broker-client.js";
import { BrokerDeckApp } from "./broker-app.js";
import { resolveBrokerContext } from "./socket.js";

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
  "Pi Herdr Deck requires Pi TUI with TuiAltScreen and ProcessTerminal.";

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
  const tui = new tuiModule.TuiAltScreen(terminal, true, undefined, {
    mouse: true,
  });
  terminal.setTitle("Pi Herdr Deck");
  tui.start();
  const requestRender = (): void => tui.requestRender();
  let client: BrokerClient | undefined;
  let app: BrokerDeckApp | undefined;
  let finish: (() => void) | undefined;
  const close = (): void => finish?.();

  try {
    const broker = await resolveBrokerContext();
    client = new BrokerClient(broker);
    app = new BrokerDeckApp({
      client,
      requestRender,
      getHeight: () => terminal.rows,
      onClose: close,
    });
    tui.setLayoutRoot(app);
    tui.setFocus(app);
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
    tui.setLayoutRoot(undefined);
    tui.stop();
  }
}
