import type { ModelChoice } from "../bridge/protocol.js";

export interface PiModelLike {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
  [key: string]: unknown;
}
export interface PiToolLike {
  name: string;
  [key: string]: unknown;
}
export interface PiSessionManagerLike {
  getSessionId?(): string;
  getSessionFile?(): string | undefined;
  getCwd?(): string;
  getEntries?(): unknown[];
  [key: string]: unknown;
}
export interface PiModelRegistryLike {
  getAvailable?(): PiModelLike[];
  getAll?(): PiModelLike[];
  find?(provider: string, modelId: string): PiModelLike | undefined;
  [key: string]: unknown;
}
export interface PiUiLike {
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string | undefined): void;
  [key: string]: unknown;
}
export interface PiContextLike {
  ui: PiUiLike;
  cwd: string;
  sessionManager: PiSessionManagerLike;
  modelRegistry: PiModelRegistryLike;
  model?: PiModelLike;
  scopedModels?: readonly (
    PiModelLike | { model: PiModelLike; thinkingLevel?: string }
  )[];
  thinkingLevel?: string;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  abort(): void;
  compact(options?: {
    onComplete?: () => void;
    onError?: (error: Error) => void;
  }): void;
  getContextUsage?():
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
  getScopedModels?(): PiModelLike[] | { models: PiModelLike[] };
  [key: string]: unknown;
}
export interface PiToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (...args: never[]) => Promise<unknown>;
}
export interface PiApiLike {
  on(
    event: string,
    handler: (event: unknown, context: PiContextLike) => void | Promise<void>,
  ): void;
  appendEntry?(customType: string, data?: unknown): void;
  events?: {
    on(event: string, listener: (data: unknown) => void): unknown;
    off?(event: string, listener: (data: unknown) => void): void;
    emit(event: string, data: unknown): void;
  };
  registerCommand(
    name: string,
    command: {
      description: string;
      handler: (args: string, context: PiContextLike) => void | Promise<void>;
    },
  ): void;
  registerTool?(definition: PiToolDefinitionLike): void;
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ): void | Promise<void>;
  sendMessage?(
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: Record<string, unknown>;
    },
    options?: {
      deliverAs?: "steer" | "followUp" | "nextTurn";
      triggerTurn?: boolean;
    },
  ): void;
  getActiveTools?(): string[];
  getAllTools?(): PiToolLike[];
  setActiveTools?(tools: string[]): void;
  getThinkingLevel?(): string;
  setThinkingLevel?(level: string): void;
  getAllowedThinkingLevels?(): string[];
  getAvailableThinkingLevels?(): string[];
  getScopedModels?(): PiModelLike[] | { models: PiModelLike[] };
  setModel?(model: PiModelLike): boolean | void | Promise<boolean | void>;
  [key: string]: unknown;
}

export interface PiSafeState {
  agentId: string;
  generation: number;
  connectionGeneration?: number;
  sessionId: string;
  idle: boolean;
  pendingMessages: number;
  activity: "idle" | "working";
  turnIndex?: number;
  model?: ModelChoice;
  thinkingLevel?: string;
  contextPercent?: number | null;
  currentTool?: string;
  activeTools: string[];
  capabilities: PiAdapterCapabilities;
}
export interface PiAdapterCapabilities {
  core: boolean;
  prompt: boolean;
  steer: boolean;
  followUp: boolean;
  abort: boolean;
  compact: boolean;
  model: boolean;
  thinking: boolean;
  tools: boolean;
  toolExpansion: boolean;
}
export interface PiAssignment {
  id: string;
  taskId: string;
  runId: string;
  agentId: string;
  generation: number;
  assignmentGeneration: number;
  piSessionId: string;
  objective: string;
  constraints: string[];
  deadline: string;
}
export type PiLifecycleEventType =
  | "before_agent_start"
  | "agent_start"
  | "turn_start"
  | "turn_end"
  | "agent_end"
  | "agent_settled"
  | "session_compact"
  | "tool_execution_start"
  | "tool_execution_end";
export interface PiLifecycleEvent {
  type: PiLifecycleEventType;
  agentId: string;
  generation: number;
  connectionGeneration?: number;
  piSessionId: string;
  assignmentGeneration?: number;
  turnIndex?: number;
  agentCycleId?: string;
  toolName?: string;
}
export interface PiControl {
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void>;
  compact(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinking(level: string): Promise<void>;
  setTools(names: string[]): Promise<void>;
  expandTool(name: string, expanded: boolean): Promise<void>;
}
export function modelChoiceFromPi(model: PiModelLike): ModelChoice {
  const choice: ModelChoice = {
    provider: model.provider,
    id: model.id,
    name:
      typeof model.name === "string" && model.name.length > 0
        ? model.name
        : model.id,
  };
  if (
    Number.isSafeInteger(model.contextWindow) &&
    (model.contextWindow as number) > 0
  )
    choice.contextWindow = model.contextWindow as number;
  return choice;
}
