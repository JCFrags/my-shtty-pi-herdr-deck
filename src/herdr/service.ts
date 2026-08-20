import type { EventStore } from "../state/event-store.js";
import type { Agent, HerdrTaskMetadata } from "../state/types.js";
import { reconcileAgents, type Reconciliation } from "./reconciler.js";
import {
  HerdrProvisioner,
  type ProvisionInput,
  type ProvisionResult,
} from "./provisioner.js";
import type { HerdrSessionReference, HerdrSnapshot } from "./types.js";
import type { HerdrSocketClient } from "./socket-client.js";
import { HerdrCli } from "./cli.js";
import {
  focus,
  interrupt,
  piSessionMatches,
  type OccupantGuard,
} from "./controls.js";
import { HerdrProcessRunner } from "./runner.js";
import { projectCapabilities } from "./capabilities.js";
import { isAbsolute, join, resolve } from "node:path";
import type { CanonicalResolvedPaths } from "../shared/paths.js";
import { collectGitEvidence } from "../git/evidence.js";
import type { GitEvidence } from "../git/porcelain.js";
import { doctor, type DoctorReport } from "../broker/doctor.js";
import { authoritativeHerdrBinary, revalidateHerdrBinary } from "./binary.js";
export class ProvisionOutcomeRecordingError extends AggregateError {
  readonly provisionError: unknown;
  readonly outcomeError: unknown;
  constructor(provisionError: unknown, outcomeError: unknown) {
    super(
      [provisionError, outcomeError],
      "Provisioning failed and its durable outcome could not be recorded.",
      { cause: provisionError },
    );
    this.name = "ProvisionOutcomeRecordingError";
    this.provisionError = provisionError;
    this.outcomeError = outcomeError;
  }
}
export interface HerdrServiceOptions {
  store: EventStore;
  cli: HerdrCli;
  provisioner: HerdrProvisioner;
  actor?: { principalId: string; kind: string };
  watcher?: HerdrSocketClient;
  gitEvidence?: (cwd: string, base?: string) => Promise<GitEvidence>;
  preflight?: () => Promise<void>;
  diagnostic?: () => Promise<DoctorReport>;
}
const actor = { principalId: "prn_00000000000000000000000000", kind: "system" };
interface ExactPiPaneIdentity {
  paneId: string;
  terminalId: string;
  workspaceId?: string;
  tabId?: string;
  cwd?: string;
  worktreeId?: string;
  worktreePath?: string;
  generation?: number;
}
export interface RetainedTabGuard extends OccupantGuard {
  workspaceId: string;
  tabId: string;
}
function exactRetainedPane(
  snapshot: HerdrSnapshot,
  guard: RetainedTabGuard,
  requireVacant: boolean,
): void {
  const panes = snapshot.panes.filter((item) => item.id === guard.paneId);
  const tabs = snapshot.tabs.filter((item) => item.id === guard.tabId);
  const workspaces = snapshot.workspaces.filter(
    (item) => item.id === guard.workspaceId,
  );
  const pane = panes[0];
  const occupants = snapshot.agents.filter(
    (item) =>
      item.paneId === guard.paneId || item.terminalId === guard.terminalId,
  );
  if (
    panes.length !== 1 ||
    tabs.length !== 1 ||
    workspaces.length !== 1 ||
    !pane ||
    pane.terminalId !== guard.terminalId ||
    pane.workspaceId !== guard.workspaceId ||
    pane.tabId !== guard.tabId ||
    snapshot.panes.filter((item) => item.terminalId === guard.terminalId)
      .length !== 1 ||
    (requireVacant && occupants.length !== 0) ||
    (!requireVacant && occupants.length !== 1)
  )
    throw new Error("HERDR_IDENTITY_MISMATCH");
}
function exactRetainedTabAbsent(
  snapshot: HerdrSnapshot,
  guard: RetainedTabGuard,
): boolean {
  const exactWorkspace = snapshot.workspaces.filter(
    (item) => item.id === guard.workspaceId,
  );
  const conflictingResource =
    snapshot.tabs.some((item) => item.id === guard.tabId) ||
    snapshot.panes.some(
      (item) =>
        item.id === guard.paneId || item.terminalId === guard.terminalId,
    ) ||
    snapshot.agents.some(
      (item) =>
        item.paneId === guard.paneId || item.terminalId === guard.terminalId,
    );
  if (exactWorkspace.length > 1 || conflictingResource)
    throw new Error("HERDR_IDENTITY_MISMATCH");
  return true;
}
function exactPiPane(
  snapshot: HerdrSnapshot,
  paneId: string,
  expectedTerminalId?: string,
  expectedAgentId?: string,
  expectedSessionReference?: HerdrSessionReference,
  expectedLegacySessionId?: string,
): ExactPiPaneIdentity {
  const panes = snapshot.panes.filter((item) => item.id === paneId);
  if (panes.length !== 1) throw new Error("HERDR_IDENTITY_MISMATCH");
  const pane = panes[0]!;
  const terminalId = pane.terminalId;
  const terminalPanes = terminalId
    ? snapshot.panes.filter((item) => item.terminalId === terminalId)
    : [];
  const terminalAgents = terminalId
    ? snapshot.agents.filter((item) => item.terminalId === terminalId)
    : [];
  const paneAgents = snapshot.agents.filter((item) => item.paneId === paneId);
  const occupant =
    snapshot.agents.length > 0
      ? terminalAgents.length === 1
        ? terminalAgents[0]
        : undefined
      : pane.occupant;
  if (
    !terminalId ||
    terminalPanes.length !== 1 ||
    !occupant ||
    (occupant.kind !== "pi" &&
      !(snapshot.agents.length === 0 && occupant.kind === undefined)) ||
    occupant.terminalId !== terminalId ||
    (snapshot.agents.length > 0 && occupant.paneId !== paneId) ||
    (expectedTerminalId !== undefined && expectedTerminalId !== terminalId) ||
    (expectedAgentId !== undefined &&
      occupant.agentId !== undefined &&
      occupant.agentId !== expectedAgentId) ||
    (expectedLegacySessionId !== undefined &&
      !piSessionMatches(
        expectedLegacySessionId,
        occupant.sessionId,
        occupant.sessionReference,
      )) ||
    (expectedSessionReference !== undefined &&
      (!occupant.sessionReference ||
        occupant.sessionReference.source !== expectedSessionReference.source ||
        occupant.sessionReference.agent !== expectedSessionReference.agent ||
        occupant.sessionReference.kind !== expectedSessionReference.kind ||
        occupant.sessionReference.value !== expectedSessionReference.value)) ||
    (snapshot.agents.length > 0 &&
      (!pane.workspaceId ||
        !pane.tabId ||
        occupant.workspaceId !== pane.workspaceId ||
        occupant.tabId !== pane.tabId)) ||
    (snapshot.agents.length === 0 &&
      occupant.workspaceId !== undefined &&
      pane.workspaceId !== undefined &&
      occupant.workspaceId !== pane.workspaceId) ||
    (snapshot.agents.length === 0 &&
      occupant.tabId !== undefined &&
      pane.tabId !== undefined &&
      occupant.tabId !== pane.tabId)
  )
    throw new Error("HERDR_IDENTITY_MISMATCH");
  const exactReference = expectedSessionReference ?? occupant.sessionReference;
  const referenceAgents = exactReference
    ? snapshot.agents.filter(
        (item) =>
          item.sessionReference?.source === exactReference.source &&
          item.sessionReference.agent === exactReference.agent &&
          item.sessionReference.kind === exactReference.kind &&
          item.sessionReference.value === exactReference.value,
      )
    : [];
  if (
    snapshot.agents.length > 0 &&
    (paneAgents.length !== 1 ||
      (exactReference !== undefined && referenceAgents.length !== 1))
  )
    throw new Error("HERDR_IDENTITY_MISMATCH");
  const workspaces = pane.workspaceId
    ? snapshot.workspaces.filter((item) => item.id === pane.workspaceId)
    : [];
  const tabs = pane.tabId
    ? snapshot.tabs.filter((item) => item.id === pane.tabId)
    : [];
  const worktrees =
    snapshot.agents.length === 0
      ? snapshot.worktrees.filter(
          (item) =>
            item.workspaceId === pane.workspaceId &&
            item.rootPaneId === pane.id,
        )
      : [];
  const workspace = workspaces[0];
  const workspaceWorktree = workspace?.worktree;
  if (
    (snapshot.agents.length > 0 &&
      (workspaces.length !== 1 ||
        tabs.length !== 1 ||
        tabs[0]?.workspaceId !== pane.workspaceId)) ||
    (snapshot.agents.length === 0 &&
      (workspaces.length > 1 || tabs.length > 1)) ||
    worktrees.length > 1 ||
    workspace?.worktreeInvalid === true ||
    (workspaceWorktree !== undefined &&
      (!isAbsolute(workspaceWorktree.repoRoot) ||
        resolve(workspaceWorktree.repoRoot) !== workspaceWorktree.repoRoot ||
        !isAbsolute(workspaceWorktree.checkoutPath) ||
        resolve(workspaceWorktree.checkoutPath) !==
          workspaceWorktree.checkoutPath))
  )
    throw new Error("HERDR_IDENTITY_MISMATCH");
  const cwd =
    workspaceWorktree?.checkoutPath ??
    pane.cwd ??
    tabs[0]?.cwd ??
    workspace?.cwd;
  return {
    paneId,
    terminalId,
    ...(pane.workspaceId ? { workspaceId: pane.workspaceId } : {}),
    ...(pane.tabId ? { tabId: pane.tabId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(worktrees[0]?.id ? { worktreeId: worktrees[0].id } : {}),
    ...(workspaceWorktree?.checkoutPath
      ? { worktreePath: workspaceWorktree.checkoutPath }
      : {}),
    ...(typeof occupant.generation === "number"
      ? { generation: occupant.generation }
      : {}),
  };
}
function samePaneIdentity(
  left: ExactPiPaneIdentity,
  right: ExactPiPaneIdentity,
): boolean {
  return (
    left.paneId === right.paneId &&
    left.terminalId === right.terminalId &&
    left.workspaceId === right.workspaceId &&
    left.tabId === right.tabId &&
    left.cwd === right.cwd &&
    left.worktreeId === right.worktreeId &&
    left.worktreePath === right.worktreePath &&
    left.generation === right.generation
  );
}
export class HerdrService {
  readonly #store: EventStore;
  readonly #cli: HerdrCli;
  readonly #provisioner: HerdrProvisioner;
  readonly #actor: { principalId: string; kind: string };
  readonly #watcher: HerdrSocketClient | undefined;
  readonly #pending = new Map<string, ProvisionResult>();
  readonly #preflight: (() => Promise<void>) | undefined;
  readonly #diagnostic: (() => Promise<DoctorReport>) | undefined;
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
    this.#diagnostic = options.diagnostic;
  }
  get store(): EventStore {
    return this.#store;
  }
  get resources() {
    return this.#store.state.herdrResources ?? {};
  }
  async diagnose(): Promise<DoctorReport> {
    if (!this.#diagnostic) throw new Error("HERDR_DOCTOR_UNAVAILABLE");
    return await this.#diagnostic();
  }
  async verifyRoot(identity: {
    paneId: string;
    terminalId?: string;
    sessionId?: string;
    generation?: number;
    sessionReference?: HerdrSessionReference;
  }): Promise<{
    paneId: string;
    terminalId: string;
    workspaceId?: string;
    tabId?: string;
    cwd?: string;
    worktreeId?: string;
  }> {
    await this.#preflight?.();
    this.#cli.requireMutationCapabilities(["session.snapshot"]);
    const snapshot = await this.#cli.snapshot();
    const {
      worktreePath: _worktreePath,
      generation: _generation,
      ...resolved
    } = exactPiPane(
      snapshot,
      identity.paneId,
      identity.terminalId,
      undefined,
      identity.sessionReference,
      identity.sessionId,
    );
    return resolved;
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
    const context = await this.verifyRoot(identity);
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
        paneId: context.paneId,
        terminalId: context.terminalId,
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
        input.isolation === "worktree" && !input.reuseWorktreeId
          ? [
              "tab.create",
              "agent.start",
              "worktree.create",
              "worktree.remove",
              "tab.close",
              "pane.close",
            ]
          : input.placement === "new-workspace"
            ? [
                "workspace.create",
                "workspace.close",
                "agent.start",
                "tab.close",
                "pane.close",
              ]
            : ["tab.create", "agent.start", "tab.close", "pane.close"],
      );
      const beforeGit =
        input.isolation === "worktree" &&
        !input.reuseWorktreeId &&
        this.#gitEvidence
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
            workspaceId: result.workspaceId ?? input.workspaceId,
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
        try {
          await this.#store.append({
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
          });
        } catch (outcomeError) {
          throw new ProvisionOutcomeRecordingError(error, outcomeError);
        }
        throw error;
      }
    });
  }
  async verifyManagedPane(
    agentId: string,
    identity: {
      paneId: string;
      terminalId?: string;
      sessionReference?: HerdrSessionReference;
    },
  ): Promise<ExactPiPaneIdentity> {
    await this.#preflight?.();
    const resource = this.resources[agentId];
    if (!resource?.paneId || resource.paneId !== identity.paneId)
      throw new Error("HERDR_REGISTRATION_IDENTITY_MISMATCH");
    try {
      return exactPiPane(
        await this.#cli.snapshot(),
        resource.paneId,
        identity.terminalId ?? resource.terminalId,
        resource.ownerId,
        identity.sessionReference,
      );
    } catch {
      throw new Error("HERDR_REGISTRATION_IDENTITY_MISMATCH");
    }
  }
  async register(
    agentId: string,
    identity: {
      paneId: string;
      terminalId?: string;
      sessionId?: string;
      generation?: number;
      sessionReference?: HerdrSessionReference;
    },
    supplied?: ProvisionResult,
    tokenProof?: string,
  ): Promise<ExactPiPaneIdentity> {
    return await this.withAgentLock(agentId, async () => {
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
      if (!resource.paneId || resource.paneId !== identity.paneId)
        throw new Error("HERDR_REGISTRATION_IDENTITY_MISMATCH");
      const snapshot = await this.#cli.snapshot();
      let resolved: ExactPiPaneIdentity;
      try {
        resolved = exactPiPane(
          snapshot,
          resource.paneId,
          identity.terminalId,
          resource.ownerId,
          identity.sessionReference,
          identity.sessionId,
        );
      } catch {
        throw new Error("HERDR_REGISTRATION_IDENTITY_MISMATCH");
      }
      await this.#provisioner.verifyRegistration(
        result,
        identity,
        tokenProof,
        false,
      );
      const cleanupOutcome =
        await this.#provisioner.cleanupRegistration(result);
      let finalIdentity: ExactPiPaneIdentity;
      try {
        finalIdentity = exactPiPane(
          await this.#cli.snapshot(),
          resource.paneId,
          resolved.terminalId,
          resource.ownerId,
          identity.sessionReference,
          identity.sessionId,
        );
        if (!samePaneIdentity(resolved, finalIdentity))
          throw new Error("HERDR_REGISTRATION_IDENTITY_MISMATCH");
      } catch (primary) {
        try {
          await this.recordLifecycle(
            agentId,
            "pending",
            "registration_identity_mismatch",
            true,
          );
        } catch (eventError) {
          throw new AggregateError(
            [primary, eventError],
            "Registration identity mismatch and outcome recording failed.",
          );
        }
        throw new Error("HERDR_REGISTRATION_IDENTITY_MISMATCH", {
          cause: primary,
        });
      }
      await this.#store.append({
        type: "herdr.provision.outcome",
        actor: this.#actor,
        entityRefs: { agentId },
        payload: {
          agentId,
          state: "registered",
          paneId: finalIdentity.paneId,
          terminalId: finalIdentity.terminalId,
          ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
          generation: result.token.generation,
          tokenDigest: result.token.digest,
          registrationDeadline: undefined,
          cleanupOutcome,
        },
      });
      this.#pending.delete(agentId);
      const timer = this.#expiryTimers.get(agentId);
      if (timer) clearTimeout(timer);
      this.#expiryTimers.delete(agentId);
      return finalIdentity;
    });
  }
  async recordRegistrationMismatch(agentId: string): Promise<void> {
    await this.withAgentLock(agentId, async () => {
      const pending = this.#pending.get(agentId);
      if (pending) {
        await this.#provisioner.compensate(pending, agentId);
        await this.#provisioner.cleanupRegistration(pending);
      }
      await this.recordLifecycle(
        agentId,
        "replaced",
        "registration_mismatch_compensated",
        true,
      );
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
  async reportTaskMetadata(
    guard: RetainedTabGuard,
    metadata: HerdrTaskMetadata,
    eventSequence: number,
  ): Promise<void> {
    const safe = /^[A-Za-z0-9_.:-]{1,128}$/u;
    const tokens = {
      task: metadata.taskId,
      run: metadata.runId,
      parent: metadata.parentAgentId ?? "root",
      profile: metadata.profileId,
      placement: metadata.placement,
      transcript: metadata.transcriptPolicy,
      lifecycle: metadata.state,
    };
    if (
      !Number.isSafeInteger(eventSequence) ||
      eventSequence < 1 ||
      Object.values(tokens).some((value) => !safe.test(value))
    )
      throw new Error("HERDR_METADATA_INVALID");
    await this.withAgentLock(metadata.agentId, async () => {
      await this.#preflight?.();
      this.#cli.requireMutationCapabilities([
        "pane.report_metadata",
        "session.snapshot",
      ]);
      exactPiPane(
        await this.#cli.snapshot(),
        guard.paneId,
        guard.terminalId,
        undefined,
        undefined,
        guard.sessionId,
      );
      await this.#cli.reportPaneMetadata({
        paneId: guard.paneId,
        title: `Task ${metadata.taskId.slice(-8)} · ${metadata.state}`,
        tokens,
        sequence: eventSequence,
      });
      exactPiPane(
        await this.#cli.snapshot(),
        guard.paneId,
        guard.terminalId,
        undefined,
        undefined,
        guard.sessionId,
      );
    });
  }
  async exitRetainingTab(guard: RetainedTabGuard): Promise<void> {
    const agentId = this.agentForPane(guard.paneId) ?? `pane:${guard.paneId}`;
    await this.withAgentLock(agentId, async () => {
      await this.#preflight?.();
      this.#cli.requireMutationCapabilities([
        "agent.prompt",
        "session.snapshot",
      ]);
      const before = await this.#cli.snapshot();
      const occupants = before.agents.filter(
        (item) =>
          item.paneId === guard.paneId || item.terminalId === guard.terminalId,
      );
      if (occupants.length === 0) {
        exactRetainedPane(before, guard, true);
        if (!agentId.startsWith("pane:"))
          await this.recordLifecycle(agentId, "stopped", "retained_tab_exit");
        return;
      }
      exactRetainedPane(before, guard, false);
      exactPiPane(
        before,
        guard.paneId,
        guard.terminalId,
        undefined,
        undefined,
        guard.sessionId,
      );
      await this.#cli.quitAgent(guard.paneId);
      for (let attempt = 0; attempt < 40; attempt++) {
        const snapshot = await this.#cli.snapshot();
        const occupants = snapshot.agents.filter(
          (item) =>
            item.paneId === guard.paneId ||
            item.terminalId === guard.terminalId,
        );
        if (occupants.length === 0) {
          exactRetainedPane(snapshot, guard, true);
          if (!agentId.startsWith("pane:"))
            await this.recordLifecycle(agentId, "stopped", "retained_tab_exit");
          return;
        }
        exactPiPane(
          snapshot,
          guard.paneId,
          guard.terminalId,
          undefined,
          undefined,
          guard.sessionId,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("HERDR_PROCESS_EXIT_TIMEOUT");
    });
  }
  async closeRetainedTab(guard: RetainedTabGuard): Promise<void> {
    const agentId = this.agentForPane(guard.paneId) ?? `pane:${guard.paneId}`;
    await this.withAgentLock(agentId, async () => {
      await this.#preflight?.();
      this.#cli.requireMutationCapabilities(["tab.close", "session.snapshot"]);
      const before = await this.#cli.snapshot();
      if (!before.tabs.some((item) => item.id === guard.tabId)) {
        exactRetainedTabAbsent(before, guard);
        return;
      }
      exactRetainedPane(before, guard, true);
      await this.#cli.closeTab(guard.tabId);
      const after = await this.#cli.snapshot();
      if (
        after.tabs.some((item) => item.id === guard.tabId) ||
        after.panes.some(
          (item) =>
            item.id === guard.paneId || item.terminalId === guard.terminalId,
        ) ||
        after.agents.some(
          (item) =>
            item.paneId === guard.paneId ||
            item.terminalId === guard.terminalId,
        )
      )
        throw new Error("HERDR_IDENTITY_MISMATCH");
      if (!agentId.startsWith("pane:"))
        await this.recordLifecycle(agentId, "closed", "retained_tab_closed");
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
      if (resource?.state === "closed") return;
      if (resource?.state === "missing") {
        const snapshot = await this.#cli.snapshot();
        const terminalId = guard.terminalId ?? resource.terminalId;
        const expectedAgentId = resource.ownerId ?? resource.agentId;
        const recordedLocationPresent =
          snapshot.panes.some(
            (pane) =>
              pane.id === guard.paneId ||
              (terminalId !== undefined &&
                (pane.terminalId === terminalId ||
                  pane.occupant?.terminalId === terminalId)),
          ) ||
          snapshot.agents.some(
            (agent) =>
              agent.paneId === guard.paneId ||
              (terminalId !== undefined && agent.terminalId === terminalId),
          );
        const managedIdentityPresent =
          snapshot.agents.some((agent) => agent.agentId === expectedAgentId) ||
          snapshot.panes.some(
            (pane) => pane.occupant?.agentId === expectedAgentId,
          );
        const hasRecordedWorktree =
          resource.worktreeId !== undefined ||
          resource.worktreePath !== undefined;
        const recordedWorkspacePresent =
          hasRecordedWorktree &&
          resource.workspaceId !== undefined &&
          snapshot.workspaces.some(
            (workspace) => workspace.id === resource.workspaceId,
          );
        const recordedWorktreePresent =
          (resource.worktreeId !== undefined &&
            snapshot.worktrees.some(
              (worktree) => worktree.id === resource.worktreeId,
            )) ||
          (resource.worktreePath !== undefined &&
            snapshot.worktrees.some(
              (worktree) => worktree.path === resource.worktreePath,
            ));
        const worktreeAbsenceProven =
          !hasRecordedWorktree ||
          (snapshot.worktreeInventoryPresent === true &&
            !recordedWorktreePresent);
        if (!recordedLocationPresent) {
          if (
            managedIdentityPresent ||
            recordedWorkspacePresent ||
            recordedWorktreePresent ||
            !worktreeAbsenceProven
          )
            throw new Error("HERDR_IDENTITY_MISMATCH");
          await this.recordLifecycle(agentId, "closed", "already_absent");
          return;
        }
      }
      if (resource?.dirty) throw new Error("HERDR_DIRTY_WORKTREE");
      if (resource?.worktreeId && !resource.worktreePath)
        throw new Error("HERDR_GIT_EVIDENCE_UNKNOWN");
      if (resource?.worktreePath) {
        if (!this.#gitEvidence) throw new Error("HERDR_GIT_EVIDENCE_UNKNOWN");
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
      if (!agentId.startsWith("pane:"))
        await this.recordLifecycle(
          agentId,
          "closing",
          "mutation_pending",
          true,
        );
      let removedWorktree = false;
      await revalidateAndRun(this.#cli, guard, async (identity) => {
        if (resource?.worktreePath && !resource.worktreeId) {
          if (
            !identity.workspaceId ||
            identity.worktreePath !== resource.worktreePath
          )
            throw new Error("HERDR_IDENTITY_MISMATCH");
          await this.#cli.removeWorktree(identity.workspaceId);
          removedWorktree = true;
        } else {
          await this.#cli.closePane(guard.paneId);
        }
      });
      if (!agentId.startsWith("pane:"))
        await this.recordLifecycle(
          agentId,
          "closed",
          removedWorktree
            ? "worktree_removed"
            : resource?.worktreePath
              ? "retained_worktree"
              : "close_succeeded",
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
        const cleanupOutcome = await this.#provisioner
          .cleanupRegistration(result)
          .catch(() => "retained_registration_files" as const);
        this.#pending.delete(agentId);
        await this.recordLifecycle(agentId, "timed_out", cleanupOutcome, true);
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
        const cleanupOutcome = await this.#provisioner
          .cleanupRegistration(result)
          .catch(() => "retained_registration_files" as const);
        this.#pending.delete(agentId);
        await this.recordLifecycle(agentId, "timed_out", cleanupOutcome, true);
      }
    }
    const current = snapshot ?? (await this.#cli.snapshot());
    const agents = Object.values(this.#store.state.agents);
    const results = reconcileAgents(agents, current, this.resources);
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
            ...(result.terminalId ? { terminalId: result.terminalId } : {}),
            ...(result.worktreeId ? { worktreeId: result.worktreeId } : {}),
            ...(result.worktreePath
              ? { worktreePath: result.worktreePath }
              : {}),
            ...(result.workspaceId ? { workspaceId: result.workspaceId } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
          },
        })
        .catch(() => undefined);
    }
    return results;
  }
  shutdown(): void {
    this.#watchAbort.abort();
    for (const timer of this.#expiryTimers.values()) clearTimeout(timer);
    this.#expiryTimers.clear();
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
function legacyOccupantIdentity(
  snapshot: HerdrSnapshot,
  guard: OccupantGuard,
): ExactPiPaneIdentity {
  const pane = snapshot.panes.find((item) => item.id === guard.paneId);
  const occupant = pane?.occupant;
  const terminalId = occupant?.terminalId ?? pane?.terminalId;
  if (
    !pane ||
    !occupant ||
    (guard.terminalId !== undefined && terminalId !== guard.terminalId) ||
    (guard.sessionId !== undefined &&
      !piSessionMatches(
        guard.sessionId,
        occupant.sessionId,
        occupant.sessionReference,
      ))
  )
    throw new Error("HERDR_IDENTITY_MISMATCH");
  const workspaces = pane.workspaceId
    ? snapshot.workspaces.filter((item) => item.id === pane.workspaceId)
    : [];
  if (workspaces.length > 1 || workspaces[0]?.worktreeInvalid === true)
    throw new Error("HERDR_IDENTITY_MISMATCH");
  const worktreePath = workspaces[0]?.worktree?.checkoutPath;
  return {
    paneId: pane.id,
    terminalId: terminalId ?? "legacy-terminal",
    ...(pane.workspaceId ? { workspaceId: pane.workspaceId } : {}),
    ...(pane.tabId ? { tabId: pane.tabId } : {}),
    ...(pane.cwd ? { cwd: pane.cwd } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(typeof occupant.generation === "number"
      ? { generation: occupant.generation }
      : {}),
  };
}

async function revalidateAndRun(
  cli: HerdrCli,
  guard: OccupantGuard,
  action: (identity: ExactPiPaneIdentity) => Promise<void>,
): Promise<void> {
  const snapshot = await cli.snapshot();
  const identity =
    snapshot.agents.length > 0
      ? exactPiPane(
          snapshot,
          guard.paneId,
          guard.terminalId,
          undefined,
          undefined,
          guard.sessionId,
        )
      : legacyOccupantIdentity(snapshot, guard);
  if (
    guard.generation !== undefined &&
    identity.generation !== guard.generation
  )
    throw new Error("HERDR_IDENTITY_MISMATCH");
  await action(identity);
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
  paths: CanonicalResolvedPaths,
  binary = process.env.HERDR_BIN_PATH,
): Promise<HerdrService> {
  const binaryIdentity = await authoritativeHerdrBinary(binary);
  const runner = new HerdrProcessRunner({
    binary: binaryIdentity.path,
    revalidate: () => revalidateHerdrBinary(binaryIdentity),
  });
  const schema = await runner.json(["api", "schema", "--json"]);
  const capabilities = projectCapabilities(schema, binaryIdentity.path);
  capabilities.require(Object.keys(capabilities.mandatory));
  const cli = new HerdrCli(runner, capabilities);
  const socketPath = paths.herdrSocket;
  if (!socketPath.startsWith("/"))
    throw new Error("HERDR_UNAVAILABLE: socket is not configured.");
  const adapterIdentity = "pi-herdr-orchestrator";
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
      {
        socketPath: paths.socket,
        sessionKey: paths.sessionKey,
        herdrBinary: binaryIdentity.path,
      },
    ),
    gitEvidence: collectGitEvidence,
    preflight: async () => {
      await revalidateHerdrBinary(binaryIdentity);
      await runProductionPreflight({
        runner,
        binary: binaryIdentity.path,
        socketPath,
        expectedSchemaHash,
        ...(adapterIdentity !== undefined ? { adapterIdentity } : {}),
        expectedBinaryIdentity: binaryIdentity.path,
        binaryIdentity: binaryIdentity.path,
      });
    },
    diagnostic: async () => {
      await revalidateHerdrBinary(binaryIdentity);
      const report = await doctor({
        herdrBinary: binaryIdentity.path,
        herdrSocket: socketPath,
        schema: await runner.json(["api", "schema", "--json"]),
      });
      await revalidateHerdrBinary(binaryIdentity);
      return report;
    },
  });
}
