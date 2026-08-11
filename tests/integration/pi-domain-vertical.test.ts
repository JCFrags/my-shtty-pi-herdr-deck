import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import { digest } from "../../src/broker/authentication.js";
import { PiAdapter } from "../../src/pi/adapter.js";
import { PiBrokerClient } from "../../src/pi/broker-client.js";
import { validateAssignment } from "../../extensions/pi-herdr-orchestrator.js";
import type { PiApiLike, PiContextLike } from "../../src/pi/types.js";
import { resolvePaths, sessionKey } from "../../src/shared/paths.js";
import type { EventStore } from "../../src/state/event-store.js";

const actor = {
  principalId: "prn_00000000000000000000000000",
  kind: "system" as const,
};
class DueTimers {
  readonly entries = new Map<
    NodeJS.Timeout,
    { due: number; order: number; callback: () => void; active: boolean }
  >();
  #order = 0;
  constructor(readonly now: { value: number }) {}
  setTimeout = (callback: () => void, delay: number): NodeJS.Timeout => {
    const handle = { unref: () => handle } as unknown as NodeJS.Timeout;
    this.entries.set(handle, {
      due: this.now.value + delay,
      order: this.#order++,
      callback,
      active: true,
    });
    return handle;
  };
  clearTimeout = (handle: NodeJS.Timeout): void => {
    const entry = this.entries.get(handle);
    if (entry) entry.active = false;
  };
  advance(to: number): void {
    this.now.value = to;
    while (true) {
      const due = [...this.entries.entries()]
        .filter(([, entry]) => entry.active && entry.due <= to)
        .sort(([, a], [, b]) => a.due - b.due || a.order - b.order);
      if (!due.length) return;
      for (const [handle, entry] of due) {
        if (!entry.active) continue;
        this.clearTimeout(handle);
        entry.callback();
      }
    }
  }
}

class ControlledHerdr {
  readonly tokens = new Map<string, string>();
  readonly stops: unknown[] = [];
  #count = 0;
  constructor(readonly store: EventStore) {}
  async startupReconcile(): Promise<[]> {
    return [];
  }
  async verifyRoot(identity: any): Promise<any> {
    return {
      paneId: identity.paneId,
      terminalId: identity.terminalId,
      workspaceId: "test-workspace",
      cwd: "/controlled",
    };
  }
  async provision(input: any): Promise<any> {
    const token = `controlled-token-${++this.#count}`;
    this.tokens.set(input.agentId, token);
    await this.store.append({
      type: "herdr.provision.intent",
      actor,
      entityRefs: { agentId: input.agentId },
      payload: { agentId: input.agentId },
    });
    await this.store.append({
      type: "herdr.provision.outcome",
      actor,
      entityRefs: { agentId: input.agentId },
      payload: {
        agentId: input.agentId,
        state: "pending",
        paneId: `child-pane-${this.#count}`,
        terminalId: `child-terminal-${this.#count}`,
        tokenDigest: digest(token),
        generation: 1,
        parentAgentId: input.parentAgentId,
        ownerId: input.agentId,
      },
    });
    return {
      name: `controlled-child-${this.#count}`,
      token: { token, digest: digest(token), generation: 1 },
      paneId: `child-pane-${this.#count}`,
    };
  }
  async register(agentId: string, identity: any): Promise<void> {
    const resource = this.store.state.herdrResources?.[agentId];
    await this.store.append({
      type: "herdr.provision.outcome",
      actor,
      entityRefs: { agentId },
      payload: {
        agentId,
        state: "registered",
        paneId: identity.paneId,
        terminalId: identity.terminalId,
        sessionId: identity.sessionId,
        generation: identity.generation,
        tokenDigest: resource?.tokenDigest,
        parentAgentId: resource?.parentAgentId,
        ownerId: agentId,
      },
    });
  }
  async stop(guard: unknown): Promise<void> {
    this.stops.push(guard);
  }
}

function piBoundary(
  sessionId: string,
  idle: { value: boolean },
  aborted: { count: number },
) {
  const api: PiApiLike = {
    on: () => undefined,
    registerCommand: () => undefined,
    sendUserMessage: async () => {
      idle.value = false;
    },
    getActiveTools: () => ["read"],
  };
  const context: PiContextLike = {
    ui: {},
    cwd: "/controlled",
    sessionManager: { getSessionId: () => sessionId },
    modelRegistry: {},
    isIdle: () => idle.value,
    hasPendingMessages: () => false,
    abort: () => {
      aborted.count++;
      idle.value = true;
    },
    compact: (options) => options?.onComplete?.(),
    model: { provider: "test", id: "model", name: "model" },
    thinkingLevel: "medium",
  };
  return { api, context };
}

