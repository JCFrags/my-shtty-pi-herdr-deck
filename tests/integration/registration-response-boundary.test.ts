import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import { digest } from "../../src/broker/authentication.js";
import { PiBrokerClient } from "../../src/pi/broker-client.js";
import { createId } from "../../src/shared/ids.js";
import { sessionKey } from "../../src/shared/paths.js";
import type { EventStore } from "../../src/state/event-store.js";

const previousPane = process.env.HERDR_PANE_ID;
const previousTerminal = process.env.HERDR_TERMINAL_ID;
function restoreHerdrIdentity(): void {
  if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = previousPane;
  if (previousTerminal === undefined) delete process.env.HERDR_TERMINAL_ID;
  else process.env.HERDR_TERMINAL_ID = previousTerminal;
}
const actor = {
  principalId: "prn_00000000000000000000000000",
  kind: "system" as const,
};
const safeState = {
  agentId: "agt_pending",
  generation: 1,
  sessionId: "pi-session",
  idle: true,
  pendingMessages: 0,
  activity: "idle" as const,
  activeTools: ["read"],
  capabilities: {
    core: true,
    prompt: true,
    steer: true,
    followUp: true,
    abort: true,
    compact: true,
    model: true,
    thinking: true,
    tools: true,
    toolExpansion: false,
  },
};

class BoundaryHerdr {
  rootCalls = 0;
  managedCalls = 0;
  mismatchCalls = 0;
  failMismatch = false;
  constructor(readonly store: EventStore) {}
  get resources() {
    return this.store.state.herdrResources ?? {};
  }
  async startupReconcile(): Promise<[]> {
    return [];
  }
  async verifyRoot(identity: { paneId: string; terminalId?: string }) {
    this.rootCalls++;
    return {
      paneId: identity.paneId,
      terminalId: identity.terminalId ?? "terminal-1",
      workspaceId: "workspace-1",
      tabId: "tab-1",
      cwd: this.rootCalls >= 3 ? "/replacement" : "/checkout",
    };
  }
  async register(agentId: string, identity: Record<string, unknown>) {
    const resource = this.resources[agentId];
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
  async verifyManagedPane(
    _agentId: string,
    identity: { paneId: string; terminalId?: string },
  ) {
    this.managedCalls++;
    return {
      paneId: identity.paneId,
      terminalId: identity.terminalId ?? "managed-terminal",
      workspaceId: "workspace-1",
      tabId: "tab-1",
      cwd: this.managedCalls >= 3 ? "/replacement" : "/checkout",
    };
  }
  async recordRegistrationMismatch(agentId: string): Promise<void> {
    this.mismatchCalls++;
    if (this.failMismatch)
      throw new Error("BOUNDARY_MISMATCH_RECORDING_SENTINEL");
    await this.store.append({
      type: "herdr.provision.outcome",
      actor,
      entityRefs: { agentId },
      payload: {
        agentId,
        state: "replaced",
        reason: "registration_identity_mismatch",
        cleanupOutcome: "retained",
        unknown: true,
      },
    });
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "registration-boundary-"));
  const runtime = join(root, "runtime");
  const socket = join(runtime, "broker.sock");
  const paths = {
    sessionKey: sessionKey(socket),
    root: join(root, "state"),
    runtime,
    events: join(root, "state", "events.jsonl"),
    snapshot: join(root, "state", "snapshot.json"),
    lock: join(runtime, "broker.lock"),
    socket,
    secret: join(runtime, "client.secret"),
  };
  let herdr!: BoundaryHerdr;
  const broker = new Broker(paths, {
    herdrFactory: async (store) => (herdr = new BoundaryHerdr(store)) as never,
  });
  await broker.start();
  return {
    root,
    paths,
    broker,
    herdr,
    clients: [] as PiBrokerClient[],
  };
}

async function cleanup(
  root: string,
  broker: Broker,
  clients: PiBrokerClient[],
  expectedStopPattern?: RegExp,
): Promise<void> {
  const errors: unknown[] = [];
  restoreHerdrIdentity();
  for (const client of clients)
    try {
      client.close();
    } catch (error) {
      errors.push(error);
    }
  let firstStopError: unknown;
  try {
    await broker.stop();
  } catch (error) {
    firstStopError = error;
    if (
      !expectedStopPattern ||
      !(error instanceof Error) ||
      !expectedStopPattern.test(error.message)
    )
      errors.push(error);
  }
  if (firstStopError !== undefined) {
    try {
      await broker.stop();
    } catch (retryError) {
      if (
        !expectedStopPattern ||
        !(retryError instanceof Error) ||
        !expectedStopPattern.test(retryError.message)
      )
        errors.push(
          new AggregateError(
            [firstStopError, retryError],
            "Initial and retry broker stop failed.",
          ),
        );
    }
  }
  const socketPath = join(root, "runtime", "broker.sock");
  const socketStillExists = await import("node:fs/promises").then(({ lstat }) =>
    lstat(socketPath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        errors.push(error);
        return true;
      },
    ),
  );
  if (!socketStillExists)
    await rm(root, { recursive: true, force: true }).catch((error) =>
      errors.push(error),
    );
  else
    errors.push(
      new Error("Boundary root retained because the broker socket is live."),
    );
  if (errors.length)
    throw new AggregateError(errors, "Boundary cleanup failed.");
}

