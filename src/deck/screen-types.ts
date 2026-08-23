import type { AgentViewFilter } from "./views.js";
import type {
  ActivityFilter,
  AgentBoardTab,
  BoardFilter,
} from "./product-presentation.js";

export type { AgentBoardTab } from "./product-presentation.js";
import type { HitBox } from "./components/controls.js";
import type { OverlayState } from "./overlay-screen.js";

export type FilesPane = "tree" | "preview";
export type FilesFocusTarget = "tree" | "preview" | "actions";

export interface BoardScreenState {
  filter: BoardFilter;
  selectedId?: string;
  listScroll: number;
  detailScroll: number;
  wheelDetached: boolean;
}

export interface FilesScreenState {
  focusedPath?: string;
  focusedAction?: string;
  activePane: FilesPane;
  treeScroll: number;
  previewScroll: number;
  focusTarget: FilesFocusTarget;
  wheelDetached: boolean;
}

export interface AgentsScreenState {
  filter: AgentViewFilter;
  requestedPage: number;
  selectedId?: string;
}

export interface ActivityScreenState {
  filter: ActivityFilter;
  selectedId?: string;
  listScroll: number;
  detailScroll: number;
  wheelDetached: boolean;
}

export interface AgentBoardLocalState {
  tab: AgentBoardTab;
  board: BoardScreenState;
  files: FilesScreenState;
  agents: AgentsScreenState;
  activity: ActivityScreenState;
  overlay: OverlayState;
}

export interface SurfaceRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderedSurface<S = unknown> {
  lines: string[];
  hitBoxes: HitBox[];
  regions: SurfaceRegion[];
  correctedState?: S;
  effectiveSelectedId?: string;
}

export interface ShellHeaderPresentation {
  productName: "AGENT BOARD";
  scopeLabel: string;
  attentionCount: number;
  online: boolean;
  selectedTab: AgentBoardTab;
}
