import type { HerdrCli } from "./cli.js";
import { branchSlug, herdrName, label } from "./names.js";
import {
  createManagedToken,
  createPromptFile,
  deletePromptFile,
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
  worktreePath?: string;
  unusedTabId?: string;
}
export class HerdrProvisioner {
  constructor(
    readonly cli: HerdrCli,
    readonly promptRoot: string,
    readonly liveNames: () => Iterable<string> = () => [],
  ) {}
  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const token = createManagedToken();
    const name = herdrName(input.role, input.agentId, this.liveNames());
    const env = {
      PI_HERDR_ORCH_MANAGED: "1",
      PI_HERDR_ORCH_AGENT_ID: input.agentId,
      PI_HERDR_ORCH_PARENT_AGENT_ID: input.parentAgentId,
      PI_HERDR_ORCH_PROFILE_ID: input.profileId,
      PI_HERDR_ORCH_AGENT_TOKEN: token.token,
      ...(input.env ?? {}),
    };
    let prompt: string | undefined;
    let tabId: string | undefined;
    let paneId: string | undefined;
    let worktreePath: string | undefined;
    let unusedTabId: string | undefined;
    try {
      prompt = await createPromptFile(
        this.promptRoot,
        input.agentId,
        input.prompt,
      );
      if (input.isolation === "worktree") {
        const wt = await this.cli.createWorktree({
          workspaceId: input.workspaceId,
          branch: branchSlug(input.branch ?? input.agentId),
          base: input.projectBase ?? "HEAD",
          label: label(input.role),
        });
        const r = wt as Record<string, unknown>;
        worktreePath = typeof r.path === "string" ? r.path : undefined;
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
      await deletePromptFile(prompt);
      prompt = undefined;
      return {
        name,
        token,
        tabId,
        ...(typeof sr.pane_id === "string" ? { paneId: sr.pane_id } : {}),
        ...(worktreePath ? { worktreePath } : {}),
        ...(unusedTabId ? { unusedTabId } : {}),
      };
    } catch (error) {
      if (prompt) await deletePromptFile(prompt).catch(() => undefined);
      throw error;
    }
  }
}
