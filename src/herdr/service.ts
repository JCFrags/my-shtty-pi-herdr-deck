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
  readonly #agentLocks = new Map<string, Promise<void>>();
  readonly #expiryTimers = new Map<string, NodeJS.Timeout>();
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
    return await this.withAgentLock(input.agentId, async () => {
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
        let afterGit: GitEvidence | undefined;
        if (this.#gitEvidence && result.worktreePath) {
          afterGit = await this.#gitEvidence(
            result.worktreePath,
            input.projectBase,
          );
          if (afterGit.dirty) {
            await this.#provisioner.compensate(result, input.agentId);
            throw new Error("HERDR_DIRTY_WORKTREE");
          }
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
            ...(result.worktreePath
              ? { worktreePath: result.worktreePath }
              : {}),
            ...(result.token.digest
              ? { tokenDigest: result.token.digest }
              : {}),
            ...(result.promptFileIdentity
              ? {
                  promptFileDev: result.promptFileIdentity.dev,
                  promptFileIno: result.promptFileIdentity.ino,
                }
              : {}),
            ...(result.tokenFileIdentity
              ? {
                  tokenFileDev: result.tokenFileIdentity.dev,
                  tokenFileIno: result.tokenFileIdentity.ino,
                }
              : {}),
            generation: result.token.generation,
            registrationDeadline: new Date(Date.now() + 30_000).toISOString(),
            parentAgentId: input.parentAgentId,
            ownerId: input.agentId,
            ...(beforeGit
              ? {
                  dirty: beforeGit.dirty,
                  parentGitRoot: beforeGit.repositoryRoot,
                  parentGitHead: beforeGit.head,
                  parentGitBranch: beforeGit.branch,
                  parentGitChangedFiles: beforeGit.changedFiles,
                }
              : {}),
            ...(afterGit
              ? {
                  worktreeGitRoot: afterGit.repositoryRoot,
                  worktreeGitHead: afterGit.head,
                  worktreeGitBranch: afterGit.branch,
                }
              : {}),
          },
        });
        if (result.tokenFilePath) {
          this.#pending.set(input.agentId, result);
          this.scheduleExpiry(input.agentId, result);
        }
        return result;
      } catch (error) {
        const dirty =
          error instanceof Error && error.message === "HERDR_DIRTY_WORKTREE";
        await this.#store
          .append({
            type: "herdr.provision.outcome",
            actor: this.#actor,
            entityRefs: { agentId: input.agentId },
            payload: {
              agentId: input.agentId,
              state: dirty ? "dirty" : "failed",
              reason:
                error instanceof Error ? error.message : "provision failed",
              cleanupOutcome: "retained",
              unknown: true,
              ...(dirty ? { dirty: true } : {}),
            },
          })
          .catch(() => undefined);
        throw error;
      }
    });
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
    tokenProof?: string,
  ): Promise<void> {
    await this.withAgentLock(agentId, async () => {
      await this.#preflight?.();
      const result =
        supplied ??
        this.#pending.get(agentId) ??
        (await this.restorePending(agentId));
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
      await this.#provisioner.verifyRegistration(
        result,
        identity,
        tokenProof,
        false,
      );
      const secondSnapshot = await this.#cli.snapshot();
      const secondPane = secondSnapshot.panes.find(
        (item) => item.id === identity.paneId,
      );
      const secondOccupant = secondPane?.occupant;
      if (
        !secondPane ||
        !secondOccupant ||
        (secondOccupant.agentId !== undefined &&
          secondOccupant.agentId !== resource.ownerId) ||
        secondOccupant.generation !== result.token.generation ||
        !sameIdentity(secondPane, secondOccupant, identity)
      ) {
        await this.recordLifecycle(
          agentId,
          "pending",
          "registration_identity_mismatch",
          true,
        );
        throw new Error("HERDR_REGISTRATION_IDENTITY_MISMATCH");
      }
      await this.#provisioner.cleanupRegistration(result);
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
      const timer = this.#expiryTimers.get(agentId);
      if (timer) clearTimeout(timer);
      this.#expiryTimers.delete(agentId);
    });
  }
  async stop(guard: OccupantGuard): Promise<void> {
    const agentId = this.agentForPane(guard.paneId) ?? `pane:${guard.paneId}`;
    await this.withAgentLock(agentId, async () => {
      await this.#preflight?.();
      this.#cli.requireMutationCapabilities(["agent.stop", "session.snapshot"]);
      const resource = agentId.startsWith("pane:")
        ? undefined
        : this.resources[agentId];
      if (resource?.state === "stopped" || resource?.state === "closed") return;
      if (!agentId.startsWith("pane:"))
        await this.recordLifecycle(
          agentId,
          "stopping",
          "mutation_pending",
          true,
        );
      await revalidateAndRun(this.#cli, guard, () =>
        this.#cli.stopAgent(guard.paneId),
      );
      if (!agentId.startsWith("pane:"))
        await this.recordLifecycle(agentId, "stopped", "stop_succeeded");
    });
  }
  async close(guard: OccupantGuard): Promise<void> {
    const agentId = this.agentForPane(guard.paneId) ?? `pane:${guard.paneId}`;
    await this.withAgentLock(agentId, async () => {
      await this.#preflight?.();
      this.#cli.requireMutationCapabilities([
        "pane.close",
        "worktree.remove",
        "session.snapshot",
      ]);
      const resource = agentId.startsWith("pane:")
        ? undefined
        : this.resources[agentId];
      if (resource?.dirty) throw new Error("HERDR_DIRTY_WORKTREE");
      if (resource?.worktreeId) {
        if (!resource.worktreePath || !this.#gitEvidence)
          throw new Error("HERDR_GIT_EVIDENCE_UNKNOWN");
        const evidence = await this.#gitEvidence(resource.worktreePath);
        if (
          evidence.dirty ||
          evidence.repositoryRoot !== resource.worktreePath ||
          (resource.worktreeGitHead &&
            evidence.head !== resource.worktreeGitHead) ||
          (resource.worktreeGitBranch &&
            evidence.branch !== resource.worktreeGitBranch)
        ) {
          await this.recordLifecycle(
            agentId,
            evidence.dirty ? "dirty" : "replaced",
            evidence.dirty
              ? "retained_dirty_worktree"
              : "retained_git_mismatch",
          );
          throw new Error(
            evidence.dirty
              ? "HERDR_DIRTY_WORKTREE"
              : "HERDR_GIT_IDENTITY_MISMATCH",
          );
        }
      }
      if (resource?.state === "closed") return;
      if (!agentId.startsWith("pane:"))
        await this.recordLifecycle(
          agentId,
          "closing",
          "mutation_pending",
          true,
        );
      await revalidateAndRun(this.#cli, guard, () =>
        this.#cli.closePane(guard.paneId),
      );
      if (resource?.worktreeId) {
        // Herdr has no compare-and-remove operation. Retain the worktree;
        // removing its path after pane.close could delete a replacement.
      }
      if (!agentId.startsWith("pane:"))
        await this.recordLifecycle(
          agentId,
          "closed",
          resource?.worktreeId ? "retained_worktree" : "close_succeeded",
        );
    });
  }
  private async withAgentLock<T>(
    agentId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#agentLocks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#agentLocks.set(agentId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#agentLocks.get(agentId) === current)
        this.#agentLocks.delete(agentId);
    }
  }
  private async restorePending(
    agentId: string,
  ): Promise<ProvisionResult | undefined> {
    const resource = this.resources[agentId];
    if (!resource || resource.state !== "pending") return undefined;
    const result = await this.#provisioner.recoverRegistration(
      agentId,
      resource,
    );
    if (result) {
      this.#pending.set(agentId, result);
      this.scheduleExpiry(agentId, result);
    } else {
      await this.recordLifecycle(
        agentId,
        "orphaned",
        "retained_claim_identity_unknown",
        true,
      ).catch(() => undefined);
    }
    return result;
  }
  private scheduleExpiry(agentId: string, result: ProvisionResult): void {
    const resource = this.resources[agentId];
    const deadline = resource?.registrationDeadline;
    if (!deadline) return;
    const delay = Math.max(0, Date.parse(deadline) - Date.now());
    const prior = this.#expiryTimers.get(agentId);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      void this.withAgentLock(agentId, async () => {
        const current = this.resources[agentId];
        if (current?.state !== "pending") return;
        await this.#provisioner
          .cleanupRegistration(result)
          .catch(() => undefined);
        this.#pending.delete(agentId);
        await this.recordLifecycle(
          agentId,
          "timed_out",
          "registration_deadline_cleanup",
          true,
        );
      }).catch(() => undefined);
    }, delay);
    timer.unref?.();
    this.#expiryTimers.set(agentId, timer);
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
    revokeGeneration = false,
  ): Promise<void> {
    const current = this.resources[agentId];
    await this.#store.append({
      type: "herdr.provision.outcome",
      actor: this.#actor,
      entityRefs: { agentId },
      payload: {
        agentId,
        state,
        cleanupOutcome,
        ...(revokeGeneration && current?.generation !== undefined
          ? { generation: current.generation + 1 }
          : {}),
      },
    });
  }
  async reconcile(snapshot?: HerdrSnapshot): Promise<Reconciliation[]> {
    for (const agentId of Object.keys(this.resources)) {
      if (
        this.resources[agentId]?.state === "pending" &&
        !this.#pending.has(agentId)
      )
        await this.restorePending(agentId);
    }
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
          true,
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
function sameIdentity(
  pane: { terminalId?: string },
  occupant: {
    terminalId?: string;
    sessionId?: string;
    generation?: number;
  },
  identity: {
    terminalId?: string;
    sessionId?: string;
    generation?: number;
  },
): boolean {
  return (
    (identity.terminalId === undefined ||
      (occupant.terminalId ?? pane.terminalId) === identity.terminalId) &&
    (identity.sessionId === undefined ||
      occupant.sessionId === identity.sessionId) &&
    (identity.generation === undefined ||
      occupant.generation === identity.generation)
  );
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

export interface ProductionPreflightOptions {
  runner: HerdrProcessRunner;
  binary: string;
  socketPath: string;
  expectedSchemaHash: string;
  adapterIdentity?: string;
  expectedBinaryIdentity?: string;
  binaryIdentity?: string;
  staleResourceCheck?: () => Promise<boolean>;
}
export async function runProductionPreflight(
  options: ProductionPreflightOptions,
): Promise<void> {
  if (
    options.expectedBinaryIdentity !== undefined &&
    options.binaryIdentity !== options.expectedBinaryIdentity
  )
    throw new Error("HERDR_BINARY_IDENTITY_CHANGED");
  const currentSchema = await options.runner.json(["api", "schema", "--json"]);
  const currentCapabilities = projectCapabilities(
    currentSchema,
    options.binary,
  );
  if (currentCapabilities.schemaHash !== options.expectedSchemaHash)
    throw new Error("HERDR_SCHEMA_IDENTITY_CHANGED");
  if (options.adapterIdentity !== "pi-herdr-orchestrator")
    throw new Error("HERDR_PI_ADAPTER_IDENTITY_INVALID");
  if (options.staleResourceCheck && !(await options.staleResourceCheck()))
    throw new Error("HERDR_STALE_RESOURCE");
  const report = await doctor({
    herdrBinary: options.binary,
    herdrSocket: options.socketPath,
    schema: currentSchema,
  });
  if (!report.ok) throw new Error("HERDR_DOCTOR_FAILED");
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
  if (!socketPath)
    throw new Error("HERDR_UNAVAILABLE: socket is not configured.");
  const adapterIdentity = process.env.PI_HERDR_ORCH_ADAPTER_ID;
  const expectedSchemaHash = capabilities.schemaHash;
  return new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(
      cli,
      join(paths.root, "prompts"),
      () => [],
      true,
      collectGitEvidence,
    ),
    gitEvidence: collectGitEvidence,
    preflight: async () =>
      await runProductionPreflight({
        runner,
        binary,
        socketPath,
        expectedSchemaHash,
        ...(adapterIdentity !== undefined ? { adapterIdentity } : {}),
        expectedBinaryIdentity: binary,
        binaryIdentity: binary,
      }),
    watcher: new HerdrSocketClient({
      socketPath,
      protocol: 17,
      reconnectDelaysMs: [50, 100, 250],
    }),
  });
}
