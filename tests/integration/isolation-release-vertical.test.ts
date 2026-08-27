import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Broker } from "../../src/broker/broker.js";
import {
  derivedEndpointId,
  type EndpointPolicyConfig,
  type ModelIntelligenceConfig,
} from "../../src/broker/endpoint-policy.js";
import type { ModelPolicyConfig } from "../../src/broker/model-policy.js";
import { digest } from "../../src/broker/authentication.js";
import { PiAdapter } from "../../src/pi/adapter.js";
import { PiBrokerClient } from "../../src/pi/broker-client.js";
import { sessionKey } from "../../src/shared/paths.js";
import { canonicalJson, sha256 } from "../../src/shared/canonical-json.js";
import type { PiApiLike, PiContextLike } from "../../src/pi/types.js";
import { EventStore } from "../../src/state/event-store.js";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";
import { HerdrService } from "../../src/herdr/service.js";
import { normalizeSnapshot } from "../../src/herdr/normalizers.js";
import type { SchedulerLimits } from "../../src/scheduler/types.js";
import { validateAdvisoryModelReceipt } from "../../src/model-intelligence/model-ranking.js";
import { normalizeModelEvidence } from "../../src/model-intelligence/model-evidence.js";

const actor = {
  principalId: "prn_00000000000000000000000000",
  kind: "system" as const,
};

function boundedReceipt(
  store: EventStore,
  predicate: (event: unknown) => boolean,
) {
  let remove: () => void = () => undefined;
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<unknown>((resolve, reject) => {
    remove = store.onAppend((event) => {
      if (predicate(event)) {
        remove();
        if (timer) clearTimeout(timer);
        resolve(event);
      }
    });
    timer = setTimeout(() => {
      remove();
      reject(new Error("receipt timeout"));
    }, 5_000);
    timer.unref();
  });
  return {
    promise,
    remove: () => {
      remove();
      if (timer) clearTimeout(timer);
    },
  };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 5_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function productionParent(
  options: {
    resourceMode?: "missing" | "wrong-owner" | "stale";
    holdProvisions?: boolean;
    holdReuseProvisions?: boolean;
    failProvisionAt?: number;
    compactLifecycle?: boolean;
    compactEnabled?: boolean;
    modelPolicy?: ModelPolicyConfig;
    restartModelPolicy?: ModelPolicyConfig;
    schedulerLimits?: Partial<SchedulerLimits>;
    endpointPolicy?: EndpointPolicyConfig;
    modelIntelligence?: ModelIntelligenceConfig;
    realReconcileWorktree?:
      | "exact"
      | "missing"
      | "replaced"
      | "wrong-workspace"
      | "duplicate-exact-first"
      | "duplicate-conflict-first";
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "isolation-release-"));
  const runtime = await mkdtemp(join(tmpdir(), "isolation-release-runtime-"));
  const paths = {
    sessionKey: sessionKey(join(runtime, "broker.sock")),
    root,
    runtime,
    events: join(root, "events.jsonl"),
    snapshot: join(root, "snapshot.json"),
    lock: join(runtime, "lock"),
    socket: join(runtime, "broker.sock"),
    secret: join(runtime, "secret"),
  };
  const provisions: Array<Record<string, unknown>> = [];
  const metadataReports: unknown[] = [];
  const retainedExits: unknown[] = [];
  const retainedCloses: unknown[] = [];
  const children = new Map<string, PiBrokerClient>();
  type HeldProvision = {
    input: Record<string, unknown>;
    release: () => void;
  };
  const heldProvisions: HeldProvision[] = [];
  const provisionWaiters: Array<(entry: HeldProvision) => void> = [];
  const nextProvision = async (): Promise<HeldProvision> => {
    const existing = heldProvisions.shift();
    if (existing) return existing;
    return bounded(
      new Promise<HeldProvision>((resolve) => provisionWaiters.push(resolve)),
      "provision entry timeout",
    );
  };
  const previousEnv = {
    pane: process.env.HERDR_PANE_ID,
    terminal: process.env.HERDR_TERMINAL_ID,
    name: process.env.HERDR_AGENT_NAME,
  };
  process.env.HERDR_PANE_ID = "parent-pane";
  process.env.HERDR_TERMINAL_ID = "parent-terminal";
  process.env.HERDR_AGENT_NAME = "parent";
  let broker!: Broker;
  let herdrFactoryCalls = 0;
  const herdr = (store: EventStore, factoryCall: number) => ({
    get resources() {
      return store.state.herdrResources ?? {};
    },
    async startupReconcile() {
      if (!options.realReconcileWorktree || factoryCall === 1) return [];
      const resources = Object.values(store.state.herdrResources ?? {});
      const snapshot = normalizeSnapshot({
        panes: Object.values(store.state.agents)
          .filter((agent) => agent.paneId)
          .map((agent) => ({
            id: agent.paneId!,
            ...(agent.terminalId ? { terminalId: agent.terminalId } : {}),
            occupant: {
              agentId: agent.id,
              ...(agent.terminalId ? { terminalId: agent.terminalId } : {}),
              ...(agent.piSessionId ? { sessionId: agent.piSessionId } : {}),
              generation: agent.generation,
            },
          })),
        tabs: [],
        workspaces: [],
        agents: [],
        worktrees: resources.flatMap((resource) => {
          if (
            !resource.worktreeId ||
            !resource.worktreePath ||
            !resource.workspaceId ||
            options.realReconcileWorktree === "missing"
          )
            return [];
          const exact = {
            worktree_id: resource.worktreeId,
            path: resource.worktreePath,
            workspace_id: resource.workspaceId,
          };
          const conflict = {
            worktree_id: resource.worktreeId,
            path: `${resource.worktreePath}-conflict`,
            workspace_id: "wrong-workspace",
          };
          if (options.realReconcileWorktree === "duplicate-exact-first")
            return [exact, conflict];
          if (options.realReconcileWorktree === "duplicate-conflict-first")
            return [conflict, exact];
          return [
            {
              ...exact,
              path:
                options.realReconcileWorktree === "replaced"
                  ? `${resource.worktreePath}-replacement`
                  : exact.path,
              workspace_id:
                options.realReconcileWorktree === "wrong-workspace"
                  ? "wrong-workspace"
                  : exact.workspace_id,
            },
          ];
        }),
      });
      const service = new HerdrService({
        store,
        cli: { snapshot: async () => snapshot } as never,
        provisioner: {} as never,
      });
      return service.startupReconcile();
    },
    async verifyRoot(identity: { paneId: string; terminalId: string }) {
      return { ...identity, workspaceId: "parent-workspace", cwd: root };
    },
    async provision(input: Record<string, unknown>) {
      provisions.push({ ...input });
      const agentId = input.agentId as string;
      if (
        options.holdProvisions ||
        (options.holdReuseProvisions &&
          typeof input.reuseWorktreeId === "string")
      ) {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const entry = { input: { ...input }, release };
        const waiter = provisionWaiters.shift();
        if (waiter) waiter(entry);
        else heldProvisions.push(entry);
        await held;
      }
      if (options.failProvisionAt === provisions.length)
        throw new Error("held provision failed");
      await store.append({
        type: "herdr.provision.intent",
        actor,
        entityRefs: { agentId },
        payload: { agentId },
      });
      await store.append({
        type: "herdr.provision.outcome",
        actor,
        entityRefs: { agentId },
        payload: {
          agentId,
          state: options.resourceMode === "stale" ? "stale" : "registered",
          ownerId:
            options.resourceMode === "wrong-owner"
              ? "agt_wrong_owner"
              : agentId,
          parentAgentId: input.parentAgentId,
          ...((input.isolation === "worktree" ||
            typeof input.reuseWorktreeId === "string") &&
          options.resourceMode !== "missing"
            ? { workspaceId: input.workspaceId }
            : {}),
          tokenDigest: digest(`${agentId}-token`),
          sessionId: `session-${agentId}`,
          paneId: `pane-${agentId}`,
          ...(options.compactLifecycle
            ? {
                workspaceId: `workspace-${agentId}`,
                tabId: `tab-${agentId}`,
                terminalId: `terminal-${agentId}`,
              }
            : {}),
          ...((input.isolation === "worktree" ||
            typeof input.reuseWorktreeId === "string") &&
          options.resourceMode !== "missing"
            ? {
                worktreeId: input.reuseWorktreeId ?? `worktree-${agentId}`,
                worktreePath:
                  input.reuseWorktreePath ?? `/tmp/worktree-${agentId}`,
              }
            : {}),
          generation: 1,
        },
      });
      return {
        name: `child-${agentId}`,
        paneId: `pane-${agentId}`,
        ...(options.compactLifecycle
          ? {
              workspaceId: `workspace-${agentId}`,
              tabId: `tab-${agentId}`,
              terminalId: `terminal-${agentId}`,
            }
          : {}),
        ...((input.isolation === "worktree" ||
          typeof input.reuseWorktreeId === "string") &&
        options.resourceMode !== "missing"
          ? {
              worktreeId:
                (input.reuseWorktreeId as string | undefined) ??
                `worktree-${agentId}`,
              worktreePath:
                (input.reuseWorktreePath as string | undefined) ??
                `/tmp/worktree-${agentId}`,
            }
          : {}),
        token: {
          token: `${agentId}-token`,
          digest: digest(`${agentId}-token`),
          generation: 1,
        },
      };
    },
    async register(agentId: string, identity: Record<string, unknown>) {
      const resource = store.state.herdrResources?.[agentId];
      await store.append({
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
          ...(resource?.workspaceId
            ? { workspaceId: resource.workspaceId }
            : {}),
          ...(resource?.worktreeId ? { worktreeId: resource.worktreeId } : {}),
          ...(resource?.worktreePath
            ? { worktreePath: resource.worktreePath }
            : {}),
        },
      });
    },
    async verifyManagedPane(
      agentId: string,
      identity: { paneId: string; terminalId?: string },
    ) {
      const resource = store.state.herdrResources?.[agentId];
      return {
        paneId: identity.paneId,
        terminalId: identity.terminalId ?? resource?.terminalId,
        workspaceId: resource?.workspaceId,
        worktreeId: resource?.worktreeId,
        cwd: resource?.worktreePath ?? root,
      };
    },
    async reportTaskMetadata(_guard: unknown, metadata: unknown) {
      metadataReports.push(metadata);
    },
    async exitRetainingTab(guard: unknown) {
      if (
        !retainedExits.some(
          (prior) => JSON.stringify(prior) === JSON.stringify(guard),
        )
      )
        retainedExits.push(guard);
    },
    async closeRetainedTab(guard: unknown) {
      if (
        !retainedCloses.some(
          (prior) => JSON.stringify(prior) === JSON.stringify(guard),
        )
      )
        retainedCloses.push(guard);
    },
    async recordRegistrationMismatch(agentId: string) {
      const resource = store.state.herdrResources?.[agentId];
      await store.append({
        type: "herdr.provision.outcome",
        actor,
        entityRefs: { agentId },
        payload: {
          agentId,
          state: "replaced",
          reason: "registration_identity_mismatch",
          cleanupOutcome: "retained",
          unknown: true,
          ...(resource?.paneId ? { paneId: resource.paneId } : {}),
        },
      });
    },
  });
  broker = new Broker(paths, {
    herdrFactory: async (store) => herdr(store, ++herdrFactoryCalls) as never,
    ...(options.compactEnabled !== undefined
      ? { compactDelegationEnabled: options.compactEnabled }
      : {}),
    ...(options.modelPolicy ? { modelPolicy: options.modelPolicy } : {}),
    ...(options.schedulerLimits
      ? { schedulerLimits: options.schedulerLimits }
      : {}),
    ...(options.endpointPolicy
      ? { endpointPolicy: options.endpointPolicy }
      : {}),
    ...(options.modelIntelligence
      ? { modelIntelligence: options.modelIntelligence }
      : {}),
  });
  await broker.start();
  const secret = (await readFile(paths.secret, "utf8")).trim();
  const api: PiApiLike = {
    on: () => undefined,
    registerCommand: () => undefined,
    sendUserMessage: async () => undefined,
    getActiveTools: () => [],
  };
  const context: PiContextLike = {
    ui: {},
    cwd: root,
    sessionManager: { getSessionId: () => "parent-session" },
    modelRegistry: {},
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => undefined,
    compact: (o) => o?.onComplete?.(),
    model: { provider: "test", id: "test", name: "test" },
    thinkingLevel: "medium",
  };
  const adapter = new PiAdapter(api, context, "pending-parent", 1);
  let client = new PiBrokerClient({
    socketPath: paths.socket,
    sessionKey: paths.sessionKey!,
    piSessionId: "parent-session",
    secret,
  });
  await client.connect();
  const registered = await client.register(adapter.safeState());
  adapter.bindIdentity(
    registered.agentId,
    registered.generation,
    registered.connectionGeneration,
  );
  client.markRegistrationReady();
  const restart = async () => {
    client.close();
    await broker.stop();
    broker = new Broker(paths, {
      herdrFactory: async (store) => herdr(store, ++herdrFactoryCalls) as never,
      ...(options.compactEnabled !== undefined
        ? { compactDelegationEnabled: options.compactEnabled }
        : {}),
      ...((options.restartModelPolicy ?? options.modelPolicy)
        ? { modelPolicy: options.restartModelPolicy ?? options.modelPolicy }
        : {}),
      ...(options.schedulerLimits
        ? { schedulerLimits: options.schedulerLimits }
        : {}),
      ...(options.endpointPolicy
        ? { endpointPolicy: options.endpointPolicy }
        : {}),
      ...(options.modelIntelligence
        ? { modelIntelligence: options.modelIntelligence }
        : {}),
    });
    await broker.start();
    const nextSecret = (await readFile(paths.secret, "utf8")).trim();
    client = new PiBrokerClient({
      socketPath: paths.socket,
      sessionKey: paths.sessionKey!,
      piSessionId: "parent-session-restarted",
      secret: nextSecret,
    });
    await client.connect();
    const nextRegistered = await client.register(adapter.safeState());
    adapter.bindIdentity(
      nextRegistered.agentId,
      nextRegistered.generation,
      nextRegistered.connectionGeneration,
    );
    client.markRegistrationReady();
    return { broker, client };
  };
  return {
    get broker() {
      return broker;
    },
    get client() {
      return client;
    },
    restart,
    nextProvision,
    paths,
    provisions,
    metadataReports,
    retainedExits,
    retainedCloses,
    children,
    registered,
    cleanup: async () => {
      for (const entry of heldProvisions.splice(0)) entry.release();
      const errors: unknown[] = [];
      const attempt = async (action: () => void | Promise<void>) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      for (const child of children.values()) await attempt(() => child.close());
      await attempt(() => client.close());
      await attempt(() => broker.stop());
      await attempt(() => {
        if (previousEnv.pane === undefined) delete process.env.HERDR_PANE_ID;
        else process.env.HERDR_PANE_ID = previousEnv.pane;
        if (previousEnv.terminal === undefined)
          delete process.env.HERDR_TERMINAL_ID;
        else process.env.HERDR_TERMINAL_ID = previousEnv.terminal;
        if (previousEnv.name === undefined) delete process.env.HERDR_AGENT_NAME;
        else process.env.HERDR_AGENT_NAME = previousEnv.name;
      });
      await attempt(() => rm(root, { recursive: true, force: true }));
      await attempt(() => rm(runtime, { recursive: true, force: true }));
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, "Isolation test teardown failed.");
    },
  };
}