function paths(root: string, runtime: string) {
  return {
    ...resolvePaths(join(runtime, "herdr.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
}

async function bounded<T>(
  promise: Promise<T>,
  label: string,
  ms = 5_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function receipt(
  store: EventStore,
  label: string,
  predicate: (event: any) => boolean,
): { promise: Promise<any>; remove: () => void } {
  let remove: () => void = () => undefined;
  const promise = new Promise<any>((resolve) => {
    remove = store.onAppend((event) => {
      if (predicate(event)) {
        remove();
        resolve(event);
      }
    });
  });
  return { promise: bounded(promise, label), remove };
}

async function request(
  client: PiBrokerClient,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  return client.request(method, params);
}

async function runCase(kind: "cancel" | "deadline"): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `pi-domain-${kind}-`));
  const runtime = await mkdtemp(join(tmpdir(), `pi-domain-${kind}-runtime-`));
  const now = { value: Date.parse("2026-01-01T00:00:00.000Z") };
  const timers = new DueTimers(now);
  const pathsForCase = paths(root, runtime);
  let herdr!: ControlledHerdr;
  const broker = new Broker(pathsForCase, {
    now: () => now.value,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    herdrFactory: async (store) => (herdr = new ControlledHerdr(store)) as any,
  });
  const originalPane = process.env.HERDR_PANE_ID;
  const originalTerminal = process.env.HERDR_TERMINAL_ID;
  const originalName = process.env.HERDR_AGENT_NAME;
  process.env.HERDR_PANE_ID = "parent-pane";
  process.env.HERDR_TERMINAL_ID = "parent-terminal";
  process.env.HERDR_AGENT_NAME = "parent";
  const ownedRemovers: Array<() => void> = [];
  const ownReceipt = (label: string, predicate: (event: any) => boolean) => {
    const owned = receipt(broker.store, label, predicate);
    ownedRemovers.push(owned.remove);
    return owned;
  };
  let parent: PiBrokerClient | undefined;
  let child: PiBrokerClient | undefined;
  let parentAdapter: PiAdapter | undefined;
  let childAdapter: PiAdapter | undefined;
  try {
    await broker.start();
    const secret = (await readFile(pathsForCase.secret, "utf8")).trim();
    const parentIdle = { value: true };
    const parentAborted = { count: 0 };
    const parentBoundary = piBoundary(
      "parent-session",
      parentIdle,
      parentAborted,
    );
    parentAdapter = new PiAdapter(
      parentBoundary.api,
      parentBoundary.context,
      "pending-parent",
      1,
    );
    parent = new PiBrokerClient({
      socketPath: pathsForCase.socket,
      sessionKey: sessionKey(pathsForCase.socket),
      piSessionId: "parent-session",
      secret,
    });
    await parent.connect();
    const registeredParent = await parent.register(parentAdapter.safeState());
    parentAdapter.bindIdentity(
      registeredParent.agentId,
      registeredParent.generation,
      registeredParent.connectionGeneration,
    );
    parent.markRegistrationReady();

    const delegated = await request(parent, "delegate.execute", {
      mode: "single",
      parentAgentId: registeredParent.agentId,
      title: `vertical-${kind}`,
      steps: [
        {
          key: "one",
          profileId: "scout",
          title: "one",
          objective: kind,
          dependsOn: [],
        },
      ],
      wait: false,
      waitUntil: [],
      timeoutMs: 60_000,
      failureMode: "collect_all",
      dryRun: false,
    });
    const item = delegated.tasks[0];
    const taskId = item.taskId as string;
    const runId = item.runId as string;
    const agentId = item.agentId as string;
    const assignmentDelivered = ownReceipt(
      "assignment delivery",
      (event) =>
        event.type === "assignment.delivered" &&
        event.entityRefs?.runId === runId,
    );
    const assignmentAccepted = ownReceipt(
      "assignment acceptance",
      (event) =>
        event.type === "assignment.accepted" &&
        event.entityRefs?.runId === runId,
    );
    const childIdle = { value: true };
    const childAborted = { count: 0 };
    const childBoundary = piBoundary("child-session", childIdle, childAborted);
    const capturedControls: any[] = [];
    let resolveControl!: (value: any) => void;
    const controlDelivered = new Promise<any>((resolve) => {
      resolveControl = resolve;
    });
    childAdapter = new PiAdapter(
      childBoundary.api,
      childBoundary.context,
      agentId,
      1,
    );
    child = new PiBrokerClient({
      socketPath: pathsForCase.socket,
      sessionKey: sessionKey(pathsForCase.socket),
      piSessionId: "child-session",
      agentId,
      generation: 1,
      token: herdr.tokens.get(agentId)!,
      onServerRequest: async (serverRequest) => {
        assert.equal(serverRequest.method, "assignment.deliver");
        const expected = serverRequest.params.expected as Record<
          string,
          unknown
        >;
        assert.deepEqual(Object.keys(expected).sort(), [
          "activity",
          "connectionGeneration",
          "piSessionId",
        ]);
        const safe = childAdapter!.safeState();
        assert.deepEqual(expected, {
          activity: safe.activity,
          connectionGeneration: safe.connectionGeneration,
          piSessionId: safe.sessionId,
        });
        const raw = serverRequest.params.assignment as Record<string, unknown>;
        assert.equal(
          raw.assignmentGeneration,
          broker.store.state.runs[runId]?.assignmentGeneration,
        );
        assert.equal(Object.hasOwn(raw, "piSessionId"), false);
        const assignment = validateAssignment(
          raw,
          safe,
          expected.piSessionId as string,
        );
        const accepted = await childAdapter!.deliver(assignment);
        return { status: accepted };
      },
      onControlRequest: async (serverRequest) => {
        const result = await childAdapter!.handleControl(
          serverRequest.method,
          serverRequest.params,
        );
        capturedControls.push({ request: serverRequest, result });
        resolveControl({ request: serverRequest, result });
        return result;
      },
    });
    process.env.HERDR_PANE_ID = "child-pane";
    process.env.HERDR_TERMINAL_ID = "child-terminal";
    process.env.HERDR_AGENT_NAME = "child";
    await child.connect();
    const registeredChild = await child.register(childAdapter.safeState());
    childAdapter.bindIdentity(
      registeredChild.agentId,
      registeredChild.generation,
      registeredChild.connectionGeneration,
    );
    child.markRegistrationReady();
    await bounded(assignmentDelivered.promise, "assignment event");
    await bounded(assignmentAccepted.promise, "assignment accepted event");
    childAdapter.onLifecycle({
      type: "agent_start",
      agentId,
      generation: 1,
      piSessionId: "child-session",
    });
    const assignmentGeneration =
      broker.store.state.runs[runId]!.assignmentGeneration;
    const bound = childAdapter.onLifecycle({
      type: "turn_start",
      agentId,
      generation: 1,
      piSessionId: "child-session",
      assignmentGeneration,
      turnIndex: 1,
    });
    assert.equal(bound, "bound");
    const started = ownReceipt(
      "run started",
      (event) =>
        event.type === "run.pi_started" && event.entityRefs?.runId === runId,
    );
    await request(
      child,
      "agent.lifecycle_event",
      childAdapter.lifecyclePayload(
        "bound",
        {
          type: "turn_start",
          agentId,
          generation: 1,
          piSessionId: "child-session",
          assignmentGeneration,
          turnIndex: 1,
        },
        child.nextAdapterSeq(),
      )!,
    );
    await bounded(started.promise, "run start event");
    assert.equal(broker.store.state.runs[runId]?.state, "working");
    const task = broker.store.state.tasks[taskId]!;
    const run = broker.store.state.runs[runId]!;
    const timeoutAt = task.timeoutAt!;
    assert.equal(timeoutAt, run.timeoutAt);

    const terminalEvidence: any[] = [];
    const removeTerminalEvidence = broker.store.onAppend((event) => {
      if (event.entityRefs?.taskId !== taskId) return;
      if (
        event.type === "task.cancel_requested" ||
        (event.type === "run.state_changed" &&
          ["cancelled", "timed_out"].includes((event.payload as any)?.state))
      )
        terminalEvidence.push(event);
    });
    ownedRemovers.push(removeTerminalEvidence);
    const terminalReceipt = ownReceipt(
      "canonical terminal event",
      (event) =>
        (kind === "cancel" &&
          event.type === "task.cancel_requested" &&
          event.entityRefs?.taskId === taskId) ||
        (kind === "deadline" &&
          event.type === "run.state_changed" &&
          event.entityRefs?.runId === runId &&
          (event.payload as any)?.state === "timed_out"),
    );
    if (kind === "cancel") {
      const cancelResult = await request(parent, "task.cancel", {
        taskId,
        reason: "controlled cancellation",
        cascade: true,
      });
      assert.deepEqual(cancelResult, { taskId, state: "cancelled" });
    } else {
      const due = [...timers.entries.values()].find(
        (entry) => entry.active && entry.due === Date.parse(timeoutAt),
      );
      assert.ok(due, "owned task deadline timer exists");
      timers.advance(Date.parse(timeoutAt));
    }
    const terminalEvent = await bounded(
      terminalReceipt.promise,
      "canonical terminal event",
    );
    assert.ok(Number.isSafeInteger(terminalEvent.seq));
    assert.equal(terminalEvidence[0], terminalEvent);
    assert.equal(
      broker.store.state.tasks[taskId]?.state,
      kind === "cancel" ? "cancelled" : "timed_out",
    );
    assert.equal(
      broker.store.state.runs[runId]?.state,
      kind === "cancel" ? "cancelled" : "timed_out",
    );
    const deliveredControl = await bounded(
      controlDelivered,
      "control delivery",
    );
    assert.equal(capturedControls.length, 1);
    const control = deliveredControl.request;
    assert.equal(control.method, "control.abort");
    assert.deepEqual(Object.keys(control.params).sort(), [
      "agentId",
      "connectionGeneration",
      "generation",
      "piSessionId",
    ]);
    assert.equal(control.params.agentId, agentId);
    assert.equal(control.params.generation, 1);
    assert.equal(control.params.piSessionId, "child-session");
    assert.equal(
      control.params.connectionGeneration,
      registeredChild.connectionGeneration,
    );
    assert.deepEqual(deliveredControl.result, { ok: true });
    assert.equal(childAborted.count, 1);
    assert.equal(herdr.stops.length, 0);
    if (kind === "cancel") {
      assert.equal(terminalEvent.type, "task.cancel_requested");
      assert.deepEqual(terminalEvent.entityRefs, { taskId });
      assert.deepEqual(terminalEvent.payload, {
        taskId,
        reason: "controlled cancellation",
        cascade: true,
      });
    }
    if (kind === "deadline") {
      assert.equal(terminalEvent.type, "run.state_changed");
      assert.deepEqual(terminalEvent.entityRefs, { taskId, runId });
      assert.deepEqual(terminalEvent.payload, {
        runId,
        state: "timed_out",
        reason: {
          code: "TIMEOUT",
          message: "The task wall deadline expired.",
        },
      });
      assert.equal(
        [...timers.entries.values()].some(
          (entry) => entry.active && entry.due === Date.parse(timeoutAt),
        ),
        false,
      );
    }
    assert.equal(herdr.stops.length, 0);
    child.close();
    parent.close();
    assert.equal(child.connected, false);
    assert.equal(parent.connected, false);
    await bounded(broker.stop(), "broker stop");
    assert.equal(terminalEvidence.length, 1);
    assert.equal(terminalEvidence[0], terminalEvent);
    const afterStop = await readFile(pathsForCase.events, "utf8");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await readFile(pathsForCase.events, "utf8"), afterStop);
    await assert.rejects(access(pathsForCase.socket));
    await assert.rejects(access(pathsForCase.lock));
  } finally {
    child?.close();
    parent?.close();
    await broker.stop().catch(() => undefined);
    for (const remove of ownedRemovers.splice(0)) remove();
    if (originalPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = originalPane;
    if (originalTerminal === undefined) delete process.env.HERDR_TERMINAL_ID;
    else process.env.HERDR_TERMINAL_ID = originalTerminal;
    if (originalName === undefined) delete process.env.HERDR_AGENT_NAME;
    else process.env.HERDR_AGENT_NAME = originalName;
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
}

test("real Broker, PiBrokerClient, and PiAdapter active cancellation vertical", async () => {
  for (let attempt = 0; attempt < 20; attempt++) await runCase("cancel");
});

test("real Broker, PiBrokerClient, and PiAdapter wall deadline vertical", async () => {
  for (let attempt = 0; attempt < 20; attempt++) await runCase("deadline");
});
