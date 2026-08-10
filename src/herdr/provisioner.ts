import type { HerdrCli } from "./cli.js";
import { branchSlug, herdrName, label } from "./names.js";
import type { GitEvidence } from "../git/porcelain.js";
import { open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import {
  createManagedToken,
  createManagedTokenFile,
  createPromptFile,
  retainManagedFileForCleanup,
  verifyManagedTokenFile,
  type ManagedToken,
  type FileIdentity,
  managedFileIdentity,
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
  promptFileIdentity?: FileIdentity;
  tokenFileIdentity?: FileIdentity;
}
export interface RegistrationRetentionStatus {
  files: number;
  bytes: number;
  unsafeFiles: number;
  oldestMtimeMs?: number;
  maxFiles: number;
  maxBytes: number;
  maxAgeMs: number;
}
const RETENTION_MAX_FILES = 128;
const RETENTION_MAX_BYTES = 32 * 1024 * 1024;
const RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const retentionAdmissions = new Map<string, Promise<void>>();
async function withRetentionAdmission<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = retentionAdmissions.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  retentionAdmissions.set(root, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (retentionAdmissions.get(root) === current)
      retentionAdmissions.delete(root);
  }
}
export class HerdrProvisioner {
  constructor(
    readonly cli: HerdrCli,
    readonly promptRoot: string,
    readonly liveNames: () => Iterable<string> = () => [],
    readonly retainRegistrationFiles = false,
    readonly gitEvidence?: (cwd: string, base?: string) => Promise<GitEvidence>,
  ) {}
  async registrationRetentionStatus(): Promise<RegistrationRetentionStatus> {
    let names: string[];
    try {
      names = await readdir(this.promptRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          files: 0,
          bytes: 0,
          unsafeFiles: 0,
          maxFiles: RETENTION_MAX_FILES,
          maxBytes: RETENTION_MAX_BYTES,
          maxAgeMs: RETENTION_MAX_AGE_MS,
        };
      throw error;
    }
    let bytes = 0;
    let unsafeFiles = 0;
    let oldestMtimeMs: number | undefined;
    for (const name of names) {
      let handle;
      try {
        handle = await open(
          join(this.promptRoot, name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const stat = await handle.stat();
        bytes += stat.size;
        oldestMtimeMs = Math.min(oldestMtimeMs ?? stat.mtimeMs, stat.mtimeMs);
        if (
          (!name.startsWith(".prompt-") && !name.startsWith(".token-")) ||
          !stat.isFile() ||
          stat.nlink !== 1 ||
          (stat.mode & 0o077) !== 0
        )
          unsafeFiles += 1;
      } catch {
        unsafeFiles += 1;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    return {
      files: names.length,
      bytes,
      unsafeFiles,
      ...(oldestMtimeMs === undefined ? {} : { oldestMtimeMs }),
      maxFiles: RETENTION_MAX_FILES,
      maxBytes: RETENTION_MAX_BYTES,
      maxAgeMs: RETENTION_MAX_AGE_MS,
    };
  }
  private async requireRegistrationRetentionBudget(
    prompt: string,
  ): Promise<void> {
    const status = await this.registrationRetentionStatus();
    if (status.unsafeFiles > 0)
      throw new Error("HERDR_REGISTRATION_RETENTION_UNSAFE");
    if (
      status.oldestMtimeMs !== undefined &&
      Date.now() - status.oldestMtimeMs > status.maxAgeMs
    )
      throw new Error("HERDR_REGISTRATION_RETENTION_EXPIRED");
    const projectedBytes = status.bytes + Buffer.byteLength(prompt) + 1024;
    if (status.files + 2 > status.maxFiles || projectedBytes > status.maxBytes)
      throw new Error("HERDR_REGISTRATION_RETENTION_BUDGET_EXCEEDED");
  }
  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    return await withRetentionAdmission(resolve(this.promptRoot), () =>
      this.provisionWithRetentionAdmission(input),
    );
  }
  private async provisionWithRetentionAdmission(
    input: ProvisionInput,
  ): Promise<ProvisionResult> {
    await this.requireRegistrationRetentionBudget(input.prompt);
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
    let promptFileIdentity: FileIdentity | undefined;
    let tokenFileIdentity: FileIdentity | undefined;
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
      tokenFileIdentity = await managedFileIdentity(tokenFile);
      promptFileIdentity = prompt
        ? await managedFileIdentity(prompt)
        : undefined;
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
        if (prompt)
          await retainManagedFileForCleanup(prompt, promptFileIdentity);
        if (tokenFile)
          await retainManagedFileForCleanup(tokenFile, tokenFileIdentity);
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
        ...(promptFileIdentity ? { promptFileIdentity } : {}),
        ...(tokenFileIdentity ? { tokenFileIdentity } : {}),
        paneId: typeof sr.pane_id === "string" ? sr.pane_id : paneId,
        ...(worktreeId ? { worktreeId } : {}),
        ...(worktreePath ? { worktreePath } : {}),
        ...(unusedTabId ? { unusedTabId } : {}),
      };
    } catch (error) {
      if (prompt)
        await retainManagedFileForCleanup(prompt, promptFileIdentity).catch(
          () => undefined,
        );
      if (tokenFile)
        await retainManagedFileForCleanup(tokenFile, tokenFileIdentity).catch(
          () => undefined,
        );
      // Herdr has no compare-and-remove operation. Retain every worktree;
      // removing a path after an await could delete a replacement worktree.
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
    // Herdr has no compare-and-remove operation. Retain the worktree during
    // compensation rather than risking removal of a replacement path.
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
  async recoverRegistration(
    agentId: string,
    resource: {
      paneId?: string;
      tabId?: string;
      worktreeId?: string;
      worktreePath?: string;
      tokenDigest?: string;
      generation?: number;
      promptFileDev?: number;
      promptFileIno?: number;
      tokenFileDev?: number;
      tokenFileIno?: number;
    },
  ): Promise<ProvisionResult | undefined> {
    if (
      !resource.tokenDigest ||
      resource.tokenFileDev === undefined ||
      resource.tokenFileIno === undefined ||
      resource.promptFileDev === undefined ||
      resource.promptFileIno === undefined
    )
      return undefined;
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
    if (!tokenName || !promptName) return undefined;
    const tokenPath = join(this.promptRoot, tokenName);
    const promptPath = join(this.promptRoot, promptName);
    try {
      const tokenIdentity = await managedFileIdentity(tokenPath);
      const promptIdentity = await managedFileIdentity(promptPath);
      if (
        tokenIdentity.dev !== resource.tokenFileDev ||
        tokenIdentity.ino !== resource.tokenFileIno ||
        promptIdentity.dev !== resource.promptFileDev ||
        promptIdentity.ino !== resource.promptFileIno
      )
        return undefined;
    } catch {
      return undefined;
    }
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
      tokenFilePath: tokenPath,
      promptPath,
      ...(resource.promptFileDev !== undefined &&
      resource.promptFileIno !== undefined
        ? {
            promptFileIdentity: {
              dev: resource.promptFileDev,
              ino: resource.promptFileIno,
            },
          }
        : {}),
      ...(resource.tokenFileDev !== undefined &&
      resource.tokenFileIno !== undefined
        ? {
            tokenFileIdentity: {
              dev: resource.tokenFileDev,
              ino: resource.tokenFileIno,
            },
          }
        : {}),
    };
  }
  async cleanupRegistration(
    result: ProvisionResult,
  ): Promise<"retained_registration_files" | "registration_files_missing"> {
    const outcomes = [];
    if (result.promptPath)
      outcomes.push(
        await retainManagedFileForCleanup(
          result.promptPath,
          result.promptFileIdentity,
        ),
      );
    if (result.tokenFilePath)
      outcomes.push(
        await retainManagedFileForCleanup(
          result.tokenFilePath,
          result.tokenFileIdentity,
        ),
      );
    return outcomes.includes("retained")
      ? "retained_registration_files"
      : "registration_files_missing";
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
    cleanup = true,
  ): Promise<void> {
    if (
      !result.tokenFilePath ||
      (suppliedDigest !== undefined &&
        suppliedDigest !== result.token.digest) ||
      !(await verifyManagedTokenFile(
        result.tokenFilePath,
        result.token.digest,
        result.tokenFileIdentity,
      ))
    )
      throw new Error("HERDR_REGISTRATION_TOKEN_INVALID");
    if (
      identity.paneId !== result.paneId ||
      (identity.generation !== undefined &&
        identity.generation !== result.token.generation)
    )
      throw new Error("HERDR_REGISTRATION_IDENTITY_MISMATCH");
    if (cleanup) {
      if (result.promptPath)
        await retainManagedFileForCleanup(
          result.promptPath,
          result.promptFileIdentity,
        );
      await retainManagedFileForCleanup(
        result.tokenFilePath,
        result.tokenFileIdentity,
      );
    }
  }
}
