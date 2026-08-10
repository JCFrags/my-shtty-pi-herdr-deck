import type { HerdrCli } from "./cli.js";
import { branchSlug, herdrName, label } from "./names.js";
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
      };
    } catch (error) {
      if (prompt) await deletePromptFile(prompt).catch(() => undefined);
      if (tokenFile) await deletePromptFile(tokenFile).catch(() => undefined);
      // Revalidate each resource immediately before destructive compensation.
      // An empty fake snapshot is treated as legacy evidence; a reported
      // occupant or worktree must match the resource we created.
      if (paneId && (await this.ownsPane(paneId, input.agentId)).safe)
        await this.cli.closePane(paneId).catch(() => undefined);
      if (tabId && (await this.ownsTab(tabId, paneId)).safe)
        await this.cli.closeTab(tabId).catch(() => undefined);
      if (
        unusedTabId &&
        unusedTabId !== tabId &&
        (await this.ownsTab(unusedTabId)).safe
      )
        await this.cli.closeTab(unusedTabId).catch(() => undefined);
      if (
        worktreeId &&
        (await this.ownsWorktree(worktreeId, worktreePath)).safe
      )
        await this.cli.removeWorktree(worktreeId).catch(() => undefined);
      throw error;
    }
  }
  private async ownsPane(
    id: string,
    expectedAgentId: string,
  ): Promise<{ safe: boolean }> {
    try {
      const snapshot = await this.cli.snapshot();
      const pane = snapshot.panes.find((item) => item.id === id);
      if (!pane) return { safe: true };
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
          !tab ||
          tab.panes.length === 0 ||
          (!!expectedPaneId && tab.panes.some((p) => p.id === expectedPaneId)),
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
        safe: !worktree || (!!expectedPath && worktree.path === expectedPath),
      };
    } catch {
      return { safe: false };
    }
  }
  async cleanupRegistration(result: ProvisionResult): Promise<void> {
    if (result.promptPath) await deletePromptFile(result.promptPath);
    if (result.tokenFilePath) await deletePromptFile(result.tokenFilePath);
  }
  async verifyRegistration(
    result: ProvisionResult,
    identity: { paneId: string; generation?: number },
  ): Promise<void> {
    if (
      !result.tokenFilePath ||
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
