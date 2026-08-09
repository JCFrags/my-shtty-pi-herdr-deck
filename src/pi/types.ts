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
  scopedModels?: readonly (PiModelLike | { model: PiModelLike; thinkingLevel?: string })[];
  thinkingLevel?: string;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  abort(): void;
  compact(options?: { onComplete?: () => void; onError?: (error: Error) => void }): void;
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  getScopedModels?(): PiModelLike[] | { models: PiModelLike[] };
  [key: string]: unknown;
}

export interface PiApiLike {
  on(event: string, handler: (event: unknown, context: PiContextLike) => void | Promise<void>): void;
  registerCommand(name: string, command: { description: string; handler: (args: string, context: PiContextLike) => void | Promise<void> }): void;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void | Promise<void>;
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

export function modelChoiceFromPi(model: PiModelLike): ModelChoice {
  const choice: ModelChoice = {
    provider: model.provider,
    id: model.id,
    name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
  };
  if (Number.isSafeInteger(model.contextWindow) && (model.contextWindow as number) > 0) choice.contextWindow = model.contextWindow as number;
  return choice;
}
