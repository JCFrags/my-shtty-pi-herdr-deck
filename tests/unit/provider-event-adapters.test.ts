import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderEventAdapters,
  TODO_ACTION_REQUEST_EVENT,
  TODO_ACTION_RESPONSE_EVENT,
  FILES_PROVIDER_REQUEST_EVENT,
  FILES_PROVIDER_RESPONSE_EVENT,
  AGENT_BOARD_VIEW_RESPONSE_EVENT,
} from "../../src/pi/provider-event-adapters.js";

test("provider deck action correlates through the Pi event adapter", async () => {
  const handlers = new Map<string, Set<(value: unknown) => void>>();
  const bus = {
    on(event: string, handler: (value: unknown) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    off(event: string, handler: (value: unknown) => void) {
      handlers.get(event)?.delete(handler);
    },
    emit(event: string, value: unknown) {
      if (event === TODO_ACTION_REQUEST_EVENT) {
        const request = value as {
          requestId: string;
          action: string;
          taskId: string;
        };
        queueMicrotask(() => {
          for (const handler of handlers.get(TODO_ACTION_RESPONSE_EVENT) ?? [])
            handler({
              version: 1,
              requestId: request.requestId,
              ok: true,
              action: request.action,
              taskId: request.taskId,
              message: "committed",
            });
        });
      }
    },
  };
  const result = await new ProviderEventAdapters(bus).todo("done", "T7");
  assert.equal(result.ok, true);
  assert.equal(result.taskId, "T7");
});

test("provider adapter normalizes structured errors", async () => {
  const handlers = new Map<string, Set<(value: unknown) => void>>();
  const bus = {
    on(event: string, handler: (value: unknown) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    off(event: string, handler: (value: unknown) => void) {
      handlers.get(event)?.delete(handler);
    },
    emit(_event: string, value: unknown) {
      const request = value as { requestId: string };
      queueMicrotask(() => {
        for (const handler of handlers.get(TODO_ACTION_RESPONSE_EVENT) ?? [])
          handler({
            requestId: request.requestId,
            ok: false,
            error: { code: "BUSY", message: "Try later", retryable: true },
          });
      });
    },
  };
  await assert.rejects(
    new ProviderEventAdapters(bus).todo("start", "T1"),
    (error: unknown) => {
      const value = error as Error & { code?: string; retryable?: boolean };
      assert.equal(value.message, "Try later");
      assert.equal(value.code, "BUSY");
      assert.equal(value.retryable, true);
      return true;
    },
  );
});

test("a stale reload listener failure cannot beat the active Files provider", async () => {
  const handlers = new Map<string, Set<(value: unknown) => void>>();
  const bus = {
    on(event: string, handler: (value: unknown) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    off(event: string, handler: (value: unknown) => void) {
      handlers.get(event)?.delete(handler);
    },
    emit(event: string, value: unknown) {
      if (event !== FILES_PROVIDER_REQUEST_EVENT) return;
      const request = value as { requestId: string };
      queueMicrotask(() => {
        for (const handler of handlers.get(FILES_PROVIDER_RESPONSE_EVENT) ?? [])
          handler({
            requestId: request.requestId,
            ok: false,
            error: "No active Files provider",
          });
      });
      setTimeout(() => {
        for (const handler of handlers.get(FILES_PROVIDER_RESPONSE_EVENT) ?? [])
          handler({
            requestId: request.requestId,
            ok: true,
            summary: { selectedCount: 0 },
            view: { rows: [] },
          });
      }, 5);
    },
  };
  const result = await new ProviderEventAdapters(bus).files("snapshot");
  assert.equal(result.ok, true);
});

test("Files provider actions and Agent Board v2 views preserve correlated requests", async () => {
  const handlers = new Map<string, Set<(value: unknown) => void>>();
  const bus = {
    on(event: string, handler: (value: unknown) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    off(event: string, handler: (value: unknown) => void) {
      handlers.get(event)?.delete(handler);
    },
    emit(event: string, value: unknown) {
      const request = value as { requestId: string };
      const response =
        event === FILES_PROVIDER_REQUEST_EVENT
          ? FILES_PROVIDER_RESPONSE_EVENT
          : AGENT_BOARD_VIEW_RESPONSE_EVENT;
      queueMicrotask(() => {
        for (const handler of handlers.get(response) ?? [])
          handler(
            event === FILES_PROVIDER_REQUEST_EVENT
              ? {
                  requestId: request.requestId,
                  ok: true,
                  response: {
                    version: 1,
                    summary: { selectedCount: 1 },
                    view: { rows: [] },
                  },
                }
              : {
                  requestId: request.requestId,
                  response: {
                    schemaVersion: 2,
                    snapshot: { view: { tabs: {} } },
                  },
                },
          );
      });
    },
  };
  const adapter = new ProviderEventAdapters(bus);
  assert.equal((await adapter.files("snapshot")).ok, true);
  assert.equal((await adapter.boardView()).schemaVersion, 2);
});
