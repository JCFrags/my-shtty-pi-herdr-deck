import assert from "node:assert/strict";
import { lstat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { socketLocationForPane } from "../../src/bridge/server.js";
import type { PiContextLike } from "../../src/pi/types.js";
import { createFakePiHarness, waitFor } from "../helpers.js";

interface FakeExtensionApi {
  handlers: Map<
    string,
    Array<(event: unknown, context: PiContextLike) => void | Promise<void>>
  >;
  commands: Map<
    string,
    { handler(args: string, context: PiContextLike): void | Promise<void> }
  >;
  api: Record<string, unknown>;
}

const TUI_MODULE_KEY = Symbol.for("pi-herdr-deck.tui-module.v1");

function installCapableTuiStub(): void {
  (globalThis as typeof globalThis & { [TUI_MODULE_KEY]?: unknown })[
    TUI_MODULE_KEY
  ] = {
    parseMouseInput: () => undefined,
    ProcessTerminal: class ProcessTerminal {},
    TUI: class TUI {
      setMouseTracking(): void {}
    },
  };
}

function removeCapableTuiStub(): void {
  delete (globalThis as typeof globalThis & { [TUI_MODULE_KEY]?: unknown })[
    TUI_MODULE_KEY
  ];
}

function fakeExtensionApi(): FakeExtensionApi {
  const harness = createFakePiHarness();
  const handlers = new Map<
    string,
    Array<(event: unknown, context: PiContextLike) => void | Promise<void>>
  >();
  const commands = new Map<
    string,
    { handler(args: string, context: PiContextLike): void | Promise<void> }
  >();
  const api = {
    ...harness.pi,
    on: (
      event: string,
      handler: (event: unknown, context: PiContextLike) => void | Promise<void>,
    ) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand: (
      name: string,
      command: {
        handler(args: string, context: PiContextLike): void | Promise<void>;
      },
    ) => commands.set(name, command),
  };
  return { handlers, commands, api };
}

async function emit(
  fake: FakeExtensionApi,
  event: string,
  context: PiContextLike,
): Promise<void> {
  for (const handler of fake.handlers.get(event) ?? [])
    await handler({}, context);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

test("extension removes its socket on reload and session shutdown", async () => {
  installCapableTuiStub();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "pi-deck-extension-"));
  const previousPane = process.env.HERDR_PANE_ID;
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.HERDR_PANE_ID = "reload/pane";
  process.env.XDG_RUNTIME_DIR = runtimeRoot;
  try {
    const extension = (
      await import(`../../extensions/pi-herdr-deck.js?test=${Date.now()}`)
    ).default;
    const first = fakeExtensionApi();
    const firstHarness = createFakePiHarness();
    await extension(first.api as never);
    await emit(first, "session_start", firstHarness.context);
    const socketPath = socketLocationForPane("reload/pane").socketPath;
    await waitFor(() => {
      try {
        return Boolean(requireStat(socketPath));
      } catch {
        return false;
      }
    });
    assert.equal(await pathExists(socketPath), true);

    const second = fakeExtensionApi();
    const secondHarness = createFakePiHarness();
    await extension(second.api as never);
    assert.equal(await pathExists(socketPath), false);
    // Event handlers retained by a host during reload must not restart the disposed runtime.
    await emit(first, "session_start", firstHarness.context);
    assert.equal(await pathExists(socketPath), false);
    await emit(second, "session_start", secondHarness.context);
    await waitFor(asyncPredicate(() => pathExists(socketPath)));
    assert.equal(await pathExists(socketPath), true);
    await emit(second, "session_shutdown", secondHarness.context);
    assert.equal(await pathExists(socketPath), false);
  } finally {
    removeCapableTuiStub();
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
  }
});

function requireStat(path: string): boolean {
  try {
    return (process.getBuiltinModule("node:fs") as typeof import("node:fs"))
      .lstatSync(path)
      .isSocket();
  } catch {
    return false;
  }
}

function asyncPredicate(predicate: () => Promise<boolean>): () => boolean {
  let value = false;
  void predicate().then((result) => {
    value = result;
  });
  return () => {
    if (!value)
      void predicate().then((result) => {
        value = result;
      });
    return value;
  };
}

test("extension remains loadable outside Herdr and status explains missing HERDR_PANE_ID", async () => {
  const previousPane = process.env.HERDR_PANE_ID;
  delete process.env.HERDR_PANE_ID;
  try {
    const extension = (
      await import(`../../extensions/pi-herdr-deck.js?outside=${Date.now()}`)
    ).default;
    const fake = fakeExtensionApi();
    const harness = createFakePiHarness();
    const notices: string[] = [];
    harness.context.ui.notify = (message) => notices.push(message);
    await extension(fake.api as never);
    const command = fake.commands.get("herdr-deck-status");
    assert.ok(command);
    await command.handler("", harness.context);
    assert.equal(
      notices.at(-1),
      "Pi Deck is inactive because HERDR_PANE_ID is not available. Run Pi inside a Herdr pane.",
    );
    await emit(fake, "session_shutdown", harness.context);
  } finally {
    if (previousPane !== undefined) process.env.HERDR_PANE_ID = previousPane;
  }
});
