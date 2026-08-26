import type { HerdrCli } from "./cli.js";
import { branchSlug, herdrName, label } from "./names.js";
import type { GitEvidence } from "../git/porcelain.js";
import { mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentPlacement, ModelSelection } from "../broker/model-policy.js";
import {
  InstalledPiCapabilities,
  type PiModelValidator,
} from "../pi/model-capabilities.js";
import {
  createManagedToken,
  createManagedTokenFile,
  createPromptFile,
  archiveManagedFileForCleanup,
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
  placement?: AgentPlacement;
  model?: ModelSelection;
  prompt: string;
  projectBase?: string;
  branch?: string;
  reuseWorktreeId?: string;
  reuseWorktreePath?: string;
  env?: Record<string, string>;
}
export interface ProvisionResult {
  name: string;
  token: ManagedToken;
  tabId?: string;
  paneId?: string;
  workspaceId?: string;
  worktreeId?: string;
  worktreePath?: string;
  unusedTabId?: string;
  createdWorkspace?: boolean;
  model?: ModelSelection;
  placement?: AgentPlacement;
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
/** Low-level rollback compatibility only. Broker creation always supplies the resolved scoped model. */
const ROLLBACK_COMPATIBILITY_MODEL: ModelSelection = Object.freeze({
  provider: "openai-codex",
  modelId: "gpt-5.6-luna",
  thinkingLevel: "medium",
});
const RETENTION_MAX_FILES = 128;
const RETENTION_MAX_BYTES = 32 * 1024 * 1024;

function nestedString(
  value: Record<string, unknown>,
  objectKey: string,
  field: string,
): string | undefined {
  const nested = value[objectKey];
  if (!nested || typeof nested !== "object" || Array.isArray(nested))
    return undefined;
  const result = (nested as Record<string, unknown>)[field];
  return typeof result === "string" ? result : undefined;
}
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
function assertManagedEnvironmentNotOverridden(
  input: ProvisionInput,
  managed: Record<string, string> = {},
): void {
  const forbidden = Object.keys(input.env ?? {}).filter(
    (key) =>
      Object.hasOwn(managed, key) ||
      [
        "PI_HERDR_ORCH_BROKER_SOCKET",
        "PI_HERDR_ORCH_SESSION_KEY",
        "PI_HERDR_ORCH_AGENT_TOKEN",
        "PI_HERDR_ORCH_TOKEN_FILE",
        "HERDR_BIN_PATH",
      ].includes(key),
  );
  if (forbidden.length)
    throw new Error(
      `Managed environment override rejected: ${forbidden.join(", ")}`,
    );
}
function assertReuseWorktreeIdentity(input: ProvisionInput): void {
  const hasReuseId = input.reuseWorktreeId !== undefined;
  const hasReusePath = input.reuseWorktreePath !== undefined;
  const valid = (value: unknown, max: number): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value);
  if (
    hasReuseId !== hasReusePath ||
    (hasReuseId &&
      (!valid(input.reuseWorktreeId, 256) ||
        !valid(input.reuseWorktreePath, 4096)))
  )
    throw new Error("HERDR_REUSE_WORKTREE_IDENTITY_INVALID");
}