async function connectManagedChild(
  h: Awaited<ReturnType<typeof productionParent>>,
  agentId: string,
): Promise<void> {
  const child = new PiBrokerClient({
    socketPath: h.paths.socket,
    sessionKey: h.paths.sessionKey!,
    agentId,
    generation: 1,
    piSessionId: `session-${agentId}`,
    token: `${agentId}-token`,
    onServerRequest: async (request) =>
      request.method === "assignment.deliver"
        ? { status: "accepted" }
        : { accepted: true },
  });
  await child.connect();
  await child.register({
    agentId,
    generation: 1,
    sessionId: `session-${agentId}`,
    idle: true,
    pendingMessages: 0,
    activity: "idle",
    activeTools: [],
    model: {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
      name: "gpt-5.6-luna",
    },
    thinkingLevel: "medium",
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
      toolExpansion: true,
    },
  });
  child.markRegistrationReady();
  h.children.set(agentId, child);
}

async function publishManagedResult(
  h: Awaited<ReturnType<typeof productionParent>>,
  agentId: string,
): Promise<void> {
  const child = h.children.get(agentId);
  const agent = h.broker.store.state.agents[agentId];
  const run = agent?.currentRunId
    ? h.broker.store.state.runs[agent.currentRunId]
    : undefined;
  assert.ok(child && run);
  await child.request("result.publish", {
    agentId,
    taskId: run.taskId,
    runId: run.id,
    assignmentGeneration: run.assignmentGeneration,
    result: {
      schemaVersion: 1,
      status: "succeeded",
      summary: `completed ${agentId}`,
      findings: [],
      changedFiles: [],
      commandsRun: [],
      tests: [],
      commits: [],
      artifacts: [],
      unresolved: [],
      questions: [],
      recommendedNextAction: null,
    },
  });
}

async function completeManagedChild(
  h: Awaited<ReturnType<typeof productionParent>>,
  agentId: string,
  publishResult = true,
): Promise<void> {
  const child = h.children.get(agentId);
  const agent = h.broker.store.state.agents[agentId];
  const run = agent?.currentRunId
    ? h.broker.store.state.runs[agent.currentRunId]
    : undefined;
  assert.ok(child && agent && run && run.assignmentId);
  if (run.assignmentDeliveryState !== "accepted") {
    const receipt = boundedReceipt(h.broker.store, (event) => {
      const value = event as {
        type?: string;
        entityRefs?: Record<string, unknown>;
      };
      return (
        value.type === "assignment.accepted" &&
        value.entityRefs?.runId === run.id
      );
    });
    await receipt.promise;
    receipt.remove();
  }
  const assignment = {
    assignmentId: run.assignmentId,
    generation: run.assignmentGeneration,
  };
  const base = {
    agentId,
    connectionGeneration: agent.connectionGeneration,
    piSessionId: agent.piSessionId,
    assignment,
    safeData: { toolName: null, contextPercent: null },
  };
  await child.request("agent.lifecycle_event", {
    ...base,
    adapterSeq: 1,
    event: "turn_start",
    turnIndex: 0,
    agentCycleId: `cycle-${agentId}`,
  });
  await child.request("agent.lifecycle_event", {
    ...base,
    adapterSeq: 2,
    event: "agent_settled",
    turnIndex: 0,
    agentCycleId: `cycle-${agentId}`,
  });
  if (!publishResult) return;
  await publishManagedResult(h, agentId);
}

test("production agent.spawn preserves explicit worktree through exact receipts", async () => {
  const h = await productionParent({ holdProvisions: true });
  const taskReceipt = boundedReceipt(h.broker.store, (event) => {
    const value = event as {
      type?: string;
      payload?: Record<string, unknown>;
    };
    return (
      value.type === "task.created_m3" &&
      value.payload?.title === "owned-spawn-worktree" &&
      value.payload?.objective === "owned-spawn-worktree" &&
      value.payload?.parentAgentId === h.registered.agentId
    );
  });
  const owned: Array<ReturnType<typeof boundedReceipt>> = [taskReceipt];
  try {
    const modelOptions = (await h.client.request("model.options", {
      profileId: "implementer",
      limit: 5,
    })) as Record<string, unknown>;
    assert.equal(modelOptions.mode, "current_default");
    assert.ok(Array.isArray(modelOptions.candidates));
    assert.ok(modelOptions.candidates.length >= 1);
    const responsePromise = h.client.request("agent.spawn", {
      task: {
        title: "owned-spawn-worktree",
        objective: "owned-spawn-worktree",
      },
      profileId: "implementer",
      isolation: { mode: "worktree" },
      wait: false,
      dryRun: false,
    }) as Promise<{ tasks: Array<{ taskId: string }> }>;
    const entered = await h.nextProvision();
    assert.equal(entered.input.profileId, "implementer");
    assert.equal(entered.input.isolation, "worktree");
    const agentId = entered.input.agentId as string;
    const intent = boundedReceipt(
      h.broker.store,
      (event) =>
        (event as { type?: string; entityRefs?: Record<string, unknown> })
          .type === "herdr.provision.intent" &&
        (event as { entityRefs?: Record<string, unknown> }).entityRefs
          ?.agentId === agentId,
    );
    const outcome = boundedReceipt(
      h.broker.store,
      (event) =>
        (event as { type?: string; entityRefs?: Record<string, unknown> })
          .type === "herdr.provision.outcome" &&
        (event as { entityRefs?: Record<string, unknown> }).entityRefs
          ?.agentId === agentId,
    );
    owned.push(intent, outcome);
    entered.release();
    const [response, created] = await Promise.all([
      responsePromise,
      taskReceipt.promise,
      intent.promise,
      outcome.promise,
    ]).then(([response, created]) => [response, created] as const);
    const taskId = response.tasks[0]!.taskId;
    assert.equal(
      (created as { entityRefs?: Record<string, unknown> }).entityRefs?.taskId,
      taskId,
    );
    const task = h.broker.store.state.tasks[taskId];
    assert.equal(task?.project?.isolation, "worktree");
    const advisory = validateAdvisoryModelReceipt(
      task?.project?.advisoryModelReceipt,
    );
    assert.deepEqual(
      advisory.selectedModel,
      task?.project?.effectiveSpawnPolicy &&
        (task.project.effectiveSpawnPolicy as Record<string, unknown>).model,
    );
    assert.equal(advisory.mode, "current_default");
    assert.equal(
      task?.currentRunId
        ? h.broker.store.state.runs[task.currentRunId]?.agentId
        : undefined,
      agentId,
    );
  } finally {
    for (const receipt of owned) receipt.remove();
    await h.cleanup();
  }
});

