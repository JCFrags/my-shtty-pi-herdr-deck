import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";
import { HerdrService } from "../../src/herdr/service.js";
import { brokerRequest } from "../../src/cli/client.js";

const actor = { principalId: "prn_00000000000000000000000000", kind: "system" };

test("M2 production broker and CLI registration proves proof, late deadline, and privacy boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-broker-registration-"));
  const prompts = join(root, "prompts");
  const paths = {
    root,
    runtime: join(root, "runtime"),
    events: join(root, "events.ndjson"),
    snapshot: join(root, "snapshot.json"),
    lock: join(root, "broker.lock"),
    socket: join(root, "broker.sock"),
    secret: join(root, "secret"),
  };
  let currentAgent = "";
  let closes = 0;
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-1", root_pane_id: "pane-1" }),
    startPi: async () => ({ pane_id: "pane-1" }),
    snapshot: async () => ({
      panes: [
        {
          id: "pane-1",
          terminalId: "terminal-1",
          occupant: {
            agentId: currentAgent,
            terminalId: "terminal-1",
            sessionId: "session-1",
            generation: 1,
          },
        },
      ],
      tabs: [{ id: "tab-1", panes: [{ id: "pane-1" }] }],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
    closePane: async () => {
      closes++;
    },
  } as never;
  const broker = new Broker(paths, {
    herdrFactory: async (store) =>
      new HerdrService({
        store,
        cli,
        provisioner: new HerdrProvisioner(
          cli,
          prompts,
          () => [],
          true,
          undefined,
          undefined,
          { validate: async () => undefined },
        ),
      }),
  });
  try {
    await broker.start();
    const agentId = "agent-broker-1";
    currentAgent = agentId;
    const provision = await request(broker, "provision", "herdr.provision", {
      agentId,
      parentAgentId: "parent-broker-1",
      role: "worker",
      workspaceId: "workspace-1",
      cwd: root,
      profileId: "test-runner",
      isolation: "shared-readonly",
      prompt: "broker private prompt",
    });
    assert.equal(provision.ok, true, JSON.stringify(provision));
    const digest = (provision.result as Record<string, unknown>).tokenDigest;
    assert.equal(typeof digest, "string");
    const tokenPath = (await readdir(prompts)).find((x) =>
      x.startsWith(".token-"),
    );
    assert.ok(tokenPath);
    const rawToken = (await readFile(join(prompts, tokenPath!), "utf8")).trim();
    const capture: string[] = [];
    const identityCases = [
      {
        paneId: "wrong-pane",
        terminalId: "terminal-1",
        sessionId: "session-1",
        generation: 1,
      },
      {
        paneId: "pane-1",
        terminalId: "wrong-terminal",
        sessionId: "session-1",
        generation: 1,
      },
      {
        paneId: "pane-1",
        terminalId: "terminal-1",
        sessionId: "wrong-session",
        generation: 1,
      },
      {
        paneId: "pane-1",
        terminalId: "terminal-1",
        sessionId: "session-1",
        generation: 2,
      },
    ];
    for (const [index, identity] of identityCases.entries()) {
      await assert.rejects(() =>
        brokerRequest(paths.socket, paths.secret, "herdr.register", {
          agentId,
          ...identity,
          tokenProof: digest,
        }),
      );
      const response = await request(
        broker,
        `wrong-identity-${index}`,
        "herdr.register",
        {
          agentId,
          ...identity,
          tokenProof: digest,
        },
        capture,
      );
      assert.equal(response.ok, false);
    }
    const wrong = await request(
      broker,
      "wrong-proof",
      "herdr.register",
      {
        agentId,
        paneId: "pane-1",
        terminalId: "terminal-1",
        sessionId: "session-1",
        generation: 1,
        tokenProof: "0".repeat(64),
      },
      capture,
    );
    assert.equal(wrong.ok, false);
    assert.equal((await readdir(prompts)).length, 2);
    assert.equal(
      capture.every((entry) => !entry.includes(rawToken)),
      true,
    );
    const registered = await brokerRequest(
      paths.socket,
      paths.secret,
      "herdr.register",
      {
        agentId,
        paneId: "pane-1",
        terminalId: "terminal-1",
        sessionId: "session-1",
        generation: 1,
        tokenProof: digest,
      },
    );
    assert.deepEqual(registered, { registered: true });
    assert.equal((await readdir(prompts)).length, 0);

    const lateId = "agent-broker-late";
    currentAgent = lateId;
    const lateProvision = await request(
      broker,
      "late-provision",
      "herdr.provision",
      {
        agentId: lateId,
        parentAgentId: "parent-broker-1",
        role: "worker",
        workspaceId: "workspace-1",
        cwd: root,
        profileId: "test-runner",
        isolation: "shared-readonly",
        prompt: "late prompt",
      },
    );
    const lateDigest = (lateProvision.result as Record<string, unknown>)
      .tokenDigest;
    await broker.store.append({
      type: "herdr.provision.outcome",
      actor,
      entityRefs: { agentId: lateId },
      payload: {
        agentId: lateId,
        state: "pending",
        registrationDeadline: new Date(0).toISOString(),
      },
    });
    const late = await request(
      broker,
      "late-register",
      "herdr.register",
      {
        agentId: lateId,
        paneId: "pane-1",
        terminalId: "terminal-1",
        sessionId: "session-1",
        generation: 1,
        tokenProof: lateDigest,
      },
      capture,
    );
    assert.equal(late.ok, false);
    assert.equal(late.ok, false);

    const closed = await request(broker, "close-1", "herdr.close", {
      paneId: "pane-1",
      terminalId: "terminal-1",
      sessionId: "session-1",
      generation: 1,
    });
    const repeated = await request(broker, "close-2", "herdr.close", {
      paneId: "pane-1",
      terminalId: "terminal-1",
      sessionId: "session-1",
      generation: 1,
    });
    assert.equal(closed.ok, true);
    assert.equal(repeated.ok, true);
    assert.equal(closes, 1);
    const events = await readFile(paths.events, "utf8");
    assert.doesNotMatch(events, new RegExp(rawToken));
    assert.doesNotMatch(events, /broker private prompt|late prompt/);
    assert.doesNotMatch(JSON.stringify(provision), new RegExp(rawToken));
  } finally {
    await broker.stop().catch(() => undefined);
  }
});