export class HerdrProvisioner {
  constructor(
    readonly cli: HerdrCli,
    readonly promptRoot: string,
    readonly liveNames: () => Iterable<string> = () => [],
    readonly retainRegistrationFiles = false,
    readonly gitEvidence?: (cwd: string, base?: string) => Promise<GitEvidence>,
    readonly orchestration?: {
      socketPath: string;
      sessionKey: string;
      herdrBinary?: string;
    },
    readonly piCapabilities: PiModelValidator = new InstalledPiCapabilities(),
  ) {
    if (
      orchestration &&
      (!orchestration.socketPath.startsWith("/") ||
        /[\u0000-\u001f\u007f]/u.test(orchestration.socketPath) ||
        !/^[0-9a-f]{24}$/u.test(orchestration.sessionKey) ||
        (orchestration.herdrBinary !== undefined &&
          (!orchestration.herdrBinary.startsWith("/") ||
            /[\u0000-\u001f\u007f]/u.test(orchestration.herdrBinary))))
    )
      throw new Error("HERDR_ORCHESTRATION_IDENTITY_INVALID");
  }
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
    assertReuseWorktreeIdentity(input);
    assertManagedEnvironmentNotOverridden(input);
    const selectedModel = input.model ?? ROLLBACK_COMPATIBILITY_MODEL;
    await this.piCapabilities.validate(selectedModel);
    await mkdir(this.promptRoot, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(resolve(this.promptRoot));
    const rootStat = await stat(canonicalRoot);
    if (
      !rootStat.isDirectory() ||
      (rootStat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && rootStat.uid !== process.getuid())
    )
      throw new Error("HERDR_REGISTRATION_ROOT_UNSAFE");
    return await withRetentionAdmission(canonicalRoot, () =>
      this.provisionWithRetentionAdmission({ ...input, model: selectedModel }),
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
      ...(this.orchestration
        ? {
            PI_HERDR_ORCH_BROKER_SOCKET: this.orchestration.socketPath,
            PI_HERDR_ORCH_SESSION_KEY: this.orchestration.sessionKey,
            ...(this.orchestration.herdrBinary
              ? { HERDR_BIN_PATH: this.orchestration.herdrBinary }
              : {}),
          }
        : {}),
    };
    assertManagedEnvironmentNotOverridden(input, managed);
    let prompt: string | undefined;
    let tabId: string | undefined;
    let paneId: string | undefined;
    let workspaceId: string | undefined;
    let worktreePath: string | undefined;
    let worktreeId: string | undefined;
    let unusedTabId: string | undefined;
    let createdWorkspace = false;
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
      const env = { ...managed, ...(input.env ?? {}) };
      promptFileIdentity = prompt
        ? await managedFileIdentity(prompt)
        : undefined;
      if (
        input.placement === "new-workspace" &&
        input.isolation === "shared-readonly"
      ) {
        if (input.reuseWorktreeId || input.reuseWorktreePath)
          throw new Error("HERDR_NEW_WORKSPACE_REUSE_FORBIDDEN");
        const created = await this.cli.createWorkspace({
          cwd: input.cwd,
          label: label(input.role),
          env,
        });
        const r = created as Record<string, unknown>;
        workspaceId =
          typeof r.workspace_id === "string"
            ? r.workspace_id
            : nestedString(r, "workspace", "workspace_id");
        tabId =
          typeof r.tab_id === "string"
            ? r.tab_id
            : nestedString(r, "tab", "tab_id");
        paneId =
          typeof r.root_pane_id === "string"
            ? r.root_pane_id
            : nestedString(r, "root_pane", "pane_id");
        if (!workspaceId)
          throw new Error("HERDR_COMMAND_FAILED: workspace identity missing.");
        createdWorkspace = true;
      } else if (input.reuseWorktreeId || input.reuseWorktreePath) {
        workspaceId = input.workspaceId;
        worktreeId = input.reuseWorktreeId!;
        worktreePath = input.reuseWorktreePath!;
        const current = await this.cli.snapshot();
        const liveMatches = current.worktrees.filter(
          (worktree) => worktree.id === worktreeId,
        );
        const live = liveMatches.length === 1 ? liveMatches[0] : undefined;
        if (
          !live ||
          live.path !== worktreePath ||
          live.workspaceId !== input.workspaceId
        )
          throw new Error("HERDR_REUSE_WORKTREE_IDENTITY_STALE");
        const created = await this.cli.createTab({
          workspaceId: input.workspaceId,
          cwd: worktreePath,
          label: label(input.role),
          env,
        });
        const r = created as Record<string, unknown>;
        tabId =
          typeof r.tab_id === "string"
            ? r.tab_id
            : (nestedString(r, "tab", "tab_id") ??
              (typeof r.id === "string" ? r.id : undefined));
        paneId =
          typeof r.root_pane_id === "string"
            ? r.root_pane_id
            : nestedString(r, "root_pane", "pane_id");
      } else if (input.isolation === "worktree") {
        const wt = await this.cli.createWorktree({
          workspaceId: input.workspaceId,
          branch: branchSlug(input.branch ?? input.agentId),
          base: input.projectBase ?? "HEAD",
          label: label(input.role),
        });
        const r = wt as Record<string, unknown>;
        worktreePath =
          typeof r.path === "string"
            ? r.path
            : nestedString(r, "worktree", "path");
        worktreeId = typeof r.id === "string" ? r.id : undefined;
        workspaceId =
          typeof r.workspace_id === "string"
            ? r.workspace_id
            : (nestedString(r, "workspace", "workspace_id") ??
              input.workspaceId);
        const created = await this.cli.createTab({
          workspaceId,
          cwd: worktreePath ?? input.cwd,
          label: label(input.role),
          env,
        });
        const cr = created as Record<string, unknown>;
        tabId =
          typeof cr.tab_id === "string"
            ? cr.tab_id
            : (nestedString(cr, "tab", "tab_id") ??
              (typeof cr.id === "string" ? cr.id : undefined));
        paneId =
          typeof cr.root_pane_id === "string"
            ? cr.root_pane_id
            : typeof (cr.root_pane as Record<string, unknown> | undefined)
                  ?.pane_id === "string"
              ? ((cr.root_pane as Record<string, unknown>).pane_id as string)
              : undefined;
        unusedTabId =
          typeof r.tab_id === "string"
            ? r.tab_id
            : nestedString(r, "tab", "tab_id");
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
            : (nestedString(r, "tab", "tab_id") ??
              (typeof r.id === "string" ? r.id : undefined));
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
      if (!input.model) throw new Error("PI_MODEL_SELECTION_REQUIRED");
      const started = await this.cli.startPi({
        name,
        paneId,
        args: [
          "--name",
          name,
          "--provider",
          input.model.provider,
          "--model",
          `${input.model.provider}/${input.model.modelId}`,
          "--thinking",
          input.model.thinkingLevel,
          "--append-system-prompt",
          prompt,
        ],
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
        ...(workspaceId ? { workspaceId } : {}),
        ...(worktreeId ? { worktreeId } : {}),
        ...(worktreePath ? { worktreePath } : {}),
        ...(unusedTabId ? { unusedTabId } : {}),
        ...(createdWorkspace ? { createdWorkspace: true } : {}),
        model: input.model,
        placement: input.placement ?? "current-workspace",
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
      if (createdWorkspace && workspaceId)
        await this.cli.closeWorkspace(workspaceId).catch(() => undefined);
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
    if (result.createdWorkspace && result.workspaceId)
      await this.cli.closeWorkspace(result.workspaceId).catch(() => undefined);
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
  async archiveRegistration(
    result: ProvisionResult,
  ): Promise<"retained_registration_files" | "registration_files_missing"> {
    const outcomes = [];
    if (result.promptPath)
      outcomes.push(
        await archiveManagedFileForCleanup(
          result.promptPath,
          result.promptFileIdentity,
        ),
      );
    if (result.tokenFilePath)
      outcomes.push(
        await archiveManagedFileForCleanup(
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
        await archiveManagedFileForCleanup(
          result.promptPath,
          result.promptFileIdentity,
        );
      await archiveManagedFileForCleanup(
        result.tokenFilePath,
        result.tokenFileIdentity,
      );
    }
  }
}