test("adopted registration rejects a mutation at the final response boundary", async () => {
  const { root, paths, broker, herdr, clients } = await fixture();
  try {
    process.env.HERDR_PANE_ID = "pane-1";
    process.env.HERDR_TERMINAL_ID = "terminal-1";
    const client = new PiBrokerClient({
      socketPath: paths.socket,
      sessionKey: paths.sessionKey,
      piSessionId: "pi-session",
      secret: (await readFile(paths.secret, "utf8")).trimEnd(),
    });
    clients.push(client);
    await client.connect();
    await assert.rejects(
      () =>
        client.register(safeState, {
          source: "herdr:pi",
          agent: "pi",
          kind: "id",
          value: "pi-session",
        }),
      /Herdr occupant changed during adoption/,
    );
    assert.equal(herdr.rootCalls, 3);
    assert.equal(
      Object.values(broker.store.state.agents).some(
        (agent) => agent.state === "replaced",
      ),
      true,
    );
  } finally {
    await cleanup(root, broker, clients);
  }
});

async function managedCase(failMismatch: boolean): Promise<{
  root: string;
  broker: Broker;
  herdr: BoundaryHerdr;
  clients: PiBrokerClient[];
}> {
  const fixtureValue = await fixture();
  const { root, broker, herdr, paths, clients } = fixtureValue;
  try {
    herdr.failMismatch = failMismatch;
    const agentId = createId("agt");
    const token = "managed-boundary-token-value";
    await broker.store.append({
      type: "agent.registered",
      actor,
      entityRefs: { agentId },
      payload: {
        agentId,
        managed: true,
        generation: 1,
        paneId: "managed-pane",
        terminalId: "managed-terminal",
        piSessionId: "managed-session",
      },
    });
    await broker.store.append({
      type: "herdr.provision.intent",
      actor,
      entityRefs: { agentId },
      payload: { agentId },
    });
    await broker.store.append({
      type: "herdr.provision.outcome",
      actor,
      entityRefs: { agentId },
      payload: {
        agentId,
        state: "pending",
        paneId: "managed-pane",
        terminalId: "managed-terminal",
        tokenDigest: digest(token),
        generation: 1,
        parentAgentId: createId("agt"),
        ownerId: agentId,
      },
    });
    process.env.HERDR_PANE_ID = "managed-pane";
    process.env.HERDR_TERMINAL_ID = "managed-terminal";
    const client = new PiBrokerClient({
      socketPath: paths.socket,
      sessionKey: paths.sessionKey,
      piSessionId: "managed-session",
      agentId,
      generation: 1,
      token,
    });
    clients.push(client);
    await client.connect();
    await assert.rejects(
      () =>
        client.register(
          { ...safeState, sessionId: "managed-session" },
          {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: "managed-session",
          },
        ),
      /Managed Herdr resource changed during registration/,
    );
    return fixtureValue;
  } catch (primary) {
    try {
      await cleanup(
        root,
        broker,
        clients,
        failMismatch ? /BOUNDARY_MISMATCH_RECORDING_SENTINEL/ : undefined,
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [primary, cleanupError],
        "Managed boundary setup and cleanup failed.",
      );
    }
    throw primary;
  }
}

test("managed registration records replacement after a response-boundary mutation", async () => {
  const { root, broker, herdr, clients } = await managedCase(false);
  try {
    assert.equal(herdr.managedCalls, 3);
    assert.equal(herdr.mismatchCalls, 1);
    const resource =
      broker.store.state.herdrResources?.[
        Object.keys(broker.store.state.herdrResources ?? {})[0]!
      ];
    assert.equal(resource?.state, "replaced");
    assert.equal(
      Object.values(broker.store.state.agents).some(
        (agent) => agent.state === "idle",
      ),
      false,
    );
    assert.equal(
      Object.values(broker.store.state.agents).every(
        (agent) => agent.state === "replaced",
      ),
      true,
    );
  } finally {
    await cleanup(root, broker, clients);
  }
});

test("managed response-boundary mismatch-recording failure remains stop-observable", async () => {
  const { root, broker, herdr, clients } = await managedCase(true);
  try {
    assert.equal(herdr.managedCalls, 3);
    assert.equal(herdr.mismatchCalls, 1);
    assert.equal(
      Object.values(broker.store.state.agents).every(
        (agent) => agent.state === "replaced",
      ),
      true,
    );
  } finally {
    await cleanup(
      root,
      broker,
      clients,
      /BOUNDARY_MISMATCH_RECORDING_SENTINEL/,
    );
  }
});
