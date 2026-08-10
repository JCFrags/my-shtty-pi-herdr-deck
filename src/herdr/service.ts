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
import { collectGitEvidence } from "../git/evidence.js";
import type { GitEvidence } from "../git/porcelain.js";
import { doctor } from "../broker/doctor.js";
export interface HerdrServiceOptions {
  store: EventStore;
  cli: HerdrCli;
  provisioner: HerdrProvisioner;
  actor?: { principalId: string; kind: string };
  watcher?: HerdrSocketClient;
  gitEvidence?: (cwd: string, base?: string) => Promise<GitEvidence>;
  preflight?: () => Promise<void>;
}
const actor = { principalId: "prn_00000000000000000000000000", kind: "system" };
export class HerdrService {
  readonly #store: EventStore;
  readonly #cli: HerdrCli;
  readonly #provisioner: HerdrProvisioner;
  readonly #actor: { principalId: string; kind: string };
  readonly #watcher: HerdrSocketClient | undefined;
  readonly #pending = new Map<string, ProvisionResult>();
  readonly #preflight: (() => Promise<void>) | undefined;
  readonly #gitEvidence:
    ((cwd: string, base?: string) => Promise<GitEvidence>) | undefined;
  readonly #watchAbort = new AbortController();
  constructor(options: HerdrServiceOptions) {
    this.#store = options.store;
    this.#cli = options.cli;
    this.#provisioner = options.provisioner;
    this.#actor = options.actor ?? actor;
    this.#watcher = options.watcher;
    this.#gitEvidence = options.gitEvidence;
    this.#preflight = options.preflight;
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
    await this.#preflight?.();
    this.#cli.requireMutationCapabilities(["session.snapshot"]);
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
    await this.#preflight?.();
    this.#cli.requireMutationCapabilities(
      input.isolation === "worktree"
        ? [
            "tab.create",
            "agent.start",
            "worktree.create",
            "worktree.remove",
            "tab.close",
            "pane.close",
          ]
        : ["tab.create", "agent.start", "tab.close", "pane.close"],
    );
    const beforeGit =
      input.isolation === "worktree" && this.#gitEvidence
        ? await this.#gitEvidence(input.cwd, input.projectBase)
        : undefined;
    if (beforeGit?.dirty) throw new Error("HERDR_DIRTY_PARENT");
    await this.#store.append({
      type: "herdr.provision.intent",
      actor: this.#actor,
      entityRefs: { agentId: input.agentId },
      payload: { agentId: input.agentId },
    });
    try {
      const result = await this.#provisioner.provision(input);
      if (this.#gitEvidence && result.worktreePath) {
        const afterGit = await this.#gitEvidence(
          result.worktreePath,
          input.projectBase,
        );
        if (afterGit.dirty) throw new Error("HERDR_DIRTY_WORKTREE");
      }
      await this.#store.append({
        type: "herdr.provision.outcome",
        actor: this.#actor,
        entityRefs: { agentId: input.agentId },
        payload: {
          agentId: input.agentId,
          state: result.tokenFilePath ? "pending" : "registered",
          ...(result.paneId ? { paneId: result.paneId } : {}),
          ...(result.tabId ? { tabId: result.tabId } : {}),
          ...(result.worktreeId ? { worktreeId: result.worktreeId } : {}),
          ...(result.worktreePath ? { worktreePath: result.worktreePath } : {}),
          ...(result.token.digest ? { tokenDigest: result.token.digest } : {}),
          generation: result.token.generation,
          registrationDeadline: new Date(Date.now() + 30_000).toISOString(),
          parentAgentId: input.parentAgentId,
          ownerId: input.agentId,
          ...(beforeGit ? { dirty: beforeGit.dirty } : {}),
        },
      });
      if (result.tokenFilePath) this.#pending.set(input.agentId, result);
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
    identity: {
      paneId: string;
      terminalId?: string;
      sessionId?: string;
      generation?: number;
    },
    supplied?: ProvisionResult,
  ): Promise<void> {
    await this.#preflight?.();
    const result = supplied ?? this.#pending.get(agentId);
    if (!result) throw new Error("HERDR_REGISTRATION_PENDING_NOT_FOUND");
    const resource = this.resources[agentId];
    if (!resource || resource.state !== "pending")
      throw new Error("HERDR_REGISTRATION_NOT_PENDING");
    if (
      resource.registrationDeadline &&
      Date.parse(resource.registrationDeadline) <= Date.now()
    )
      throw new Error("HERDR_REGISTRATION_DEADLINE");
    const snapshot = await this.#cli.snapshot();
    const pane = snapshot.panes.find((item) => item.id === identity.paneId);
    const occupant = pane?.occupant;
    if (
      !pane ||
      !occupant ||
      (occupant.agentId !== undefined &&
        occupant.agentId !== resource.ownerId) ||
      (identity.terminalId !== undefined &&
        (occupant.terminalId ?? pane.terminalId) !== identity.terminalId) ||
      (identity.sessionId !== undefined &&
        occupant.sessionId !== identity.sessionId) ||
      (identity.generation !== undefined &&
        occupant.generation !== identity.generation)
    )
      throw new Error("HERDR_REGISTRATION_IDENTITY_MISMATCH");
    await this.#provisioner.verifyRegistration(result, identity);
    await this.#store.append({
      type: "herdr.provision.outcome",
      actor: this.#actor,
      entityRefs: { agentId },
      payload: {
        agentId,
        state: "registered",
        paneId: identity.paneId,
        ...(identity.terminalId ? { terminalId: identity.terminalId } : {}),
        ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
        generation: result.token.generation,
        tokenDigest: result.token.digest,
        registrationDeadline: undefined,
      },
    });
    this.#pending.delete(agentId);
  }
  async stop(guard: OccupantGuard): Promise<void> {
    await this.#preflight?.();
    this.#cli.requireMutationCapabilities(["agent.stop", "session.snapshot"]);
    const agentId = this.agentForPane(guard.paneId);
    await revalidateAndRun(this.#cli, guard, () =>
      this.#cli.stopAgent(guard.paneId),
    );
    if (agentId)
      await this.recordLifecycle(agentId, "stopped", "stop_succeeded");
  }
  async close(guard: OccupantGuard): Promise<void> {
    await this.#preflight?.();
    this.#cli.requireMutationCapabilities(["pane.close", "session.snapshot"]);
    const agentId = this.agentForPane(guard.paneId);
    const resource = agentId ? this.resources[agentId] : undefined;
    if (resource?.dirty) throw new Error("HERDR_DIRTY_WORKTREE");
    if (resource?.worktreePath && this.#gitEvidence) {
      const evidence = await this.#gitEvidence(resource.worktreePath);
      if (evidence.dirty) {
        await this.recordLifecycle(
          agentId!,
          "dirty",
          "retained_dirty_worktree",
        );
        throw new Error("HERDR_DIRTY_WORKTREE");
      }
    }
    if (resource?.state === "closed") return;
    await revalidateAndRun(this.#cli, guard, () =>
      this.#cli.closePane(guard.paneId),
    );
    if (agentId)
      await this.recordLifecycle(agentId, "closed", "close_succeeded");
  }
  private agentForPane(paneId: string): string | undefined {
    return Object.values(this.resources).find(
      (resource) => resource.paneId === paneId,
    )?.agentId;
  }
  private async recordLifecycle(
    agentId: string,
    state: string,
    cleanupOutcome: string,
  ): Promise<void> {
    await this.#store.append({
      type: "herdr.provision.outcome",
      actor: this.#actor,
      entityRefs: { agentId },
      payload: { agentId, state, cleanupOutcome },
    });
  }
  async reconcile(snapshot?: HerdrSnapshot): Promise<Reconciliation[]> {
    for (const [agentId, result] of this.#pending) {
      const resource = this.resources[agentId];
      if (
        resource?.registrationDeadline &&
        Date.parse(resource.registrationDeadline) <= Date.now()
      ) {
        await this.#provisioner
          .cleanupRegistration(result)
          .catch(() => undefined);
        this.#pending.delete(agentId);
        await this.recordLifecycle(
          agentId,
          "timed_out",
          "registration_deadline_cleanup",
        );
      }
    }
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
  capabilities.require(Object.keys(capabilities.mandatory));
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
    gitEvidence: collectGitEvidence,
    preflight: async () => {
      const report = await doctor({
        herdrBinary: binary,
        ...(socketPath ? { herdrSocket: socketPath } : {}),
        schema,
      });
      if (!report.ok) throw new Error("HERDR_DOCTOR_FAILED");
    },
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
