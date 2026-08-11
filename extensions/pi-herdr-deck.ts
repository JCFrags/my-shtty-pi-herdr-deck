import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  detectPiCapabilities,
  PI_COMPATIBILITY_MESSAGE,
} from "../src/bridge/capabilities.js";
import { PiDeckController } from "../src/bridge/pi-controller.js";
import {
  BridgeServer,
  CompatibilityRejectionServer,
} from "../src/bridge/server.js";
import type { PiApiLike, PiContextLike } from "../src/pi/types.js";

const GLOBAL_KEY = Symbol.for("pi-herdr-deck.runtime.v1");
const TUI_MODULE_KEY = Symbol.for("pi-herdr-deck.tui-module.v1");
const STATUS_KEY = "pi-herdr-deck";
const NO_PANE_MESSAGE =
  "Pi Deck is inactive because HERDR_PANE_ID is not available. Run Pi inside a Herdr pane.";

type ManagedServer = BridgeServer | CompatibilityRejectionServer;

interface ExtensionRuntime {
  active: boolean;
  status: string;
  server: ManagedServer | undefined;
  controller: PiDeckController | undefined;
  startPromise: Promise<void> | undefined;
  compatibleMessageShown: boolean;
  exitHandler: () => void;
  stopBridge(reason: string): Promise<void>;
  cleanup(reason: string): Promise<void>;
}

type GlobalWithRuntime = typeof globalThis & {
  [GLOBAL_KEY]?: ExtensionRuntime;
  [TUI_MODULE_KEY]?: unknown;
};

function conciseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function piHerdrDeckExtension(
  api: ExtensionAPI,
): Promise<void> {
  const pi = api as unknown as PiApiLike;
  const globals = globalThis as GlobalWithRuntime;
  const previous = globals[GLOBAL_KEY];
  if (previous) await previous.cleanup("extension reload");

  const runtime: ExtensionRuntime = {
    active: true,
    status: process.env.HERDR_PANE_ID
      ? "Pi Deck bridge has not started yet."
      : NO_PANE_MESSAGE,
    server: undefined,
    controller: undefined,
    startPromise: undefined,
    compatibleMessageShown: false,
    exitHandler: () => undefined,
    async stopBridge(reason: string): Promise<void> {
      const pendingStart = runtime.startPromise;
      if (pendingStart) await pendingStart.catch(() => undefined);
      const server = runtime.server;
      runtime.server = undefined;
      const controller = runtime.controller;
      runtime.controller = undefined;
      controller?.dispose();
      if (server) await server.close();
      runtime.status = process.env.HERDR_PANE_ID
        ? `Pi Deck bridge stopped: ${reason}.`
        : NO_PANE_MESSAGE;
    },
    async cleanup(reason: string): Promise<void> {
      runtime.active = false;
      await runtime.stopBridge(reason);
      process.off("exit", runtime.exitHandler);
      if (globals[GLOBAL_KEY] === runtime) delete globals[GLOBAL_KEY];
    },
  };
  runtime.exitHandler = () => runtime.server?.disposeSync();
  process.once("exit", runtime.exitHandler);
  globals[GLOBAL_KEY] = runtime;

  const reportCompatibility = async (context: PiContextLike): Promise<void> => {
    if (!runtime.active) return;
    runtime.status = PI_COMPATIBILITY_MESSAGE;
    context.ui.setStatus?.(STATUS_KEY, "Pi Deck incompatible");
    if (!runtime.compatibleMessageShown) {
      runtime.compatibleMessageShown = true;
      context.ui.notify?.(PI_COMPATIBILITY_MESSAGE, "error");
    }
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId || runtime.server) return;
    const rejection = new CompatibilityRejectionServer({
      paneId,
      reason: PI_COMPATIBILITY_MESSAGE,
      log: () => undefined,
    });
    try {
      await rejection.start();
      runtime.server = rejection;
    } catch {
      rejection.disposeSync();
    }
  };

  const startBridge = async (context: PiContextLike): Promise<void> => {
    if (!runtime.active) return;
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId) {
      runtime.status = NO_PANE_MESSAGE;
      context.ui.setStatus?.(STATUS_KEY, "Pi Deck: outside Herdr");
      return;
    }
    if (runtime.server?.started) {
      runtime.controller?.updateContext(context);
      return;
    }
    if (runtime.startPromise) return await runtime.startPromise;
    runtime.startPromise = (async () => {
      let tuiModule: unknown = globals[TUI_MODULE_KEY];
      if (!tuiModule) {
        try {
          tuiModule = await import("@earendil-works/pi-tui");
        } catch {
          await reportCompatibility(context);
          return;
        }
      }
      const capabilities = detectPiCapabilities(context, tuiModule);
      if (!capabilities.compatible || !capabilities.expansion) {
        await reportCompatibility(context);
        return;
      }
      let controller: PiDeckController;
      try {
        controller = new PiDeckController(
          pi,
          context,
          paneId,
          capabilities.expansion,
        );
      } catch {
        await reportCompatibility(context);
        return;
      }
      let server: BridgeServer;
      try {
        server = new BridgeServer({
          controller,
          log: (message) => {
            runtime.status = `Pi Deck bridge error: ${message}`;
          },
        });
        await server.start();
      } catch (error) {
        controller.dispose();
        runtime.status = `Pi Deck bridge failed: ${conciseError(error)}`;
        context.ui.setStatus?.(STATUS_KEY, "Pi Deck bridge failed");
        context.ui.notify?.(runtime.status, "error");
        return;
      }
      if (!runtime.active) {
        controller.dispose();
        await server.close();
        return;
      }
      runtime.controller = controller;
      runtime.server = server;
      runtime.status = `Pi Deck bridge listening at ${server.socketPath}`;
      context.ui.setStatus?.(STATUS_KEY, "Pi Deck connected");
    })()
      .catch((error) => {
        if (!runtime.active) return;
        runtime.status = `Pi Deck bridge failed: ${conciseError(error)}`;
        context.ui.setStatus?.(STATUS_KEY, "Pi Deck bridge failed");
        context.ui.notify?.(runtime.status, "error");
      })
      .finally(() => {
        runtime.startPromise = undefined;
      });
    await runtime.startPromise;
  };

  pi.registerCommand("herdr-deck-status", {
    description: "Show Pi Deck bridge compatibility and socket status",
    handler: async (_args, context) => {
      if (!runtime.active) return;
      if (
        process.env.HERDR_PANE_ID &&
        !runtime.server &&
        runtime.status !== PI_COMPATIBILITY_MESSAGE
      ) {
        await startBridge(context);
      }
      context.ui.notify?.(
        runtime.status,
        runtime.status === PI_COMPATIBILITY_MESSAGE ||
          runtime.status.includes("failed")
          ? "error"
          : "info",
      );
    },
  });

  pi.on("session_start", async (_event, context) => {
    if (!runtime.active) return;
    await startBridge(context);
    runtime.controller?.recordEvent("session_start", _event, context);
  });
  pi.on("session_shutdown", async () => {
    if (!runtime.active) return;
    await runtime.stopBridge("session shutdown");
  });

  const stateEvents = [
    "session_info_changed",
    "session_compact",
    "agent_start",
    "agent_end",
    "agent_settled",
    "turn_start",
    "turn_end",
    "model_select",
    "thinking_level_select",
    "tool_call",
    "tool_result",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
  ] as const;
  for (const eventName of stateEvents) {
    pi.on(eventName, (event, context) => {
      if (runtime.active)
        runtime.controller?.recordEvent(eventName, event, context);
    });
  }
}
