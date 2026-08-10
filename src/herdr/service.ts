import type { EventStore } from "../state/event-store.js";
import type { Agent } from "../state/types.js";
import { reconcileAgents, type Reconciliation } from "./reconciler.js";
import {
  HerdrProvisioner,
  type ProvisionInput,
  type ProvisionResult,
} from "./provisioner.js";
import type { HerdrSnapshot } from "./types.js";
import { HerdrCli } from "./cli.js";
import { focus, interrupt, close, type OccupantGuard } from "./controls.js";
import { HerdrProcessRunner } from "./runner.js";
import { projectCapabilities } from "./capabilities.js";
import { join } from "node:path";
import type { ResolvedPaths } from "../shared/paths.js";
export interface HerdrServiceOptions {
  store: EventStore;
  cli: HerdrCli;
  provisioner: HerdrProvisioner;
  actor?: { principalId: string; kind: string };
}
const actor = { principalId: "prn_00000000000000000000000000", kind: "system" };
export class HerdrService {
  readonly #store: EventStore;
  readonly #cli: HerdrCli;
  readonly #provisioner: HerdrProvisioner;
  readonly #actor: { principalId: string; kind: string };
  constructor(options: HerdrServiceOptions) {
    this.#store = options.store;
    this.#cli = options.cli;
    this.#provisioner = options.provisioner;
    this.#actor = options.actor ?? actor;
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
    return this.reconcile();
  }
  async focus(guard: OccupantGuard): Promise<void> {
    await focus(this.#cli, () => this.#cli.snapshot(), guard);
  }
  async interrupt(guard: OccupantGuard): Promise<void> {
    await interrupt(this.#cli, () => this.#cli.snapshot(), guard);
  }
  async close(guard: OccupantGuard): Promise<void> {
    await close(this.#cli, () => this.#cli.snapshot(), guard);
  }
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
  return new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(cli, join(paths.root, "prompts")),
  });
}
