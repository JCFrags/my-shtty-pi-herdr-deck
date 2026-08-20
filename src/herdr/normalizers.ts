import type {
  HerdrAgent,
  HerdrEvent,
  HerdrPane,
  HerdrSnapshot,
  HerdrTab,
  HerdrWorkspace,
  HerdrWorktree,
} from "./types.js";
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 && !/[\u0000-\u001f\u007f]/u.test(v)
    ? v
    : undefined;
const id = (r: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) {
    const v = str(r[k]);
    if (v) return v;
  }
  return undefined;
};
export function normalizeWorkspace(raw: unknown): HerdrWorkspace | undefined {
  const r = record(raw),
    value = id(r, "id", "workspace_id", "workspaceId"),
    rawWorktree = r.worktree,
    worktreeRecord = record(rawWorktree),
    repoKey = str(worktreeRecord.repo_key ?? worktreeRecord.repoKey),
    repoName = str(worktreeRecord.repo_name ?? worktreeRecord.repoName),
    repoRoot = str(worktreeRecord.repo_root ?? worktreeRecord.repoRoot),
    checkoutPath = str(
      worktreeRecord.checkout_path ?? worktreeRecord.checkoutPath,
    ),
    linked =
      worktreeRecord.is_linked_worktree ?? worktreeRecord.isLinkedWorktree,
    hasWorktree = rawWorktree !== undefined && rawWorktree !== null,
    validWorktree =
      repoKey &&
      repoName &&
      repoRoot &&
      checkoutPath &&
      typeof linked === "boolean";
  const { worktree: _rawWorktree, ...workspaceFields } = r;
  return value
    ? ({
        ...workspaceFields,
        id: value,
        ...(validWorktree
          ? {
              cwd: checkoutPath,
              worktree: {
                repoKey,
                repoName,
                repoRoot,
                checkoutPath,
                isLinkedWorktree: linked,
              },
            }
          : {}),
        ...(hasWorktree && !validWorktree ? { worktreeInvalid: true } : {}),
        tabs: [],
      } as HerdrWorkspace)
    : undefined;
}
export function normalizeTab(raw: unknown): HerdrTab | undefined {
  const r = record(raw),
    value = id(r, "id", "tab_id", "tabId"),
    workspaceId = id(r, "workspace_id", "workspaceId");
  return value
    ? ({
        ...r,
        id: value,
        ...(workspaceId ? { workspaceId } : {}),
        panes: [],
      } as HerdrTab)
    : undefined;
}
export function normalizePane(raw: unknown): HerdrPane | undefined {
  const r = record(raw),
    value = id(r, "id", "pane_id", "paneId"),
    terminalId = id(r, "terminal_id", "terminalId"),
    workspaceId = id(r, "workspace_id", "workspaceId"),
    tabId = id(r, "tab_id", "tabId");
  return value
    ? ({
        ...r,
        id: value,
        ...(terminalId ? { terminalId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(tabId ? { tabId } : {}),
      } as HerdrPane)
    : undefined;
}
export function normalizeAgent(raw: unknown): HerdrAgent | undefined {
  const r = record(raw),
    paneId = id(r, "pane_id", "paneId"),
    terminalId = id(r, "terminal_id", "terminalId"),
    workspaceId = id(r, "workspace_id", "workspaceId"),
    tabId = id(r, "tab_id", "tabId"),
    agentId = id(r, "agent_id", "agentId"),
    kind = str(r.kind ?? r.agent),
    sessionId = id(r, "session_id", "sessionId"),
    rawSession = record(r.agent_session ?? r.sessionReference),
    sessionSource = str(rawSession.source),
    sessionAgent = str(rawSession.agent),
    sessionKind = str(rawSession.kind),
    sessionValue = str(rawSession.value);
  return paneId
    ? ({
        ...r,
        paneId,
        ...(terminalId ? { terminalId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(tabId ? { tabId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(kind ? { kind } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(sessionSource && sessionAgent && sessionKind && sessionValue
          ? {
              sessionReference: {
                source: sessionSource,
                agent: sessionAgent,
                kind: sessionKind,
                value: sessionValue,
              },
            }
          : {}),
      } as HerdrAgent)
    : undefined;
}
export function normalizeWorktree(raw: unknown): HerdrWorktree | undefined {
  const r = record(raw),
    path = str(r.path ?? r.cwd ?? r.worktree_path),
    worktreeId = id(r, "id", "worktree_id", "worktreeId"),
    workspaceId = id(r, "workspace_id", "workspaceId");
  return path
    ? ({
        ...r,
        path,
        ...(worktreeId ? { id: worktreeId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      } as HerdrWorktree)
    : undefined;
}
export function normalizeSnapshot(raw: unknown): HerdrSnapshot {
  const r = record(raw),
    result = record(r.result ?? r),
    root = record(result.snapshot ?? result),
    list = (key: string) => (Array.isArray(root[key]) ? root[key] : []);
  return {
    ...root,
    workspaces: list("workspaces").flatMap((v) => {
      const x = normalizeWorkspace(v);
      return x ? [x] : [];
    }),
    tabs: list("tabs").flatMap((v) => {
      const x = normalizeTab(v);
      return x ? [x] : [];
    }),
    panes: list("panes").flatMap((v) => {
      const x = normalizePane(v);
      return x ? [x] : [];
    }),
    agents: list("agents").flatMap((v) => {
      const x = normalizeAgent(v);
      return x ? [x] : [];
    }),
    worktrees: list("worktrees").flatMap((v) => {
      const x = normalizeWorktree(v);
      return x ? [x] : [];
    }),
    worktreeInventoryPresent: Array.isArray(root.worktrees),
  } as HerdrSnapshot;
}
export function normalizeEvent(raw: unknown): HerdrEvent | undefined {
  const r = record(raw),
    type = str(r.type ?? r.event ?? r.name);
  return type
    ? ({ ...r, type, data: record(r.data ?? r.payload) } as HerdrEvent)
    : undefined;
}