test("rated automatic spawn selects only an evidenced unique leader and keeps explicit precedence", async () => {
  const luna = {
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
    thinkingLevel: "medium" as const,
  };
  const sol = {
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
    thinkingLevel: "medium" as const,
  };
  const h = await productionParent({
    holdProvisions: true,
    modelPolicy: {
      defaults: { global: luna },
      allowlist: [luna, sol],
    },
    modelIntelligence: {
      schemaVersion: 1,
      routingMode: "rated_auto",
      mappings: [],
    },
  });
  try {
    const spawn = async (model?: typeof luna) => {
      const responsePromise = h.client.request("agent.spawn", {
        task: { title: "rated-spawn", objective: "rated-spawn" },
        profileId: "implementer",
        ...(model ? { model } : {}),
        isolation: { mode: "worktree" },
        wait: false,
        dryRun: false,
      }) as Promise<{ tasks: Array<{ taskId: string }> }>;
      const entered = await h.nextProvision();
      entered.release();
      return await responsePromise;
    };

    const fallback = await spawn();
    const fallbackTask = h.broker.store.state.tasks[fallback.tasks[0]!.taskId]!;
    const fallbackReceipt = validateAdvisoryModelReceipt(
      fallbackTask.project?.advisoryModelReceipt,
    );
    assert.deepEqual(
      (fallbackTask.project?.effectiveSpawnPolicy as { model: unknown }).model,
      luna,
    );
    assert.equal(fallbackReceipt.mode, "rated_auto");
    assert.equal(fallbackReceipt.selectionReason, "insufficient_evidence");

    const record = normalizeModelEvidence({
      schemaVersion: 1,
      evidenceKind: "score",
      sourceKind: "human",
      sourceName: "operator:test",
      sourceKey: "rated-auto-sol-quality",
      taskProfile: "implementer",
      subject: {
        kind: "runtime",
        ...sol,
        endpointId: derivedEndpointId(sol.provider),
      },
      sampleCount: 4,
      observedAt: "2026-08-26T00:00:00.000Z",
      expiresAt: "2027-08-26T00:00:00.000Z",
      dimension: "reviewed_output_quality",
      valuePpm: 950_000,
      confidencePpm: 1_000_000,
    });
    await h.broker.store.append({
      type: "model.evidence_recorded",
      actor,
      entityRefs: {},
      payload: { record },
    });

    const automatic = await spawn();
    const automaticTaskId = automatic.tasks[0]!.taskId;
    const automaticTask = h.broker.store.state.tasks[automaticTaskId]!;
    const automaticReceipt = validateAdvisoryModelReceipt(
      automaticTask.project?.advisoryModelReceipt,
    );
    assert.deepEqual(
      (automaticTask.project?.effectiveSpawnPolicy as { model: unknown }).model,
      sol,
    );
    assert.equal(
      (automaticTask.project?.requestedSpawnPolicy as { model?: unknown })
        .model,
      undefined,
    );
    assert.equal(automaticReceipt.mode, "rated_auto");
    assert.equal(automaticReceipt.selectionReason, "rated_auto");

    await h.restart();
    assert.deepEqual(
      validateAdvisoryModelReceipt(
        h.broker.store.state.tasks[automaticTaskId]?.project
          ?.advisoryModelReceipt,
      ),
      automaticReceipt,
    );

    const explicit = await spawn(luna);
    const explicitTask = h.broker.store.state.tasks[explicit.tasks[0]!.taskId]!;
    const explicitReceipt = validateAdvisoryModelReceipt(
      explicitTask.project?.advisoryModelReceipt,
    );
    assert.deepEqual(
      (explicitTask.project?.effectiveSpawnPolicy as { model: unknown }).model,
      luna,
    );
    assert.equal(explicitReceipt.selectionReason, "explicit_override");
  } finally {
    await h.cleanup();
  }
});

