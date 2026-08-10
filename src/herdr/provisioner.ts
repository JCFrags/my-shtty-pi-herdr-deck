import type { HerdrCli } from "./cli.js";
import { branchSlug, herdrName, label } from "./names.js";
import type { GitEvidence } from "../git/porcelain.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createManagedToken,
  createManagedTokenFile,
  createPromptFile,
  deletePromptFile,
  verifyManagedTokenFile,
  type ManagedToken,
} from "./token-files.js";
export interface ProvisionInput {
  agentId: string;
  parentAgentId: string;
  role: string;
  workspaceId: string;
  cwd: string;
  profileId: string;
  isolation: "shared-readonly" | "worktree";
  prompt: string;
  projectBase?: string;
  branch?: string;
  env?: Record<string, string>;
}
export interface ProvisionResult {
  name: string;
  token: ManagedToken;
  tabId?: string;
  paneId?: string;
  worktreeId?: string;
  worktreePath?: string;
  unusedTabId?: string;
  promptPath?: string;
  tokenFilePath?: string;
}
export class HerdrProvisioner {
  constructor(
    readonly cli: HerdrCli,
    readonly promptRoot: string,
    readonly liveNames: () => Iterable<string> = () => [],
    readonly retainRegistrationFiles = false,
    readonly gitEvidence?: (cwd: string, base?: string) => Promise<GitEvidence>,
  ) {}
  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const token = createManagedToken();
    const name = herdrName(input.role, input.agentId, this.liveNames());
    let tokenFile: string | undefined;
    const managed = {
      PI_HERDR_ORCH_MANAGED: "1",
      PI_HERDR_ORCH_AGENT_ID: input.agentId,
      PI_HERDR_ORCH_PARENT_AGENT_ID: input.parentAgentId,
      PI_HERDR_ORCH_PROFILE_ID: input.profileId,
      PI_HERDR_ORCH_TOKEN_FILE: "",
    };
    const forbidden = Object.keys(input.env ?? {}).filter(
      (key) =>
        Object.hasOwn(managed, key) || key === "PI_HERDR_ORCH_AGENT_TOKEN",
    );
    if (forbidden.length)
      throw new Error(
        `Managed environment override rejected: ${forbidden.join(", ")}`,
      );
    const env = { ...managed, ...(input.env ?? {}) };
    let prompt: string | undefined;
    let tabId: string | undefined;
    let paneId: string | undefined;
    let worktreePath: string | undefined;
    let worktreeId: string | undefined;
    let unusedTabId: string | undefined;
    try {
      prompt = await createPromptFile(
        this.promptRoot,
        input.agentId,
        input.prompt,
      );
      tokenFile = await createManagedTokenFile(
        this.promptRoot,
        input.agentId,
        token,
      );
      managed.PI_HERDR_ORCH_TOKEN_FILE = tokenFile;
      if (input.isolation === "worktree") {
        const wt = await this.cli.createWorktree({
          workspaceId: input.workspaceId,
          branch: branchSlug(input.branch ?? input.agentId),
          base: input.projectBase ?? "HEAD",
          label: label(input.role),
        });
        const r = wt as Record<string, unknown>;
        worktreePath = typeof r.path === "string" ? r.path : undefined;
        worktreeId = typeof r.id === "string" ? r.id : undefined;
        const workspace =
          typeof r.workspace_id === "string"
            ? r.workspace_id
            : input.workspaceId;
        const created = await this.cli.createTab({
          workspaceId: workspace,
          cwd: worktreePath ?? input.cwd,
          label: label(input.role),
          env,
        });
        const cr = created as Record<string, unknown>;
        tabId =
          typeof cr.tab_id === "string"
            ? cr.tab_id
            : typeof cr.id === "string"
              ? cr.id
              : undefined;
        paneId =
          typeof cr.root_pane_id === "string"
            ? cr.root_pane_id
            : typeof (cr.root_pane as Record<string, unknown> | undefined)
                  ?.pane_id === "string"
              ? ((cr.root_pane as Record<string, unknown>).pane_id as string)
              : undefined;
        unusedTabId = typeof r.tab_id === "string" ? r.tab_id : undefined;
      } else {
        const created = await this.cli.createTab({
          workspaceId: input.workspaceId,
          cwd: input.cwd,
          label: label(input.role),
          env,
        });
        const r = created as Record<string, unknown>;
        tabId =
          typeof r.tab_id === "string"
            ? r.tab_id
            : typeof r.id === "string"
              ? r.id
              : undefined;
        paneId =
          typeof r.root_pane_id === "string"
            ? r.root_pane_id
            : typeof (r.root_pane as Record<string, unknown> | undefined)
                  ?.pane_id === "string"
              ? ((r.root_pane as Record<string, unknown>).pane_id as string)
              : undefined;
      }
      if (!tabId)
        throw new Error("HERDR_COMMAND_FAILED: tab identity missing.");
      if (!paneId)
        throw new Error("HERDR_COMMAND_FAILED: pane identity missing.");
      const started = await this.cli.startPi({
        name,
        paneId,
        args: ["--name", name, "--append-system-prompt", prompt],
        timeoutMs: 30_000,
      });
      const sr = started as Record<string, unknown>;
      if (unusedTabId && unusedTabId !== tabId) {
        await this.cli.closeTab(unusedTabId);
      }
      if (!this.retainRegistrationFiles) {
        if (prompt) await deletePromptFile(prompt);
        if (tokenFile) await deletePromptFile(tokenFile);
      }
      return {
        name,
        token,
        tabId,
        ...(this.retainRegistrationFiles && prompt
          ? { promptPath: prompt }
          : {}),
        ...(this.retainRegistrationFiles && tokenFile
          ? { tokenFilePath: tokenFile }
          : {}),
        paneId: typeof sr.pane_id === "string" ? sr.pane_id : paneId,
        ...(worktreeId ? { worktreeId } : {}),
        ...(worktreePath ? { worktreePath } : {}),
        ...(unusedTabId ? { unusedTabId } : {}),
      };
    } catch (error) {
      if (prompt) await deletePromptFile(prompt).catch(() => undefined);
      if (tokenFile) await deletePromptFile(tokenFile).catch(() => undefined);
      // Revalidate each resource immediately before destructive compensation.
      // Missing or ambiguous snapshots are not proof of ownership.
      if (
        worktreeId &&
        (await this.ownsWorktree(worktreeId, worktreePath)).safe &&
        !!worktreePath &&
        !!this.gitEvidence &&
        !(await this.gitEvidence(worktreePath)).dirty
      )
        await this.cli.removeWorktree(worktreeId).catch(() => undefined);
      if (
        unusedTabId &&
        unusedTabId !== tabId &&
        (await this.ownsTab(unusedTabId)).safe
      )
        await this.cli.closeTab(unusedTabId).catch(() => undefined);
      if (tabId && (await this.ownsTab(tabId, paneId)).safe)
        await this.cli.closeTab(tabId).catch(() => undefined);
      if (paneId && (await this.ownsPane(paneId, input.agentId)).safe)
        await this.cli.closePane(paneId).catch(() => undefined);
      throw error;
    }
  }
  async compensate(
    result: ProvisionResult,
    expectedAgentId: string,
  ): Promise<void> {
    if (
      result.worktreeId &&
      (await this.ownsWorktree(result.worktreeId, result.worktreePath)).safe &&
      result.worktreePath &&
      this.gitEvidence
    ) {
      const evidence = await this.gitEvidence(result.worktreePath).catch(
        () => undefined,
      );
      if (evidence && !evidence.dirty)
        await this.cli.removeWorktree(result.worktreeId).catch(() => undefined);
    }
    if (
      result.unusedTabId &&
      result.unusedTabId !== result.tabId &&
      (await this.ownsTab(result.unusedTabId)).safe
    )
      await this.cli.closeTab(result.unusedTabId).catch(() => undefined);
    if (result.tabId && (await this.ownsTab(result.tabId, result.paneId)).safe)
      await this.cli.closeTab(result.tabId).catch(() => undefined);
    if (
      result.paneId &&
      (await this.ownsPane(result.paneId, expectedAgentId)).safe
    )
      await this.cli.closePane(result.paneId).catch(() => undefined);
  }
  private async ownsPane(
    id: string,
    expectedAgentId: string,
  ): Promise<{ safe: boolean }> {
    try {
      const snapshot = await this.cli.snapshot();
      const pane = snapshot.panes.find((item) => item.id === id);
      if (!pane) return { safe: false };
      const occupant = pane.occupant;
      return {
        safe: !!occupant && occupant.agentId === expectedAgentId,
      };
    } catch {
      return { safe: false };
    }
  }
  private async ownsTab(
    id: string,
    expectedPaneId?: string,
  ): Promise<{ safe: boolean }> {
    try {
      const snapshot = await this.cli.snapshot();
      const tab = snapshot.tabs.find((item) => item.id === id);
      return {
        safe:
          !!tab &&
          !!expectedPaneId &&
          tab.panes.some((p) => p.id === expectedPaneId),
      };
    } catch {
      return { safe: false };
    }
  }
  private async ownsWorktree(
    id: string,
    expectedPath?: string,
  ): Promise<{ safe: boolean }> {
    try {
      const snapshot = await this.cli.snapshot();
      const worktree = snapshot.worktrees.find((item) => item.id === id);
      return {
        safe: !!worktree && !!expectedPath && worktree.path === expectedPath,
      };
    } catch {
      return { safe: false };
    }
  }
  async recoverRegistration(
    agentId: string,
    resource: {
      paneId?: string;
      tabId?: string;
      worktreeId?: string;
      worktreePath?: string;
      tokenDigest?: string;
      generation?: number;
    },
  ): Promise<ProvisionResult | undefined> {
    if (!resource.tokenDigest) return undefined;
    let names: string[];
    try {
      names = await readdir(this.promptRoot);
    } catch {
      return undefined;
    }
    const tokenName = names.find((name) =>
      name.startsWith(`.token-${agentId}-`),
    );
    const promptName = names.find((name) =>
      name.startsWith(`.prompt-${agentId}-`),
    );
    if (!tokenName) return undefined;
    return {
      name: agentId,
      token: {
        token: "",
        digest: resource.tokenDigest,
        generation: resource.generation ?? 1,
      },
      ...(resource.paneId ? { paneId: resource.paneId } : {}),
      ...(resource.tabId ? { tabId: resource.tabId } : {}),
      ...(resource.worktreeId ? { worktreeId: resource.worktreeId } : {}),
      ...(resource.worktreePath ? { worktreePath: resource.worktreePath } : {}),
      tokenFilePath: join(this.promptRoot, tokenName),
      ...(promptName ? { promptPath: join(this.promptRoot, promptName) } : {}),
    };
  }
  async cleanupRegistration(result: ProvisionResult): Promise<void> {
    if (result.promptPath) await deletePromptFile(result.promptPath);
    if (result.tokenFilePath) await deletePromptFile(result.tokenFilePath);
  }
  async verifyRegistration(
    result: ProvisionResult,
    identity: {
      paneId: string;
      terminalId?: string;
      sessionId?: string;
      generation?: number;
    },
    suppliedDigest?: string,
  ): Promise<void> {
    if (
      !result.tokenFilePath ||
      (suppliedDigest !== undefined &&
        suppliedDigest !== result.token.digest) ||
      !(await verifyManagedTokenFile(result.tokenFilePath, result.token.digest))
    )
      throw new Error("HERDR_REGISTRATION_TOKEN_INVALID");
    if (
      identity.paneId !== result.paneId ||
      (identity.generation !== undefined &&
        identity.generation !== result.token.generation)
    )
      throw new Error("HERDR_REGISTRATION_IDENTITY_MISMATCH");
    if (result.promptPath) await deletePromptFile(result.promptPath);
    await deletePromptFile(result.tokenFilePath);
  }
}
