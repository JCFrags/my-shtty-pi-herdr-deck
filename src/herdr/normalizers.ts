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
    value = id(r, "id", "workspace_id", "workspaceId");
  return value ? ({ ...r, id: value, tabs: [] } as HerdrWorkspace) : undefined;
}
export function normalizeTab(raw: unknown): HerdrTab | undefined {
  const r = record(raw),
    value = id(r, "id", "tab_id", "tabId");
  return value ? ({ ...r, id: value, panes: [] } as HerdrTab) : undefined;
}
export function normalizePane(raw: unknown): HerdrPane | undefined {
  const r = record(raw),
    value = id(r, "id", "pane_id", "paneId");
  return value
    ? ({
        ...r,
        id: value,
        ...(id(r, "terminal_id", "terminalId")
          ? { terminalId: id(r, "terminal_id", "terminalId") }
          : {}),
        ...(id(r, "tab_id", "tabId")
          ? { tabId: id(r, "tab_id", "tabId") }
          : {}),
      } as HerdrPane)
    : undefined;
}
export function normalizeAgent(raw: unknown): HerdrAgent | undefined {
  const r = record(raw),
    paneId = id(r, "pane_id", "paneId");
  return paneId ? ({ ...r, paneId } as HerdrAgent) : undefined;
}
export function normalizeWorktree(raw: unknown): HerdrWorktree | undefined {
  const r = record(raw),
    path = str(r.path ?? r.cwd ?? r.worktree_path);
  return path ? ({ ...r, path } as HerdrWorktree) : undefined;
}
export function normalizeSnapshot(raw: unknown): HerdrSnapshot {
  const r = record(raw),
    root = record(r.result ?? r),
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
  } as HerdrSnapshot;
}
export function normalizeEvent(raw: unknown): HerdrEvent | undefined {
  const r = record(raw),
    type = str(r.type ?? r.event ?? r.name);
  return type
    ? ({ ...r, type, data: record(r.data ?? r.payload) } as HerdrEvent)
    : undefined;
}