test("broker keeps status available with 16 long-lived clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "broker-client-capacity-"));
  const paths = {
    root,
    runtime: join(root, "runtime"),
    events: join(root, "events.ndjson"),
    snapshot: join(root, "snapshot.json"),
    lock: join(root, "broker.lock"),
    socket: join(root, "broker.sock"),
    secret: join(root, "secret"),
  };
  const broker = new Broker(paths);
  const clients: Socket[] = [];
  try {
    await broker.start();
    for (let index = 0; index < 16; index++)
      clients.push(await authenticatedClient(broker, `capacity-${index}`));

    const status = (await brokerRequest(
      paths.socket,
      paths.secret,
      "system.status",
      {},
    )) as Record<string, unknown>;
    assert.equal(status.status, "healthy");
  } finally {
    for (const client of clients) client.destroy();
    await broker.stop().catch(() => undefined);
  }
});

async function authenticatedClient(
  broker: Broker,
  id: string,
): Promise<Socket> {
  const socket = createConnection(broker.paths.socket);
  let buffer = "";
  const authenticated = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`authentication timeout: ${id}`)),
      2_000,
    );
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      const frame = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>;
      if (frame.type === "hello_result" && frame.ok === true) {
        clearTimeout(timer);
        resolve();
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new Error(`connection closed before authentication: ${id}`));
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    JSON.stringify({
      v: 1,
      type: "hello",
      id: `${id}-hello`,
      client: {
        kind: "cli",
        name: "m2-broker-capacity",
        version: "0.1.0",
        capabilities: [],
      },
      sessionKey: broker.paths.sessionKey,
      auth: { kind: "client_secret", secret: broker.secret },
    }) + "\n",
  );
  await authenticated;
  return socket;
}

async function request(
  broker: Broker,
  id: string,
  method: string,
  params: Record<string, unknown>,
  capture: string[] = [],
): Promise<Record<string, unknown>> {
  const socket = createConnection(broker.paths.socket);
  let buffer = "";
  const frames: Record<string, unknown>[] = [];
  const wait = (predicate: (frame: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout: ${id}`)),
        2_000,
      );
      const check = () => {
        const frame = frames.find(predicate);
        if (frame) {
          clearTimeout(timer);
          resolve(frame);
        }
      };
      (socket as Socket & { check?: () => void }).check = check;
      check();
    });
  socket.on("data", (data) => {
    buffer += data.toString("utf8");
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      frames.push(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
    (socket as Socket & { check?: () => void }).check?.();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    JSON.stringify({
      v: 1,
      type: "hello",
      id: `${id}-hello`,
      client: {
        kind: "cli",
        name: "m2-broker-adversarial",
        version: "0.1.0",
        capabilities: [],
      },
      sessionKey: broker.paths.sessionKey,
      auth: { kind: "client_secret", secret: broker.secret },
    }) + "\n",
  );
  await wait((frame) => frame.type === "hello_result" && frame.ok === true);
  const requestFrame = JSON.stringify({
    v: 1,
    type: "request",
    id,
    method,
    params,
  });
  capture.push(requestFrame);
  socket.write(requestFrame + "\n");
  const result = await wait(
    (frame) => frame.type === "response" && frame.id === id,
  );
  capture.push(JSON.stringify(result));
  socket.destroy();
  return result;
}