test("compact rollback switch rejects new work without task or resource creation", async () => {
  const h = await productionParent({ compactEnabled: false });
  try {
    const tasks = Object.keys(h.broker.store.state.tasks).length;
    await assert.rejects(
      h.client.request("compact.delegate", {
        text: "- [ ] blocked: Must not schedule",
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "PERMISSION_DENIED",
    );
    assert.equal(Object.keys(h.broker.store.state.tasks).length, tasks);
    assert.equal(h.provisions.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("compact broker preview is mutation-free and acceptance uses the existing delegation path", async () => {
  const h = await productionParent({ holdProvisions: true });
  try {
    const before = h.broker.store.state.lastEventSeq;
    const text = [
      "- [ ] implement: Implement safely [profile:implementer] [mode:write]",
      "- [ ] review: Review independently [profile:reviewer] [mode:read]",
    ].join("\n");
    const preview = (await h.client.request("compact.delegate", {
      text,
      accept: false,
    })) as {
      workflowDigest: string;
      stepCount: number;
      steps: Array<{ isolation: string }>;
    };
    assert.equal(preview.stepCount, 2);
    assert.deepEqual(
      preview.steps.map((step) => step.isolation),
      ["worktree", "shared-readonly"],
    );
    assert.equal(h.broker.store.state.lastEventSeq, before);

    const accepted = h.client.request(
      "compact.delegate",
      {
        text,
        accept: true,
        workflowDigest: preview.workflowDigest,
        parentAgentId: h.registered.agentId,
      },
      { idempotencyKey: "compact-preview-accept" },
    ) as Promise<{ tasks: Array<{ taskId: string }> }>;
    for (const [profileId, isolation] of [
      ["implementer", "worktree"],
      ["reviewer", "shared-readonly"],
    ] as const) {
      const entered = await h.nextProvision();
      assert.equal(entered.input.profileId, profileId);
      assert.equal(entered.input.isolation, isolation);
      entered.release();
    }
    const response = await accepted;
    assert.equal(response.tasks.length, 2);
    for (const task of response.tasks) {
      const compact = h.broker.store.state.tasks[task.taskId]?.project
        ?.compact as Record<string, unknown> | undefined;
      assert.equal(compact?.workflowDigest, preview.workflowDigest);
      assert.equal(compact?.transcriptPolicy, "retain-tab");
      assert.equal(
        validateAdvisoryModelReceipt(
          h.broker.store.state.tasks[task.taskId]?.project
            ?.advisoryModelReceipt,
        ).mode,
        "current_default",
      );
    }
  } finally {
    await h.cleanup();
  }
});

test("compact preview binds effective model policy and rejects restart drift", async () => {
  const changedSubagent = {
    provider: "openai-codex",
    modelId: "gpt-5.6-luna-policy-change",
    thinkingLevel: "medium" as const,
  };
  const h = await productionParent({
    restartModelPolicy: {
      profiles: { subagent: changedSubagent },
      allowlist: [
        changedSubagent,
        {
          provider: "openai-codex",
          modelId: "gpt-5.6-sol",
          thinkingLevel: "medium",
        },
      ],
    },
  });
  try {
    const text = "- [ ] bind: Bind policy [profile:reviewer] [mode:read]";
    const preview = (await h.client.request("compact.delegate", { text })) as {
      workflowDigest: string;
      steps: Array<Record<string, unknown>>;
    };
    assert.deepEqual(Object.keys(preview.steps[0]!).sort(), [
      "dependencyIds",
      "id",
      "isolation",
      "mode",
      "placement",
      "profileId",
    ]);
    assert.deepEqual(preview.steps[0], {
      id: "bind",
      profileId: "reviewer",
      mode: "read",
      dependencyIds: [],
      placement: "current-workspace",
      isolation: "shared-readonly",
    });
    const serializedPreview = JSON.stringify(preview);
    assert.equal(serializedPreview.includes(h.registered.agentId), false);
    assert.equal(serializedPreview.includes("parent-workspace"), false);
    assert.equal(serializedPreview.includes(h.paths.root), false);
    assert.equal(serializedPreview.includes("modelPolicyHash"), false);
    assert.equal(serializedPreview.includes("admissionSnapshot"), false);
    await h.restart();
    await assert.rejects(
      h.client.request(
        "compact.delegate",
        {
          text,
          accept: true,
          workflowDigest: preview.workflowDigest,
          parentAgentId: h.registered.agentId,
        },
        { idempotencyKey: "compact-policy-drift" },
      ),
      (error: unknown) =>
        (error as { code?: string }).code === "INVALID_REQUEST",
    );
    assert.equal(Object.keys(h.broker.store.state.workflows).length, 0);
    assert.equal(Object.keys(h.broker.store.state.tasks).length, 0);
    assert.equal(h.provisions.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("compact acceptance rejects authenticated parent context drift before mutation", async () => {
  const h = await productionParent();
  try {
    const text =
      "- [ ] bind: Bind parent policy context [profile:reviewer] [mode:read]";
    const preview = (await h.client.request("compact.delegate", { text })) as {
      workflowDigest: string;
    };
    const parent = h.broker.store.state.agents[h.registered.agentId]!;
    parent.generation += 1;
    parent.workspaceId = "parent-workspace-replaced";
    await assert.rejects(
      h.client.request(
        "compact.delegate",
        {
          text,
          accept: true,
          workflowDigest: preview.workflowDigest,
          parentAgentId: h.registered.agentId,
        },
        { idempotencyKey: "compact-parent-policy-drift" },
      ),
      (error: unknown) =>
        (error as { code?: string }).code === "INVALID_REQUEST",
    );
    assert.equal(Object.keys(h.broker.store.state.workflows).length, 0);
    assert.equal(Object.keys(h.broker.store.state.tasks).length, 0);
    assert.equal(h.provisions.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("compact acceptance rejects live admission drift before its first mutation", async () => {
  const h = await productionParent();
  try {
    const text =
      "- [ ] bind: Bind live admission [profile:reviewer] [mode:read]";
    const preview = (await h.client.request("compact.delegate", { text })) as {
      workflowDigest: string;
    };
    const existingTaskCount = Object.keys(h.broker.store.state.tasks).length;
    h.broker.store.state.tasks.tsk_admission_drift = {
      id: "tsk_admission_drift",
      title: "Existing queued work",
      objective: "Existing queued work",
      state: "queued",
      createdAt: "2026-08-19T00:00:00.000Z",
      parentAgentId: h.registered.agentId,
    };
    await assert.rejects(
      h.client.request(
        "compact.delegate",
        {
          text,
          accept: true,
          workflowDigest: preview.workflowDigest,
          parentAgentId: h.registered.agentId,
        },
        { idempotencyKey: "compact-live-admission-drift" },
      ),
      (error: unknown) =>
        (error as { code?: string }).code === "INVALID_REQUEST",
    );
    assert.equal(
      Object.keys(h.broker.store.state.tasks).length,
      existingTaskCount + 1,
    );
    assert.equal(Object.keys(h.broker.store.state.workflows).length, 0);
    assert.equal(h.provisions.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("compact preview and replay preserve endpoint capacity without duplicate provision", async () => {
  const h = await productionParent({
    holdProvisions: true,
    schedulerLimits: {
      maxActiveAgents: 4,
      maxActivePerParent: 4,
      maxProvisioning: 2,
    },
    endpointPolicy: {
      endpoints: { local: { maxConcurrentAgents: 1 } },
      mappings: [{ provider: "openai-codex", endpointId: "local" }],
    },
  });
  try {
    const text = [
      "- [ ] first: Compact capacity first [profile:implementer] [mode:write]",
      "- [ ] second: Compact capacity second [profile:reviewer] [mode:read]",
    ].join("\n");
    const preview = (await h.client.request("compact.delegate", { text })) as {
      workflowDigest: string;
      stepCount: number;
    };
    assert.equal(preview.stepCount, 2);
    assert.equal(Object.keys(h.broker.store.state.tasks).length, 0);
    assert.equal(h.provisions.length, 0);

    const params = {
      text,
      accept: true,
      workflowDigest: preview.workflowDigest,
      parentAgentId: h.registered.agentId,
    };
    const options = { idempotencyKey: "compact-endpoint-capacity-replay" };
    const accepted = h.client.request("compact.delegate", params, options);
    (await h.nextProvision()).release();
    const frozen = await accepted;
    const tasks = Object.values(h.broker.store.state.tasks);
    assert.equal(tasks.length, 2);
    assert.equal(h.provisions.length, 1);
    assert.equal(
      tasks.filter((task) => task.admissionReason === "endpoint_capacity")
        .length,
      1,
    );

    await h.restart();
    const replay = await h.client.request("compact.delegate", params, options);
    assert.deepEqual(replay, frozen);
    assert.equal(h.provisions.length, 1);
    assert.equal(
      Object.values(h.broker.store.state.tasks).filter(
        (task) => task.admissionReason === "endpoint_capacity",
      ).length,
      1,
    );
  } finally {
    await h.cleanup();
  }
});

test("committed compact retry returns its frozen response after policy drift", async () => {
  const changedSubagent = {
    provider: "openai-codex",
    modelId: "gpt-5.6-luna-policy-change",
    thinkingLevel: "medium" as const,
  };
  const h = await productionParent({
    holdProvisions: true,
    restartModelPolicy: {
      profiles: { subagent: changedSubagent },
      allowlist: [
        changedSubagent,
        {
          provider: "openai-codex",
          modelId: "gpt-5.6-sol",
          thinkingLevel: "medium",
        },
      ],
    },
  });
  try {
    const text = "- [ ] once: Freeze once [profile:reviewer] [mode:read]";
    const preview = (await h.client.request("compact.delegate", { text })) as {
      workflowDigest: string;
    };
    const params = {
      text,
      accept: true,
      workflowDigest: preview.workflowDigest,
      parentAgentId: h.registered.agentId,
    };
    const options = { idempotencyKey: "compact-frozen-policy-replay" };
    const accepted = h.client.request("compact.delegate", params, options);
    (await h.nextProvision()).release();
    const frozen = await accepted;
    await h.restart();
    assert.deepEqual(
      await h.client.request("compact.delegate", params, options),
      frozen,
    );
    assert.equal(Object.keys(h.broker.store.state.workflows).length, 1);
    assert.equal(Object.keys(h.broker.store.state.tasks).length, 1);
    assert.equal(h.provisions.length, 1);
    await assert.rejects(
      h.client.request(
        "compact.delegate",
        { ...params, timeoutMs: 1 },
        options,
      ),
      (error: unknown) =>
        (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await h.cleanup();
  }
});

test("accepted compact delegation coalesces concurrent retries and survives restart", async () => {
  const h = await productionParent({ holdProvisions: true });
  try {
    const text =
      "- [ ] once: Create exactly once [profile:implementer] [mode:write]";
    const preview = (await h.client.request("compact.delegate", { text })) as {
      workflowDigest: string;
    };
    const params = {
      text,
      accept: true,
      workflowDigest: preview.workflowDigest,
      parentAgentId: h.registered.agentId,
    };
    const options = { idempotencyKey: "compact-concurrent-restart" };
    const first = h.client.request("compact.delegate", params, options);
    const second = h.client.request("compact.delegate", params, options);
    const entered = await h.nextProvision();
    entered.release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.deepEqual(secondResponse, firstResponse);
    assert.equal(Object.keys(h.broker.store.state.workflows).length, 1);
    assert.equal(Object.keys(h.broker.store.state.tasks).length, 1);
    assert.equal(h.provisions.length, 1);

    await h.restart();
    const replay = await h.client.request("compact.delegate", params, options);
    assert.deepEqual(replay, firstResponse);
    assert.equal(Object.keys(h.broker.store.state.workflows).length, 1);
    assert.equal(h.provisions.length, 1);
    await assert.rejects(
      h.client.request(
        "compact.delegate",
        { ...params, timeoutMs: 123 },
        options,
      ),
      (error: unknown) =>
        (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await h.cleanup();
  }
});

test("compact lifecycle persists safe final metadata and closes the retained tab idempotently", async () => {
  const h = await productionParent({
    holdProvisions: true,
    compactLifecycle: true,
  });
  let finalReceipt: ReturnType<typeof boundedReceipt> | undefined;
  try {
    const text =
      "- [ ] finish: Finish the bounded canary [profile:implementer] [mode:write]";
    const preview = (await h.client.request("compact.delegate", {
      text,
    })) as { workflowDigest: string };
    const accepted = h.client.request(
      "compact.delegate",
      {
        text,
        accept: true,
        workflowDigest: preview.workflowDigest,
        parentAgentId: h.registered.agentId,
      },
      { idempotencyKey: "compact-lifecycle-accept" },
    ) as Promise<{
      tasks: Array<{ taskId: string; runId: string; agentId: string }>;
    }>;
    const entered = await h.nextProvision();
    entered.release();
    const response = await accepted;
    const scheduled = response.tasks[0]!;
    const taskState = h.broker.store.state.tasks[scheduled.taskId]!;
    const runState = h.broker.store.state.runs[taskState.currentRunId!]!;
    const task = {
      ...scheduled,
      runId: runState.id,
      agentId: runState.agentId!,
    };
    await connectManagedChild(h, task.agentId);
    finalReceipt = boundedReceipt(h.broker.store, (event) => {
      const candidate = event as {
        type?: string;
        entityRefs?: Record<string, unknown>;
        payload?: Record<string, unknown>;
      };
      return (
        candidate.type === "herdr.metadata_projected" &&
        candidate.entityRefs?.taskId === task.taskId &&
        candidate.payload?.state === "completed" &&
        typeof candidate.payload?.exitedAt === "string" &&
        typeof candidate.payload?.transcriptRef === "string"
      );
    });
    await completeManagedChild(h, task.agentId);
    await finalReceipt.promise;

    const metadata = (await h.client.request("metadata.get", {
      taskId: task.taskId,
    })) as Record<string, unknown>;
    assert.equal(metadata.state, "completed");
    assert.equal(metadata.resultRef !== null, true);
    assert.match(String(metadata.transcriptRef), /^trn_[a-f0-9]{26}$/u);
    assert.match(String(metadata.piSessionRef), /^pis_[a-f0-9]{26}$/u);
    const serialized = JSON.stringify(metadata);
    assert.equal(serialized.includes(text), false);
    assert.equal(serialized.includes(`session-${task.agentId}`), false);
    assert.equal(h.retainedExits.length, 1);
    assert.ok(h.metadataReports.length >= 1);

    const close = await h.client.request("transcript.close", {
      taskId: task.taskId,
      confirm: true,
    });
    assert.equal((close as { state: string }).state, "closed");
    const repeated = await h.client.request("transcript.close", {
      taskId: task.taskId,
      confirm: true,
    });
    assert.deepEqual(repeated, close);
    assert.equal(h.retainedCloses.length, 1);
  } finally {
    finalReceipt?.remove();
    await h.cleanup();
  }
});

test("compact metadata retrieves, replays, and closes exact runs after task retry", async () => {
  const h = await productionParent({
    holdProvisions: true,
    compactLifecycle: true,
  });
  let firstReceipt: ReturnType<typeof boundedReceipt> | undefined;
  let secondReceipt: ReturnType<typeof boundedReceipt> | undefined;
  try {
    const text =
      "- [ ] retry: Preserve both run projections [profile:implementer] [mode:write]";
    const preview = (await h.client.request("compact.delegate", { text })) as {
      workflowDigest: string;
    };
    const accepted = h.client.request(
      "compact.delegate",
      {
        text,
        accept: true,
        workflowDigest: preview.workflowDigest,
        parentAgentId: h.registered.agentId,
      },
      { idempotencyKey: "compact-two-run-metadata" },
    ) as Promise<{ tasks: Array<{ taskId: string }> }>;
    (await h.nextProvision()).release();
    const taskId = (await accepted).tasks[0]!.taskId;
    const task = h.broker.store.state.tasks[taskId]!;
    const firstRunId = task.currentRunId!;
    firstReceipt = boundedReceipt(h.broker.store, (event) => {
      const candidate = event as {
        type?: string;
        entityRefs?: Record<string, unknown>;
      };
      return (
        candidate.type === "herdr.metadata_projected" &&
        candidate.entityRefs?.runId === firstRunId
      );
    });
    const existingFirst = Object.values(
      h.broker.store.state.herdrMetadata ?? {},
    ).find((item) => item.runId === firstRunId);
    if (!existingFirst) await firstReceipt.promise;
    else firstReceipt.remove();
    const first = Object.values(h.broker.store.state.herdrMetadata ?? {}).find(
      (item) => item.runId === firstRunId,
    )!;
    h.broker.store.state.runs[firstRunId]!.state = "succeeded";
    h.broker.store.state.runs[firstRunId]!.settled = true;
    const secondRunId = `run_${"8".repeat(26)}`;
    secondReceipt = boundedReceipt(h.broker.store, (event) => {
      const candidate = event as {
        type?: string;
        entityRefs?: Record<string, unknown>;
      };
      return (
        candidate.type === "herdr.metadata_projected" &&
        candidate.entityRefs?.runId === secondRunId
      );
    });
    await h.broker.store.append({
      type: "run.created",
      actor,
      entityRefs: { taskId, runId: secondRunId, agentId: first.agentId },
      payload: {
        runId: secondRunId,
        taskId,
        agentId: first.agentId,
        assignmentId: `asg_${"9".repeat(26)}`,
        assignmentGeneration: 2,
        agentGeneration: 1,
      },
    });
    await secondReceipt.promise;

    const exitedAt = "2026-08-19T01:00:00.000Z";
    const retained = {
      ...first,
      state: "completed" as const,
      updatedAt: exitedAt,
      settledAt: exitedAt,
      exitedAt,
      transcriptRef: `trn_${sha256(firstRunId).slice(0, 26)}`,
    };
    delete (retained as Partial<typeof first>).metadataDigest;
    await h.broker.store.append({
      type: "herdr.metadata_projected",
      actor,
      entityRefs: {
        workflowId: first.workflowId,
        taskId,
        runId: firstRunId,
        agentId: first.agentId,
        workflowDigest: preview.workflowDigest,
      },
      payload: {
        ...retained,
        metadataDigest: sha256(canonicalJson(retained)),
      },
    });

    const current = (await h.client.request("metadata.get", {
      taskId,
    })) as { runId: string };
    assert.equal(current.runId, secondRunId);
    const historical = (await h.client.request("metadata.get", {
      taskId,
      runId: firstRunId,
    })) as { runId: string; state: string };
    assert.equal(historical.runId, firstRunId);
    assert.equal(historical.state, "completed");
    const close = await h.client.request("transcript.close", {
      taskId,
      runId: firstRunId,
      confirm: true,
    });
    assert.equal((close as { state: string }).state, "closed");
    assert.deepEqual(
      await h.client.request("transcript.close", {
        taskId,
        runId: firstRunId,
        confirm: true,
      }),
      close,
    );
    assert.equal(h.retainedCloses.length, 1);

    await h.restart();
    assert.equal(
      (
        (await h.client.request("metadata.get", {
          taskId,
          runId: firstRunId,
        })) as { state: string }
      ).state,
      "closed",
    );
    assert.equal(
      (
        (await h.client.request("metadata.get", {
          taskId,
          runId: secondRunId,
        })) as { runId: string }
      ).runId,
      secondRunId,
    );
  } finally {
    firstReceipt?.remove();
    secondReceipt?.remove();
    await h.cleanup();
  }
});

test("retained close append failure converges after restart without a second mutation", async () => {
  const h = await productionParent({
    holdProvisions: true,
    compactLifecycle: true,
  });
  let finalReceipt: ReturnType<typeof boundedReceipt> | undefined;
  try {
    const text =
      "- [ ] close: Prove close recovery [profile:implementer] [mode:write]";
    const preview = (await h.client.request("compact.delegate", { text })) as {
      workflowDigest: string;
    };
    const accepted = h.client.request(
      "compact.delegate",
      {
        text,
        accept: true,
        workflowDigest: preview.workflowDigest,
        parentAgentId: h.registered.agentId,
      },
      { idempotencyKey: "compact-close-append-failure" },
    ) as Promise<{
      tasks: Array<{ taskId: string; runId: string; agentId: string }>;
    }>;
    const entered = await h.nextProvision();
    entered.release();
    const scheduled = (await accepted).tasks[0]!;
    const taskState = h.broker.store.state.tasks[scheduled.taskId]!;
    const runState = h.broker.store.state.runs[taskState.currentRunId!]!;
    const task = {
      ...scheduled,
      runId: runState.id,
      agentId: runState.agentId!,
    };
    await connectManagedChild(h, task.agentId);
    finalReceipt = boundedReceipt(h.broker.store, (event) => {
      const candidate = event as {
        type?: string;
        entityRefs?: Record<string, unknown>;
        payload?: Record<string, unknown>;
      };
      return (
        candidate.type === "herdr.metadata_projected" &&
        candidate.entityRefs?.taskId === task.taskId &&
        candidate.payload?.state === "completed"
      );
    });
    await completeManagedChild(h, task.agentId);
    await finalReceipt.promise;

    const originalAppend = h.broker.store.append.bind(h.broker.store);
    let injected = false;
    const mutableStore = h.broker.store as unknown as {
      append: EventStore["append"];
    };
    mutableStore.append = (async (input) => {
      const candidate = input as {
        type?: string;
        payload?: Record<string, unknown>;
      };
      if (
        !injected &&
        candidate.type === "herdr.metadata_projected" &&
        candidate.payload?.state === "closed"
      ) {
        injected = true;
        throw new Error("INJECTED_CLOSED_APPEND_FAILURE");
      }
      return await originalAppend(input);
    }) as EventStore["append"];

    await assert.rejects(
      h.client.request("transcript.close", {
        taskId: task.taskId,
        confirm: true,
      }),
    );
    assert.equal(injected, true);
    assert.equal(h.retainedCloses.length, 1);
    const pending = Object.values(
      h.broker.store.state.herdrMetadata ?? {},
    ).find((item) => item.taskId === task.taskId);
    assert.equal(pending?.state, "cleanup_pending");

    await h.restart();
    const recovered = Object.values(
      h.broker.store.state.herdrMetadata ?? {},
    ).find((item) => item.taskId === task.taskId);
    assert.equal(recovered?.state, "closed");
    assert.equal(h.retainedCloses.length, 1);
  } finally {
    finalReceipt?.remove();
    await h.cleanup();
  }
});

test("restart replay retains an already provisioned task isolation", async () => {
  const h = await productionParent();
  try {
    const response = (await h.client.request("agent.spawn", {
      task: { title: "restart", objective: "restart" },
      profileId: "implementer",
      isolation: { mode: "worktree" },
      wait: false,
      dryRun: false,
    })) as { tasks: Array<{ taskId: string }> };
    const taskId = response.tasks[0]!.taskId;
    const restarted = await h.restart();
    assert.equal(
      restarted.broker.store.state.tasks[taskId]?.project?.isolation,
      "worktree",
    );
    assert.ok(restarted.broker.store.state.tasks[taskId]?.currentRunId);
    await restarted.client.close();
    await restarted.broker.stop();
  } finally {
    await h.cleanup();
  }
});

test("delegate.execute provisions both defaults through exact owned receipts", async () => {
  const h = await productionParent({ holdProvisions: true });
  const taskReceipts = [
    ["owned-delegate-implement", "implementer"],
    ["owned-delegate-review", "reviewer"],
  ].map(([objective, profileId]) =>
    boundedReceipt(h.broker.store, (event) => {
      const value = event as {
        type?: string;
        payload?: Record<string, unknown>;
      };
      return (
        value.type === "task.created_m3" &&
        value.payload?.objective === objective &&
        value.payload?.profileId === profileId &&
        value.payload?.parentAgentId === h.registered.agentId
      );
    }),
  );
  const receipts = [...taskReceipts];
  try {
    const responsePromise = h.client.request("delegate.execute", {
      mode: "implement_review_fix",
      parentAgentId: h.registered.agentId,
      title: "owned-delegate",
      steps: [
        {
          key: "implement",
          profileId: "implementer",
          title: "owned-delegate-implement",
          objective: "owned-delegate-implement",
          dependsOn: [],
        },
        {
          key: "review",
          profileId: "reviewer",
          title: "owned-delegate-review",
          objective: "owned-delegate-review",
          dependsOn: [],
        },
      ],
      wait: false,
      waitUntil: [],
      timeoutMs: 60_000,
      failureMode: "fail_fast",
      dryRun: false,
    }) as Promise<{ tasks: Array<{ taskId: string; agentId: string }> }>;
    const exactAgents: string[] = [];
    for (const [profileId, isolation] of [
      ["implementer", "worktree"],
      ["reviewer", "shared-readonly"],
    ] as const) {
      const entered = await h.nextProvision();
      assert.equal(entered.input.profileId, profileId);
      assert.equal(entered.input.isolation, isolation);
      const agentId = entered.input.agentId as string;
      exactAgents.push(agentId);
      const intent = boundedReceipt(
        h.broker.store,
        (event) =>
          (event as { type?: string; entityRefs?: Record<string, unknown> })
            .type === "herdr.provision.intent" &&
          (event as { entityRefs?: Record<string, unknown> }).entityRefs
            ?.agentId === agentId,
      );
      const outcome = boundedReceipt(
        h.broker.store,
        (event) =>
          (event as { type?: string; entityRefs?: Record<string, unknown> })
            .type === "herdr.provision.outcome" &&
          (event as { entityRefs?: Record<string, unknown> }).entityRefs
            ?.agentId === agentId,
      );
      receipts.push(intent, outcome);
      entered.release();
      await Promise.all([intent.promise, outcome.promise]);
    }
    const [response, ...created] = await Promise.all([
      responsePromise,
      ...taskReceipts.map((receipt) => receipt.promise),
    ]);
    assert.deepEqual(
      response.tasks.map((task) => task.agentId),
      exactAgents,
    );
    assert.deepEqual(
      created.map(
        (event) =>
          (event as { entityRefs?: Record<string, unknown> }).entityRefs
            ?.taskId,
      ),
      response.tasks.map((task) => task.taskId),
    );
    assert.deepEqual(
      response.tasks.map(
        (task) => h.broker.store.state.tasks[task.taskId]?.project?.isolation,
      ),
      ["worktree", "shared-readonly"],
    );
    for (const task of response.tasks)
      assert.equal(
        validateAdvisoryModelReceipt(
          h.broker.store.state.tasks[task.taskId]?.project
            ?.advisoryModelReceipt,
        ).mode,
        "current_default",
      );
  } finally {
    for (const receipt of receipts) receipt.remove();
    await h.cleanup();
  }
});

test("failed provisioning releases endpoint capacity for the queued task", async () => {
  const h = await productionParent({
    holdProvisions: true,
    failProvisionAt: 1,
    schedulerLimits: {
      maxActiveAgents: 4,
      maxActivePerParent: 4,
      maxProvisioning: 2,
    },
    endpointPolicy: {
      endpoints: { local: { maxConcurrentAgents: 1 } },
      mappings: [{ provider: "openai-codex", endpointId: "local" }],
    },
  });
  try {
    const accepted = h.client.request("delegate.execute", {
      mode: "parallel",
      parentAgentId: h.registered.agentId,
      title: "capacity-failed-provision",
      steps: [
        {
          key: "first",
          profileId: "implementer",
          title: "capacity-failed-first",
          objective: "capacity-failed-first",
          dependsOn: [],
        },
        {
          key: "second",
          profileId: "reviewer",
          title: "capacity-failed-second",
          objective: "capacity-failed-second",
          dependsOn: [],
        },
      ],
      wait: false,
      waitUntil: [],
      timeoutMs: 60_000,
      failureMode: "collect_all",
      dryRun: false,
    }) as Promise<{ tasks: Array<{ taskId: string }> }>;

    (await h.nextProvision()).release();
    const secondProvision = await h.nextProvision();
    secondProvision.release();
    const response = await accepted;
    const tasks = response.tasks.map(
      ({ taskId }) => h.broker.store.state.tasks[taskId]!,
    );
    assert.equal(h.provisions.length, 2);
    assert.equal(tasks.filter((task) => task.state === "failed").length, 1);
    assert.equal(
      tasks.filter((task) => task.currentRunId && task.state !== "failed")
        .length,
      1,
    );
    assert.deepEqual(
      tasks.map((task) => task.endpointId),
      ["local", "local"],
    );
  } finally {
    await h.cleanup();
  }
});

test("direct spawn waits for endpoint capacity until cancellation releases it", async () => {
  const h = await productionParent({
    holdProvisions: true,
    schedulerLimits: {
      maxActiveAgents: 4,
      maxActivePerParent: 4,
      maxProvisioning: 2,
    },
    endpointPolicy: {
      endpoints: { local: { maxConcurrentAgents: 1 } },
      mappings: [{ provider: "openai-codex", endpointId: "local" }],
    },
  });
  try {
    const firstAccepted = h.client.request("agent.spawn", {
      task: { title: "capacity-spawn-first", objective: "first" },
      profileId: "implementer",
      isolation: { mode: "worktree" },
      wait: false,
      dryRun: false,
    }) as Promise<{ tasks: Array<{ taskId: string }> }>;
    const firstProvision = await h.nextProvision();
    firstProvision.release();
    const firstTaskId = (await firstAccepted).tasks[0]!.taskId;

    const second = (await h.client.request("agent.spawn", {
      task: { title: "capacity-spawn-second", objective: "second" },
      profileId: "reviewer",
      isolation: { mode: "shared-readonly" },
      wait: false,
      dryRun: false,
    })) as { tasks: Array<{ taskId: string }> };
    const secondTaskId = second.tasks[0]!.taskId;
    assert.equal(h.provisions.length, 1);
    assert.equal(
      h.broker.store.state.tasks[secondTaskId]?.admissionReason,
      "endpoint_capacity",
    );

    await h.client.request("task.cancel", {
      taskId: firstTaskId,
      reason: "capacity cancellation test",
      cascade: false,
    });
    const secondProvision = await h.nextProvision();
    secondProvision.release();
    assert.equal(h.provisions.length, 2);
    assert.equal(h.broker.store.state.tasks[firstTaskId]?.state, "cancelled");
    assert.ok(h.broker.store.state.tasks[secondTaskId]?.currentRunId);
  } finally {
    await h.cleanup();
  }
});

test("result recovery holds endpoint capacity until result publish", async () => {
  const h = await productionParent({
    holdProvisions: true,
    schedulerLimits: {
      maxActiveAgents: 4,
      maxActivePerParent: 4,
      maxProvisioning: 2,
    },
    endpointPolicy: {
      endpoints: { local: { maxConcurrentAgents: 1 } },
      mappings: [{ provider: "openai-codex", endpointId: "local" }],
    },
  });
  try {
    const accepted = h.client.request("delegate.execute", {
      mode: "parallel",
      parentAgentId: h.registered.agentId,
      title: "capacity-result-recovery",
      steps: [
        {
          key: "first",
          profileId: "implementer",
          title: "capacity-recovery-first",
          objective: "capacity-recovery-first",
          dependsOn: [],
        },
        {
          key: "second",
          profileId: "reviewer",
          title: "capacity-recovery-second",
          objective: "capacity-recovery-second",
          dependsOn: [],
        },
      ],
      wait: false,
      waitUntil: [],
      timeoutMs: 60_000,
      failureMode: "collect_all",
      dryRun: false,
    }) as Promise<{ tasks: Array<{ taskId: string }> }>;

    const firstProvision = await h.nextProvision();
    const firstAgentId = firstProvision.input.agentId as string;
    firstProvision.release();
    const response = await accepted;
    const tasks = response.tasks.map(
      ({ taskId }) => h.broker.store.state.tasks[taskId]!,
    );
    const active = tasks.find((task) => task.currentRunId)!;
    const queued = tasks.find((task) => !task.currentRunId)!;
    await connectManagedChild(h, firstAgentId);
    const recoveryRequested = boundedReceipt(h.broker.store, (event) => {
      const value = event as {
        type?: string;
        entityRefs?: Record<string, unknown>;
      };
      return (
        value.type === "run.result_recovery_requested" &&
        value.entityRefs?.runId === active.currentRunId
      );
    });
    await Promise.all([
      completeManagedChild(h, firstAgentId, false),
      recoveryRequested.promise,
    ]);
    recoveryRequested.remove();
    assert.equal(
      h.broker.store.state.runs[active.currentRunId!]?.state,
      "result_pending_missing",
    );
    assert.equal(queued.admissionReason, "endpoint_capacity");
    assert.equal(h.provisions.length, 1);

    await publishManagedResult(h, firstAgentId);
    const secondProvision = await h.nextProvision();
    secondProvision.release();
    assert.equal(h.provisions.length, 2);
    assert.ok(h.broker.store.state.tasks[queued.id]?.currentRunId);
  } finally {
    await h.cleanup();
  }
});

test("endpoint capacity survives restart and releases only after terminal result", async () => {
  const h = await productionParent({
    holdProvisions: true,
    schedulerLimits: {
      maxActiveAgents: 4,
      maxActivePerParent: 4,
      maxProvisioning: 2,
    },
    endpointPolicy: {
      endpoints: { local: { maxConcurrentAgents: 1 } },
      mappings: [{ provider: "openai-codex", endpointId: "local" }],
    },
  });
  try {
    const accepted = h.client.request("delegate.execute", {
      mode: "parallel",
      parentAgentId: h.registered.agentId,
      title: "capacity-one-restart",
      steps: [
        {
          key: "first",
          profileId: "implementer",
          title: "capacity-one-first",
          objective: "capacity-one-first",
          dependsOn: [],
        },
        {
          key: "second",
          profileId: "reviewer",
          title: "capacity-one-second",
          objective: "capacity-one-second",
          dependsOn: [],
        },
      ],
      wait: false,
      waitUntil: [],
      timeoutMs: 60_000,
      failureMode: "fail_fast",
      dryRun: false,
    }) as Promise<{ tasks: Array<{ taskId: string }> }>;

    const firstProvision = await h.nextProvision();
    const firstAgentId = firstProvision.input.agentId as string;
    firstProvision.release();
    const response = await accepted;
    assert.equal(response.tasks.length, 2);

    const tasks = response.tasks.map(
      ({ taskId }) => h.broker.store.state.tasks[taskId]!,
    );
    const active = tasks.find((task) => task.currentRunId);
    const queued = tasks.find((task) => !task.currentRunId);
    assert.ok(active && queued);
    assert.equal(active.endpointId, "local");
    assert.equal(queued.endpointId, "local");
    assert.equal(queued.state, "queued");
    assert.equal(queued.admissionReason, "endpoint_capacity");
    assert.equal(h.provisions.length, 1);

    await h.restart();
    assert.equal(h.provisions.length, 1);
    assert.equal(
      h.broker.store.state.tasks[queued.id]?.admissionReason,
      "endpoint_capacity",
    );
    assert.equal(
      h.broker.store.state.runs[active.currentRunId!]?.endpointId,
      "local",
    );

    await connectManagedChild(h, firstAgentId);
    await completeManagedChild(h, firstAgentId);
    const secondProvision = await h.nextProvision();
    assert.notEqual(secondProvision.input.agentId, firstAgentId);
    secondProvision.release();
    assert.equal(h.provisions.length, 2);
    assert.ok(h.broker.store.state.tasks[queued.id]?.currentRunId);
    assert.equal(
      h.broker.store.state.tasks[queued.id]?.admissionReason,
      undefined,
    );
  } finally {
    await h.cleanup();
  }
});

test("reuse-worktree rejects multiple dependencies before workflow mutation", async () => {
  const h = await productionParent();
  const appended: unknown[] = [];
  const remove = h.broker.store.onAppend((event) => appended.push(event));
  try {
    await assert.rejects(
      h.client.request("workflow.create", {
        objective: "multiple-reuse-dependencies",
        parentAgentId: h.registered.agentId,
        definition: {
          version: 1,
          id: "reuse-multiple",
          name: "reuse multiple",
          description: "reuse multiple",
          mode: "dag",
          failureMode: "fail_fast",
          maxCorrectionLoops: 0,
          steps: [
            {
              key: "a",
              profileId: "implementer",
              title: "a",
              objectiveTemplate: "a",
              constraints: [],
              dependsOn: [],
              resultProjection: [],
              isolationMode: "profile-default",
            },
            {
              key: "b",
              profileId: "implementer",
              title: "b",
              objectiveTemplate: "b",
              constraints: [],
              dependsOn: [],
              resultProjection: [],
              isolationMode: "profile-default",
            },
            {
              key: "reuse",
              profileId: "reviewer",
              title: "reuse",
              objectiveTemplate: "reuse",
              constraints: [],
              dependsOn: ["a", "b"],
              resultProjection: [],
              isolationMode: "reuse-worktree",
            },
          ],
        },
        dryRun: false,
      }),
    );
    remove();
    assert.deepEqual(appended, []);
    assert.equal(h.provisions.length, 0);
  } finally {
    remove();
    await h.cleanup();
  }
});

test("reuse-worktree waits for the predecessor endpoint lease and binds once", async () => {
  const h = await productionParent({
    holdProvisions: true,
    schedulerLimits: {
      maxActiveAgents: 4,
      maxActivePerParent: 4,
      maxProvisioning: 2,
    },
    endpointPolicy: {
      endpoints: { local: { maxConcurrentAgents: 1 } },
      mappings: [{ provider: "openai-codex", endpointId: "local" }],
    },
  });
  try {
    const accepted = h.client.request("workflow.create", {
      objective: "capacity-reuse-worktree",
      parentAgentId: h.registered.agentId,
      definition: {
        version: 1,
        id: "capacity-reuse-worktree",
        name: "capacity reuse worktree",
        description: "reuse after one endpoint lease releases",
        mode: "dag",
        failureMode: "fail_fast",
        maxCorrectionLoops: 0,
        steps: [
          {
            key: "implement",
            profileId: "implementer",
            title: "implement",
            objectiveTemplate: "{{input.objective}}",
            constraints: [],
            dependsOn: [],
            resultProjection: [],
            isolationMode: "worktree",
          },
          {
            key: "review",
            profileId: "reviewer",
            title: "review",
            objectiveTemplate: "{{input.objective}}",
            constraints: [],
            dependsOn: ["implement"],
            resultProjection: [],
            isolationMode: "reuse-worktree",
          },
        ],
      },
      dryRun: false,
    }) as Promise<{ tasks: Array<{ taskId: string }> }>;
    const firstProvision = await h.nextProvision();
    const firstAgentId = firstProvision.input.agentId as string;
    firstProvision.release();
    const response = await accepted;
    const implement = h.broker.store.state.tasks[response.tasks[0]!.taskId]!;
    const review = h.broker.store.state.tasks[response.tasks[1]!.taskId]!;
    assert.equal(h.provisions.length, 1);
    assert.equal(implement.endpointId, "local");
    assert.equal(review.endpointId, "local");
    assert.equal(review.currentRunId, undefined);

    await connectManagedChild(h, firstAgentId);
    await completeManagedChild(h, firstAgentId);
    const secondProvision = await h.nextProvision();
    assert.equal(
      secondProvision.input.reuseWorktreeId,
      `worktree-${firstAgentId}`,
    );
    secondProvision.release();
    assert.equal(h.provisions.length, 2);
    const reviewRun = h.broker.store.state.tasks[review.id]?.currentRunId;
    assert.ok(reviewRun);
    assert.equal(h.broker.store.state.runs[reviewRun]?.endpointId, "local");
  } finally {
    await h.cleanup();
  }
});

test("unsafe isolation requests fail before durable mutation or provisioning", async () => {
  const h = await productionParent();
  const appended: Array<{ type: string }> = [];
  const remove = h.broker.store.onAppend((event) =>
    appended.push(event as { type: string }),
  );
  try {
    const before = Object.keys(h.broker.store.state.tasks).length;
    const malformed = [
      null,
      [],
      {},
      { mode: "worktree", extra: true },
      { mode: 3 },
      { mode: "shared-explicit" },
      { mode: "reuse-worktree" },
    ];
    for (const isolation of malformed)
      await assert.rejects(
        h.client.request("agent.spawn", {
          task: { title: "bad", objective: "bad" },
          profileId: "reviewer",
          isolation,
          wait: false,
          dryRun: false,
        }),
      );
    await assert.rejects(
      h.client.request("agent.spawn", {
        task: { title: "bad", objective: "bad" },
        profileId: "implementer",
        isolation: { mode: "shared-readonly" },
        wait: false,
        dryRun: false,
      }),
    );
    await assert.rejects(
      h.client.request("agent.spawn", {
        task: { title: "bad", objective: "bad" },
        profileId: "not-shipped",
        wait: false,
        dryRun: false,
      }),
    );
    remove();
    assert.ok(appended.length > 0);
    assert.ok(
      appended.every((event) =>
        ["audit.action", "audit.authorization_denied"].includes(event.type),
      ),
    );
    assert.equal(Object.keys(h.broker.store.state.tasks).length, before);
    assert.equal(h.provisions.length, 0);
  } finally {
    remove();
    await h.cleanup();
  }
});

test("reuse admission fails closed for missing, wrong-owner, and stale resources", async () => {
  for (const resourceMode of ["missing", "wrong-owner", "stale"] as const) {
    const h = await productionParent({ resourceMode });
    let removeBinding: () => void = () => undefined;
    try {
      const response = (await h.client.request("workflow.create", {
        objective: `guard-${resourceMode}`,
        parentAgentId: h.registered.agentId,
        definition: {
          version: 1,
          id: `guard-${resourceMode}`,
          name: `guard ${resourceMode}`,
          description: `guard ${resourceMode}`,
          mode: "dag",
          failureMode: "fail_fast",
          maxCorrectionLoops: 0,
          steps: [
            {
              key: "implement",
              profileId: "implementer",
              title: "implement",
              objectiveTemplate: "{{input.objective}}",
              constraints: [],
              dependsOn: [],
              resultProjection: [],
              isolationMode: "worktree",
            },
            {
              key: "review",
              profileId: "reviewer",
              title: "review",
              objectiveTemplate: "{{input.objective}}",
              constraints: [],
              dependsOn: ["implement"],
              resultProjection: [],
              isolationMode: "reuse-worktree",
            },
          ],
        },
        dryRun: false,
      })) as { tasks: Array<{ taskId: string }> };
      const implement = h.broker.store.state.tasks[response.tasks[0]!.taskId]!;
      const review = h.broker.store.state.tasks[response.tasks[1]!.taskId]!;
      const implementAgent = implement.currentRunId
        ? h.broker.store.state.runs[implement.currentRunId]?.agentId
        : undefined;
      assert.ok(implementAgent);
      let bindingCount = 0;
      removeBinding = h.broker.store.onAppend((event) => {
        if (
          event.type === "task.project_bound" &&
          event.entityRefs?.taskId === review.id
        )
          bindingCount++;
      });
      await connectManagedChild(h, implementAgent);
      const implementRunId = implement.currentRunId!;
      const succeeded = boundedReceipt(
        h.broker.store,
        (event) =>
          (event as { type?: string; entityRefs?: Record<string, unknown> })
            .type === "run.state_changed" &&
          (event as { entityRefs?: Record<string, unknown> }).entityRefs
            ?.runId === implementRunId &&
          (event as { payload?: Record<string, unknown> }).payload?.state ===
            "succeeded",
      );
      await Promise.all([
        completeManagedChild(h, implementAgent),
        succeeded.promise,
      ]);
      succeeded.remove();
      assert.equal(bindingCount, 0);
      assert.equal(
        h.broker.store.state.tasks[review.id]?.currentRunId,
        undefined,
      );
      assert.equal(h.provisions.length, 1);
    } finally {
      removeBinding();
      await assert.rejects(h.cleanup(), /dependency worktree|registered|owned/);
    }
  }
});

test("real startup reconciliation rejects missing, changed, and ambiguous reuse", async () => {
  for (const mode of [
    "missing",
    "replaced",
    "wrong-workspace",
    "duplicate-exact-first",
    "duplicate-conflict-first",
  ] as const) {
    const h = await productionParent({ realReconcileWorktree: mode });
    let removeBinding: () => void = () => undefined;
    try {
      const response = (await h.client.request("workflow.create", {
        objective: `restart-reconcile-${mode}`,
        parentAgentId: h.registered.agentId,
        definition: {
          version: 1,
          id: `restart-reconcile-${mode}`,
          name: `restart reconcile ${mode}`,
          description: `restart reconcile ${mode}`,
          mode: "dag",
          failureMode: "fail_fast",
          maxCorrectionLoops: 0,
          steps: [
            {
              key: "implement",
              profileId: "implementer",
              title: "implement",
              objectiveTemplate: "{{input.objective}}",
              constraints: [],
              dependsOn: [],
              resultProjection: [],
              isolationMode: "worktree",
            },
            {
              key: "review",
              profileId: "reviewer",
              title: "review",
              objectiveTemplate: "{{input.objective}}",
              constraints: [],
              dependsOn: ["implement"],
              resultProjection: [],
              isolationMode: "reuse-worktree",
            },
          ],
        },
        dryRun: false,
      })) as { tasks: Array<{ taskId: string }> };
      const implement = h.broker.store.state.tasks[response.tasks[0]!.taskId]!;
      const reviewId = response.tasks[1]!.taskId;
      const implementAgent = implement.currentRunId
        ? h.broker.store.state.runs[implement.currentRunId]?.agentId
        : undefined;
      assert.ok(implementAgent);
      await h.restart();
      assert.equal(
        h.broker.store.state.herdrResources?.[implementAgent]?.state,
        mode === "missing" ? "missing" : "replaced",
      );
      let bindingCount = 0;
      removeBinding = h.broker.store.onAppend((event) => {
        if (
          event.type === "task.project_bound" &&
          event.entityRefs?.taskId === reviewId
        )
          bindingCount++;
      });
      await connectManagedChild(h, implementAgent);
      await completeManagedChild(h, implementAgent);
      assert.equal(bindingCount, 0);
      assert.equal(
        h.broker.store.state.tasks[reviewId]?.currentRunId,
        undefined,
      );
      assert.equal(h.provisions.length, 1);
    } finally {
      removeBinding();
      await assert.rejects(h.cleanup(), /dependency worktree|registered|owned/);
    }
  }
});

test("restart rejects a persisted binding that no longer matches its resource", async () => {
  const h = await productionParent({ holdReuseProvisions: true });
  const replayRoot = await mkdtemp(join(tmpdir(), "isolation-binding-replay-"));
  const replayRuntime = await mkdtemp(
    join(tmpdir(), "isolation-binding-replay-runtime-"),
  );
  let receipt: ReturnType<typeof boundedReceipt> | undefined;
  try {
    const response = (await h.client.request("workflow.create", {
      objective: "persisted-binding-replay",
      parentAgentId: h.registered.agentId,
      definition: {
        version: 1,
        id: "persisted-binding-replay",
        name: "persisted binding replay",
        description: "reject changed retained worktree",
        mode: "dag",
        failureMode: "fail_fast",
        maxCorrectionLoops: 0,
        steps: [
          {
            key: "implement",
            profileId: "implementer",
            title: "implement",
            objectiveTemplate: "{{input.objective}}",
            constraints: [],
            dependsOn: [],
            resultProjection: [],
            isolationMode: "worktree",
          },
          {
            key: "review",
            profileId: "reviewer",
            title: "review",
            objectiveTemplate: "{{input.objective}}",
            constraints: [],
            dependsOn: ["implement"],
            resultProjection: [],
            isolationMode: "reuse-worktree",
          },
        ],
      },
      dryRun: false,
    })) as { tasks: Array<{ taskId: string }> };
    const implement = h.broker.store.state.tasks[response.tasks[0]!.taskId]!;
    const reviewId = response.tasks[1]!.taskId;
    const implementAgent = implement.currentRunId
      ? h.broker.store.state.runs[implement.currentRunId]?.agentId
      : undefined;
    assert.ok(implementAgent);
    receipt = boundedReceipt(h.broker.store, (event) => {
      const value = event as {
        type?: string;
        entityRefs?: Record<string, unknown>;
      };
      return (
        value.type === "task.project_bound" &&
        value.entityRefs?.taskId === reviewId
      );
    });
    await connectManagedChild(h, implementAgent);
    const completion = completeManagedChild(h, implementAgent);
    const bindingEvent = (await receipt.promise) as { seq: number };
    const entered = await h.nextProvision();
    assert.equal(entered.input.reuseWorktreeId, `worktree-${implementAgent}`);

    const sourceLines = (await readFile(h.paths.events, "utf8"))
      .trimEnd()
      .split("\n");
    const prefix = sourceLines.filter(
      (line) => (JSON.parse(line) as { seq: number }).seq <= bindingEvent.seq,
    );
    assert.equal(
      (JSON.parse(prefix.at(-1)!) as { type: string; seq: number }).type,
      "task.project_bound",
    );
    const replayPaths = {
      sessionKey: sessionKey(join(replayRuntime, "broker.sock")),
      root: replayRoot,
      runtime: replayRuntime,
      events: join(replayRoot, "events.jsonl"),
      snapshot: join(replayRoot, "snapshot.json"),
      lock: join(replayRuntime, "lock"),
      socket: join(replayRuntime, "broker.sock"),
      secret: join(replayRuntime, "secret"),
    };
    await writeFile(replayPaths.events, `${prefix.join("\n")}\n`, {
      mode: 0o600,
    });

    entered.release();
    await completion;

    const replayProvisions: Array<Record<string, unknown>> = [];
    const replayBroker = new Broker(replayPaths, {
      herdrFactory: async (store) =>
        ({
          resources: store.state.herdrResources ?? {},
          async startupReconcile() {
            await store.append({
              type: "herdr.reconciled",
              actor,
              entityRefs: { agentId: implementAgent },
              payload: {
                agentId: implementAgent,
                state: "present",
                ownerId: implementAgent,
                worktreeId: "worktree-replaced-after-crash",
                worktreePath: "/tmp/worktree-replaced-after-crash",
                workspaceId: "parent-workspace",
              },
            });
            return [];
          },
          async provision(input: Record<string, unknown>) {
            replayProvisions.push(input);
            throw new Error("replay must fail before provisioning");
          },
        }) as never,
    });
    await assert.rejects(
      replayBroker.start(),
      /retained worktree binding does not match its predecessor/,
    );
    assert.deepEqual(replayProvisions, []);
  } finally {
    receipt?.remove();
    await h.cleanup();
    await rm(replayRoot, { recursive: true, force: true });
    await rm(replayRuntime, { recursive: true, force: true });
  }
});

test("HerdrProvisioner reuses an exact worktree without creating one", async () => {
  const root = await mkdtemp(join(tmpdir(), "isolation-reuse-provisioner-"));
  const calls: string[] = [];
  let liveWorktrees = [
    {
      id: "retained-worktree-id",
      workspaceId: "workspace-reuse",
      path: "/tmp/retained-worktree-path",
    },
  ];
  const cli = {
    createWorktree: async () => {
      calls.push("createWorktree");
      throw new Error("replacement worktree must not be created");
    },
    createTab: async (input: Record<string, unknown>) => {
      calls.push(`createTab:${String(input.cwd)}`);
      return { tab_id: "reuse-tab", root_pane_id: "reuse-pane" };
    },
    startPi: async () => ({ pane_id: "reuse-pane" }),
    snapshot: async () => ({
      panes: [],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: liveWorktrees,
    }),
  } as never;
  try {
    const provisioner = new HerdrProvisioner(
      cli,
      join(root, "prompts"),
      () => [],
      true,
    );
    const result = await provisioner.provision({
      agentId: "agt_reuse_provisioner",
      parentAgentId: "agt_parent_provisioner",
      role: "reviewer",
      workspaceId: "workspace-reuse",
      cwd: "/tmp/parent-checkout",
      profileId: "reviewer",
      isolation: "shared-readonly",
      prompt: "review retained worktree",
      reuseWorktreeId: "retained-worktree-id",
      reuseWorktreePath: "/tmp/retained-worktree-path",
    });
    assert.deepEqual(calls, ["createTab:/tmp/retained-worktree-path"]);
    assert.equal(result.worktreeId, "retained-worktree-id");
    assert.equal(result.worktreePath, "/tmp/retained-worktree-path");
    const beforePartial = [...calls];
    const partialPromptRoot = join(root, "partial-prompts");
    const partialProvisioner = new HerdrProvisioner(
      cli,
      partialPromptRoot,
      () => [],
      true,
    );
    await assert.rejects(
      partialProvisioner.provision({
        agentId: "agt_partial_reuse",
        parentAgentId: "agt_parent_provisioner",
        role: "reviewer",
        workspaceId: "workspace-reuse",
        cwd: "/tmp/parent-checkout",
        profileId: "reviewer",
        isolation: "shared-readonly",
        prompt: "partial retained identity",
        reuseWorktreeId: "retained-worktree-id",
      }),
      /IDENTITY_INVALID/,
    );
    assert.deepEqual(calls, beforePartial);
    await assert.rejects(stat(partialPromptRoot), { code: "ENOENT" });

    for (const [caseId, worktrees] of [
      ["missing", []],
      [
        "replaced",
        [
          {
            id: "retained-worktree-id",
            workspaceId: "workspace-reuse",
            path: "/tmp/replaced-worktree-path",
          },
        ],
      ],
      [
        "wrong_workspace",
        [
          {
            id: "retained-worktree-id",
            workspaceId: "wrong-workspace",
            path: "/tmp/retained-worktree-path",
          },
        ],
      ],
      [
        "duplicate_exact_first",
        [
          {
            id: "retained-worktree-id",
            workspaceId: "workspace-reuse",
            path: "/tmp/retained-worktree-path",
          },
          {
            id: "retained-worktree-id",
            workspaceId: "wrong-workspace",
            path: "/tmp/conflicting-worktree-path",
          },
        ],
      ],
      [
        "duplicate_conflict_first",
        [
          {
            id: "retained-worktree-id",
            workspaceId: "wrong-workspace",
            path: "/tmp/conflicting-worktree-path",
          },
          {
            id: "retained-worktree-id",
            workspaceId: "workspace-reuse",
            path: "/tmp/retained-worktree-path",
          },
        ],
      ],
    ] as const) {
      liveWorktrees = [...worktrees];
      await assert.rejects(
        provisioner.provision({
          agentId: `agt_stale_reuse_${caseId}`,
          parentAgentId: "agt_parent_provisioner",
          role: "reviewer",
          workspaceId: "workspace-reuse",
          cwd: "/tmp/parent-checkout",
          profileId: "reviewer",
          isolation: "shared-readonly",
          prompt: "stale retained identity",
          reuseWorktreeId: "retained-worktree-id",
          reuseWorktreePath: "/tmp/retained-worktree-path",
        }),
        /IDENTITY_STALE/,
      );
      assert.deepEqual(calls, beforePartial);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("implement-review-fix admits reviewer into the exact retained worktree", async () => {
  const h = await productionParent({
    holdReuseProvisions: true,
    realReconcileWorktree: "exact",
  });
  const receipts: Array<ReturnType<typeof boundedReceipt>> = [];
  try {
    const response = (await h.client.request("workflow.create", {
      objective: "unique-isolation-reuse-proof",
      parentAgentId: h.registered.agentId,
      definition: {
        version: 1,
        id: "w-reuse-proof",
        name: "reuse proof",
        description: "reuse proof",
        mode: "implement_review_fix",
        failureMode: "fail_fast",
        maxCorrectionLoops: 1,
        steps: [
          {
            key: "implement",
            profileId: "implementer",
            title: "implement",
            objectiveTemplate: "{{input.objective}}",
            constraints: [],
            dependsOn: [],
            resultProjection: [],
            isolationMode: "profile-default",
          },
          {
            key: "review",
            profileId: "reviewer",
            title: "review",
            objectiveTemplate: "{{input.objective}}",
            constraints: [],
            dependsOn: ["implement"],
            resultProjection: [],
            isolationMode: "reuse-worktree",
          },
          {
            key: "fix",
            profileId: "implementer",
            title: "fix",
            objectiveTemplate: "{{input.objective}}",
            constraints: [],
            dependsOn: ["review"],
            resultProjection: [],
            isolationMode: "reuse-worktree",
          },
        ],
      },
      dryRun: false,
    })) as { tasks: Array<{ taskId: string }> };
    const tasks = response.tasks.map(
      (item) => h.broker.store.state.tasks[item.taskId]!,
    );
    const implement = tasks.find((task) => task.title === "implement")!;
    const review = tasks.find((task) => task.title === "review")!;
    const fix = tasks.find((task) => task.title === "fix")!;
    assert.equal(implement.project?.isolation, "worktree");
    assert.equal(review.isolationMode, "reuse-worktree");
    const implementAgent = implement.currentRunId
      ? h.broker.store.state.runs[implement.currentRunId]?.agentId
      : undefined;
    assert.ok(implementAgent);
    const implementProvision = h.provisions.find(
      (item) => item.agentId === implementAgent,
    )!;
    const retainedId = `worktree-${implementAgent}`;
    const retainedPath = `/tmp/worktree-${implementAgent}`;
    assert.equal(implementProvision.isolation, "worktree");
    assert.equal(implementProvision.reuseWorktreeId, undefined);
    const restarted = await h.restart();
    assert.equal(
      restarted.broker.store.state.tasks[review.id]?.isolationMode,
      "reuse-worktree",
    );
    assert.equal(
      restarted.broker.store.state.tasks[review.id]?.state,
      "queued",
    );
    await connectManagedChild(h, implementAgent);

    const reviewBinding = boundedReceipt(h.broker.store, (event) => {
      const value = event as {
        type?: string;
        entityRefs?: Record<string, unknown>;
      };
      return (
        value.type === "task.project_bound" &&
        value.entityRefs?.taskId === review.id
      );
    });
    receipts.push(reviewBinding);
    const implementCompletion = completeManagedChild(h, implementAgent);
    await reviewBinding.promise;
    const reviewEntered = await h.nextProvision();
    assert.equal(reviewEntered.input.profileId, "reviewer");
    assert.equal(reviewEntered.input.reuseWorktreeId, retainedId);
    const reviewAgent = reviewEntered.input.agentId as string;
    const reviewOutcome = boundedReceipt(
      h.broker.store,
      (event) =>
        (event as { type?: string; entityRefs?: Record<string, unknown> })
          .type === "herdr.provision.outcome" &&
        (event as { entityRefs?: Record<string, unknown> }).entityRefs
          ?.agentId === reviewAgent,
    );
    receipts.push(reviewOutcome);
    reviewEntered.release();
    await Promise.all([implementCompletion, reviewOutcome.promise]);
    const reviewProvision = h.provisions.find(
      (item) => item.agentId === reviewAgent,
    )!;
    assert.equal(reviewProvision.isolation, "shared-readonly");
    assert.equal(reviewProvision.reuseWorktreeId, retainedId);
    assert.equal(reviewProvision.reuseWorktreePath, retainedPath);
    assert.equal(
      h.broker.store.state.tasks[review.id]!.project?.worktreeId,
      retainedId,
    );
    assert.equal(
      h.broker.store.state.tasks[review.id]!.project?.cwd,
      retainedPath,
    );
    assert.equal(
      h.broker.store.state.herdrResources?.[reviewAgent]?.ownerId,
      reviewAgent,
    );
    assert.equal(
      h.provisions.filter(
        (item) =>
          item.isolation === "worktree" && item.reuseWorktreeId === undefined,
      ).length,
      1,
    );

    await connectManagedChild(h, reviewAgent);
    const fixReceipt = boundedReceipt(h.broker.store, (event) => {
      const value = event as {
        type?: string;
        entityRefs?: Record<string, unknown>;
      };
      return (
        value.type === "task.project_bound" &&
        value.entityRefs?.taskId === fix.id
      );
    });
    receipts.push(fixReceipt);
    const reviewCompletion = completeManagedChild(h, reviewAgent);
    await fixReceipt.promise;
    const fixEntered = await h.nextProvision();
    assert.equal(fixEntered.input.profileId, "implementer");
    assert.equal(fixEntered.input.reuseWorktreeId, retainedId);
    const fixAgent = fixEntered.input.agentId as string;
    const fixProvisionReceipt = boundedReceipt(
      h.broker.store,
      (event) =>
        (event as { type?: string; entityRefs?: Record<string, unknown> })
          .type === "herdr.provision.outcome" &&
        (event as { entityRefs?: Record<string, unknown> }).entityRefs
          ?.agentId === fixAgent,
    );
    receipts.push(fixProvisionReceipt);
    fixEntered.release();
    await Promise.all([reviewCompletion, fixProvisionReceipt.promise]);
    assert.equal(
      h.provisions.filter((item) => item.reuseWorktreeId === retainedId).length,
      2,
    );
    assert.equal(
      h.provisions.find((item) => item.agentId === fixAgent)?.reuseWorktreeId,
      retainedId,
    );
    assert.equal(
      h.broker.store.state.herdrResources?.[fixAgent]?.ownerId,
      fixAgent,
    );
    await connectManagedChild(h, fixAgent!);
    await completeManagedChild(h, fixAgent!);
    fixReceipt.remove();
  } finally {
    for (const receipt of receipts) receipt.remove();
    await h.cleanup();
  }
});
