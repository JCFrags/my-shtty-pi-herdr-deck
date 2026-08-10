export interface HerdrWorkspace {
  id: string;
  label?: string;
  cwd?: string;
  tabs: HerdrTab[];
  [key: string]: unknown;
}
export interface HerdrTab {
  id: string;
  workspaceId?: string;
  label?: string;
  cwd?: string;
  panes: HerdrPane[];
  [key: string]: unknown;
}
export interface HerdrPane {
  id: string;
  terminalId?: string;
  workspaceId?: string;
  tabId?: string;
  cwd?: string;
  occupant?: HerdrOccupant;
  [key: string]: unknown;
}
export interface HerdrOccupant {
  kind?: string;
  name?: string;
  agentId?: string;
  terminalId?: string;
  status?: string;
  sessionId?: string;
  generation?: number;
  [key: string]: unknown;
}
export interface HerdrAgent {
  id?: string;
  name?: string;
  kind?: string;
  paneId: string;
  terminalId?: string;
  sessionId?: string;
  status?: string;
  [key: string]: unknown;
}
export interface HerdrWorktree {
  id?: string;
  workspaceId?: string;
  path: string;
  branch?: string;
  base?: string;
  tabId?: string;
  rootPaneId?: string;
  [key: string]: unknown;
}
export interface HerdrSnapshot {
  sequence?: number;
  workspaces: HerdrWorkspace[];
  tabs: HerdrTab[];
  panes: HerdrPane[];
  agents: HerdrAgent[];
  worktrees: HerdrWorktree[];
  [key: string]: unknown;
}
export interface HerdrEvent {
  type: string;
  sequence?: number;
  data: Record<string, unknown>;
  [key: string]: unknown;
}
