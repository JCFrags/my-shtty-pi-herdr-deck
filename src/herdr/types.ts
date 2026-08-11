export interface HerdrWorkspaceWorktree {
  repoKey: string;
  repoName: string;
  repoRoot: string;
  checkoutPath: string;
  isLinkedWorktree: boolean;
}
export interface HerdrWorkspace {
  id: string;
  label?: string;
  cwd?: string;
  worktree?: HerdrWorkspaceWorktree;
  worktreeInvalid?: boolean;
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
  sessionReference?: HerdrSessionReference;
  generation?: number;
  [key: string]: unknown;
}
export interface HerdrSessionReference {
  source: string;
  agent: string;
  kind: string;
  value: string;
}
export interface HerdrAgent {
  id?: string;
  name?: string;
  kind?: string;
  paneId: string;
  terminalId?: string;
  workspaceId?: string;
  tabId?: string;
  sessionId?: string;
  sessionReference?: HerdrSessionReference;
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
