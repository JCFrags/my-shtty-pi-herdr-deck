import type { EventStore } from "../state/event-store.js";
import type { Agent } from "../state/types.js";
import { reconcileAgents, type Reconciliation } from "./reconciler.js";
import {
  HerdrProvisioner,
  type ProvisionInput,
  type ProvisionResult,
} from "./provisioner.js";
import type { HerdrSnapshot } from "./types.js";
import { HerdrSocketClient } from "./socket-client.js";
import { HerdrCli } from "./cli.js";
import { focus, interrupt, type OccupantGuard } from "./controls.js";
import { HerdrProcessRunner } from "./runner.js";
import { projectCapabilities } from "./capabilities.js";
import { join } from "node:path";
import type { ResolvedPaths } from "../shared/paths.js";
export interface HerdrServiceOptions {
  store: EventStore;
  cli: HerdrCli;
  provisioner: HerdrProvisioner;
  actor?: { principalId: string; kind: string };
  watcher?: HerdrSocketClient;
}
const actor = { principalId: "prn_00000000000000000000000000", kind: "system" };
export class HerdrService {
  readonly #store: EventStore;
  readonly #cli: HerdrCli;
  readonly #provisioner: HerdrProvisioner;
  readonly #actor: { principalId: string; kind: string };
  readonly #watcher: HerdrSocketClient | undefined;
  readonly #watchAbort = new AbortController();
  constructor(options: HerdrServiceOptions) {
    this.#store = options.store;
    this.#cli = options.cli;
    this.#provisioner = options.provisioner;
    this.#actor = options.actor ?? actor;
    this.#watcher = options.watcher;
  }
  get store(): EventStore {
    return this.#store;
  }
  get resources() {
    return this.#store.state.herdrResources ?? {};
  }
  async adoptRoot(
    agent: Agent,
    identity: {
      paneId: string;
      terminalId?: string;
      sessionId?: string;
      generation?: number;
    },
  ): Promise<void> {
    const snapshot = await this.#cli.snapshot();
    const pane = snapshot.panes.find((item) => item.id === identity.paneId);
    const occupant = pane?.occupant;
    if (
      !pane ||
      !occupant ||
      (identity.terminalId &&
        (occupant.terminalId ?? pane.terminalId) !== identity.terminalId) ||
      (identity.sessionId && occupant.sessionId !== identity.sessionId) ||
      (identity.generation !== undefined &&
        occupant.generation !== identity.generation)
    )
      throw new Error("HERDR_IDENTITY_MISMATCH");
    await this.#store.append({
      type: "herdr.provision.intent",
      actor: this.#actor,
      entityRefs: { agentId: agent.id },
      payload: { agentId: agent.id },
    });
    await this.#store.append({
      type: "herdr.provision.outcome",
      actor: this.#actor,
      entityRefs: { agentId: agent.id },
      payload: {
        agentId: agent.id,
        state: "adopted",
        paneId: identity.paneId,
        ...(identity.terminalId ? { terminalId: identity.terminalId } : {}),
        ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
        ...(identity.generation !== undefined
          ? { generation: identity.generation }
          : {}),
      },
    });
  }
  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    await this.#store.append({
      type: "herdr.provision.intent",
      actor: this.#actor,
      entityRefs: { agentId: input.agentId },
      payload: { agentId: input.agentId },
    });
    try {
      const result = await this.#provisioner.provision(input);
      await this.#store.append({
        type: "herdr.provision.outcome",
        actor: this.#actor,
        entityRefs: { agentId: input.agentId },
        payload: {
          agentId: input.agentId,
          state: "registered",
          ...(result.paneId ? { paneId: result.paneId } : {}),
          ...(result.tabId ? { tabId: result.tabId } : {}),
          ...(result.worktreeId ? { worktreeId: result.worktreeId } : {}),
          ...(result.token.digest ? { tokenDigest: result.token.digest } : {}),
          generation: result.token.generation,
          registrationDeadline: new Date(Date.now() + 30_000).toISOString(),
          parentAgentId: input.parentAgentId,
          ownerId: input.agentId,
        },
      });
      return result;
    } catch (error) {
      await this.#store
        .append({
          type: "herdr.provision.outcome",
          actor: this.#actor,
          entityRefs: { agentId: input.agentId },
          payload: {
            agentId: input.agentId,
            state: "failed",
            reason: error instanceof Error ? error.message : "provision failed",
          },
        })
        .catch(() => undefined);
      throw error;
    }
  }
  async register(
    agentId: string,
    result: ProvisionResult,
    identity: { paneId: string; generation?: number },
  ): Promise<void> {
    await this.#provisioner.verifyRegistration(result, identity);
    await this.#store.append({
      type: "herdr.provision.outcome",
      actor: this.#actor,
      entityRefs: { agentId },
      payload: {
        agentId,
        state: "registered",
        paneId: identity.paneId,
        generation: result.token.generation,
        tokenDigest: result.token.digest,
      },
    });
  }
  async stop(guard: OccupantGuard): Promise<void> {
    await revalidateAndRun(this.#cli, guard, () =>
      this.#cli.stopAgent(guard.paneId),
    );
  }
  async close(guard: OccupantGuard): Promise<void> {
    await revalidateAndRun(this.#cli, guard, () =>
      this.#cli.closePane(guard.paneId),
    );
  }
  async reconcile(snapshot?: HerdrSnapshot): Promise<Reconciliation[]> {
    const current = snapshot ?? (await this.#cli.snapshot());
    const agents = Object.values(this.#store.state.agents);
    const results = reconcileAgents(agents, current);
    for (const result of results) {
      await this.#store
        .append({
          type: "herdr.reconciled",
          actor: this.#actor,
          entityRefs: { agentId: result.agentId },
          payload: {
            agentId: result.agentId,
            state: result.kind,
            ...(result.paneId ? { paneId: result.paneId } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
          },
        })
        .catch(() => undefined);
    }
    return results;
  }
  async startupReconcile(): Promise<Reconciliation[]> {
    const result = await this.reconcile();
    if (this.#watcher)
      void this.#watcher
        .subscribe(() => undefined, this.#watchAbort.signal)
        .catch(() => undefined);
    return result;
  }
  async focus(guard: OccupantGuard): Promise<void> {
    await focus(this.#cli, () => this.#cli.snapshot(), guard);
  }
  async interrupt(guard: OccupantGuard): Promise<void> {
    await interrupt(this.#cli, () => this.#cli.snapshot(), guard);
  }
}
async function revalidateAndRun(
  cli: HerdrCli,
  guard: OccupantGuard,
  action: () => Promise<void>,
): Promise<void> {
  const before = await cli.snapshot();
  const pane = before.panes.find((p) => p.id === guard.paneId);
  const occ = pane?.occupant;
  const terminal = occ?.terminalId ?? pane?.terminalId;
  if (
    !pane ||
    !occ ||
    (guard.terminalId !== undefined && terminal !== guard.terminalId) ||
    (guard.sessionId !== undefined && occ.sessionId !== guard.sessionId) ||
    (guard.generation !== undefined && occ.generation !== guard.generation)
  )
    throw new Error("HERDR_IDENTITY_MISMATCH");
  await action();
  await cli.snapshot();
}

export async function createProductionHerdrService(
  store: EventStore,
  paths: ResolvedPaths,
  binary = process.env.HERDR_BIN_PATH,
): Promise<HerdrService> {
  if (!binary)
    throw new Error("HERDR_UNAVAILABLE: HERDR_BIN_PATH is not configured.");
  const runner = new HerdrProcessRunner({ binary });
  const schema = await runner.json(["api", "schema", "--json"]);
  const capabilities = projectCapabilities(schema, binary);
  const cli = new HerdrCli(runner, capabilities);
  const socketPath = process.env.HERDR_SOCKET_PATH;
  return new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(
      cli,
      join(paths.root, "prompts"),
      () => [],
      true,
    ),
    ...(socketPath
      ? {
          watcher: new HerdrSocketClient({
            socketPath,
            protocol: 17,
            reconnectDelaysMs: [50, 100, 250],
          }),
        }
      : {}),
  });
}
