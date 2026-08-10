import type { EventStore } from "../state/event-store.js";
import type { Agent } from "../state/types.js";
import { reconcileAgents, type Reconciliation } from "./reconciler.js";
import {
  HerdrProvisioner,
  type ProvisionInput,
  type ProvisionResult,
} from "./provisioner.js";
import type { HerdrSnapshot } from "./types.js";
import type { HerdrCli } from "./cli.js";
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
}
