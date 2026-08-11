import type { ToolExpansionAdapter } from "./capabilities.js";
import {
  type CommandFrame,
  type CommandName,
  type DeckState,
  type ModelChoice,
  type ToolExpansionState,
  type ToolStatus,
  validateDeckState,
} from "./protocol.js";
import type { PiApiLike, PiContextLike, PiModelLike } from "../pi/types.js";
import { modelChoiceFromPi } from "../pi/types.js";

export class CommandExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CommandExecutionError";
    this.code = code;
  }
}

interface TrackedTool {
  id: string;
  name: string;
  status: ToolStatus;
  turnIndex: number;
}

export interface DeckController {
  readonly paneId: string;
  snapshot(): DeckState;
  execute(command: CommandFrame): Promise<unknown>;
  subscribe(listener: () => void): () => void;
}

function eventRecord(event: unknown): Record<string, unknown> {
  return typeof event === "object" && event !== null && !Array.isArray(event)
    ? (event as Record<string, unknown>)
    : {};
}

function stringField(
  record: Record<string, unknown>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function modelKey(choice: Pick<ModelChoice, "provider" | "id">): string {
  return `${choice.provider}\u0000${choice.id}`;
}

const STANDARD_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function deriveThinkingLevels(
  model: PiModelLike | undefined,
): string[] | undefined {
  if (!model) return undefined;
  if (!model.reasoning) return ["off"];
  return STANDARD_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export class PiDeckController implements DeckController {
  readonly paneId: string;
  readonly #pi: PiApiLike;
  readonly #expansion: ToolExpansionAdapter;
  #context: PiContextLike;
  #listeners = new Set<() => void>();
  #unsubscribeExpansion: (() => void) | undefined;
  #turnIndex = 0;
  #lastError: string | undefined;
  #trackedTools = new Map<string, TrackedTool>();

  constructor(
    pi: PiApiLike,
    context: PiContextLike,
    paneId: string,
    expansion: ToolExpansionAdapter,
  ) {
    this.#pi = pi;
    this.#context = context;
    this.paneId = paneId;
    this.#expansion = expansion;
    this.#unsubscribeExpansion = expansion.subscribe(() => this.#notify());
  }

  updateContext(context: PiContextLike): void {
    this.#context = context;
    this.#notify();
  }

  dispose(): void {
    this.#unsubscribeExpansion?.();
    this.#unsubscribeExpansion = undefined;
    this.#listeners.clear();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  recordEvent(name: string, event: unknown, context: PiContextLike): void {
    this.#context = context;
    const record = eventRecord(event);
    if (name === "session_start") {
      this.#turnIndex = 0;
      this.#trackedTools.clear();
      this.#lastError = undefined;
    } else if (name === "turn_start") {
      const eventTurnIndex = record.turnIndex;
      this.#turnIndex =
        Number.isSafeInteger(eventTurnIndex) && (eventTurnIndex as number) >= 0
          ? (eventTurnIndex as number)
          : this.#turnIndex + 1;
    } else if (name === "tool_execution_start" || name === "tool_call") {
      this.#trackTool(record, "running");
    } else if (name === "tool_execution_update") {
      this.#trackTool(record, "running");
    } else if (name === "tool_execution_end" || name === "tool_result") {
      this.#trackTool(
        record,
        record.error || record.isError === true ? "error" : "complete",
      );
    }
    const error = record.error;
    if (
      error instanceof Error ||
      (typeof error === "string" && error.length > 0) ||
      record.isError === true
    ) {
      const isToolEvent =
        name === "tool_call" ||
        name === "tool_result" ||
        name.startsWith("tool_execution_");
      const toolName = stringField(record, ["toolName", "name", "tool"]);
      // Event errors are intentionally not forwarded verbatim: provider and tool errors can
      // embed prompt text, command output, file excerpts, environment values, or credentials.
      this.#lastError = isToolEvent
        ? `${toolName ?? "Tool"} failed.`
        : "Pi reported an error.";
    }
    this.#notify();
  }

  snapshot(): DeckState {
    const context = this.#context;
    const sessionId = context.sessionManager.getSessionId?.();
    const modelChoices = this.#getModelChoices();
    const model = context.model;
    const usage = context.getContextUsage?.();
    const activeTools = dedupeStrings(this.#pi.getActiveTools?.() ?? []);
    const availableTools = dedupeStrings(
      (this.#pi.getAllTools?.() ?? []).map((tool) => tool.name),
    );
    const expansionStates = this.#getExpansionStates();
    const state: DeckState = {
      herdrPaneId: this.paneId,
      activity: context.isIdle() ? "idle" : "working",
      queuedMessage: context.hasPendingMessages(),
      modelChoices,
      thinkingLevel: this.#getThinkingLevel(),
      allowedThinkingLevels: this.#getAllowedThinkingLevels(),
      activeTools,
      availableTools,
      tools: expansionStates,
      turnIndex: this.#turnIndex,
    };
    if (sessionId) state.sessionId = sessionId;
    if (model) {
      state.model = {
        provider: model.provider,
        id: model.id,
        name:
          typeof model.name === "string" && model.name.length > 0
            ? model.name
            : model.id,
      };
    }
    if (usage) {
      state.context = {
        tokens: usage.tokens,
        window: usage.contextWindow,
        percent: usage.percent,
      };
    }
    if (this.#lastError) state.lastError = this.#lastError;
    return validateDeckState(state);
  }

  async execute(command: CommandFrame): Promise<unknown> {
    try {
      const value = await this.#execute(command.name, command.args as never);
      if (command.name !== "refreshState") this.#lastError = undefined;
      this.#notify();
      return value;
    } catch (error) {
      if (error instanceof CommandExecutionError) {
        this.#lastError = error.message;
        this.#notify();
        throw error;
      }
      // Do not expose arbitrary upstream error strings over the control socket. They may
      // contain prompt text, tool output, file excerpts, environment values, or credentials.
      const sanitized = new CommandExecutionError(
        "operation_failed",
        "Pi could not complete the requested operation.",
      );
      this.#lastError = sanitized.message;
      this.#notify();
      throw sanitized;
    }
  }

  async #execute(name: CommandName, args: never): Promise<unknown> {
    const idle = this.#context.isIdle();
    switch (name) {
      case "abort":
        if (idle)
          throw new CommandExecutionError(
            "invalid_state",
            "Abort is available only while Pi is working.",
          );
        this.#context.abort();
        return null;
      case "compact":
        if (!idle)
          throw new CommandExecutionError(
            "invalid_state",
            "Compact is available only while Pi is idle.",
          );
        this.#context.compact();
        return null;
      case "sendUserMessage": {
        const typed = args as {
          message: string;
          delivery: "normal" | "steer" | "followUp";
        };
        if (typed.delivery === "normal") {
          if (!idle)
            throw new CommandExecutionError(
              "invalid_state",
              "Normal delivery is available only while Pi is idle.",
            );
          await this.#pi.sendUserMessage(typed.message);
        } else {
          if (idle)
            throw new CommandExecutionError(
              "invalid_state",
              `${typed.delivery} delivery is available only while Pi is working.`,
            );
          await this.#pi.sendUserMessage(typed.message, {
            deliverAs: typed.delivery,
          });
        }
        return null;
      }
      case "setThinkingLevel": {
        const typed = args as { level: string };
        const allowed = this.#getAllowedThinkingLevels();
        if (!allowed.includes(typed.level)) {
          throw new CommandExecutionError(
            "unknown_thinking_level",
            `Thinking level ${JSON.stringify(typed.level)} is not available.`,
          );
        }
        if (typeof this.#pi.setThinkingLevel !== "function")
          throw new CommandExecutionError(
            "unsupported",
            "Pi does not expose setThinkingLevel.",
          );
        this.#pi.setThinkingLevel(typed.level);
        return null;
      }
      case "setModel": {
        const typed = args as { provider: string; modelId: string };
        const choices = this.#getModelChoices();
        const selected = choices.find(
          (choice) =>
            choice.provider === typed.provider && choice.id === typed.modelId,
        );
        if (!selected)
          throw new CommandExecutionError(
            "unknown_model",
            "The requested provider/model pair is outside the advertised scoped choices.",
          );
        const model = this.#findModel(selected);
        if (!model || typeof this.#pi.setModel !== "function")
          throw new CommandExecutionError(
            "unknown_model",
            "The requested model is no longer available.",
          );
        const changed = await this.#pi.setModel(model);
        if (changed === false)
          throw new CommandExecutionError(
            "model_unavailable",
            "Pi could not activate the requested model.",
          );
        return null;
      }
      case "setActiveTools": {
        const typed = args as { tools: string[] };
        const known = new Set(
          (this.#pi.getAllTools?.() ?? []).map((tool) => tool.name),
        );
        const unknown = typed.tools.filter((tool) => !known.has(tool));
        if (unknown.length > 0)
          throw new CommandExecutionError(
            "unknown_tool",
            `Unknown tools: ${unknown.join(", ")}.`,
          );
        if (typeof this.#pi.setActiveTools !== "function")
          throw new CommandExecutionError(
            "unsupported",
            "Pi does not expose setActiveTools.",
          );
        this.#pi.setActiveTools(typed.tools);
        return null;
      }
      case "setToolExpanded": {
        const typed = args as { toolCallId: string; expanded: boolean };
        const known = this.#getExpansionStates().some(
          (tool) => tool.id === typed.toolCallId,
        );
        if (!known)
          throw new CommandExecutionError(
            "unknown_tool_call",
            "The requested tool call is not in the advertised expansion state.",
          );
        await this.#expansion.setToolExpanded(typed.toolCallId, typed.expanded);
        return null;
      }
      case "setToolGroupExpanded": {
        const typed = args as {
          scope: "currentTurn" | "session";
          expanded: boolean;
        };
        await this.#expansion.setGroupExpanded(typed.scope, typed.expanded);
        return null;
      }
      case "refreshState":
        return this.snapshot();
    }
  }

  #getModelChoices(): ModelChoice[] {
    const apiScopedValue: unknown =
      this.#pi.getScopedModels?.() ?? this.#context.getScopedModels?.();
    const contextScopedValue = this.#context.scopedModels;
    const scopedValue: unknown = apiScopedValue ?? contextScopedValue;
    let scopedEntries: readonly unknown[] | undefined;
    if (Array.isArray(scopedValue)) scopedEntries = scopedValue;
    else if (scopedValue && typeof scopedValue === "object") {
      const models = (scopedValue as { models?: unknown }).models;
      if (Array.isArray(models)) scopedEntries = models;
    }
    let scoped: PiModelLike[] | undefined = scopedEntries?.flatMap(
      (entry: unknown) => {
        if (entry && typeof entry === "object" && "model" in entry) {
          const model = (entry as { model?: unknown }).model;
          return model && typeof model === "object"
            ? [model as PiModelLike]
            : [];
        }
        return [entry as PiModelLike];
      },
    );
    // Pi's ExtensionContext documents an empty scopedModels snapshot as "no scoping",
    // which means every available registry model is usable in this session.
    if (
      apiScopedValue === undefined &&
      contextScopedValue !== undefined &&
      contextScopedValue.length === 0
    ) {
      scoped =
        this.#context.modelRegistry.getAvailable?.() ??
        this.#context.modelRegistry.getAll?.() ??
        [];
    }
    // Never advertise the whole registry merely because a scope API is absent.
    // The current model is the only safe fallback because it is already active in this session.
    const models = scoped ?? (this.#context.model ? [this.#context.model] : []);
    const choices = models
      .filter(
        (model): model is PiModelLike =>
          Boolean(model) &&
          typeof model.provider === "string" &&
          typeof model.id === "string",
      )
      .map(modelChoiceFromPi);
    const unique = new Map<string, ModelChoice>();
    for (const choice of choices) unique.set(modelKey(choice), choice);
    return [...unique.values()].sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name),
    );
  }

  #findModel(choice: ModelChoice): PiModelLike | undefined {
    const found = this.#context.modelRegistry.find?.(
      choice.provider,
      choice.id,
    );
    if (found) return found;
    const all =
      this.#context.modelRegistry.getAll?.() ??
      this.#context.modelRegistry.getAvailable?.() ??
      [];
    return all.find(
      (model) => model.provider === choice.provider && model.id === choice.id,
    );
  }

  #getThinkingLevel(): string {
    const value = this.#pi.getThinkingLevel?.() ?? this.#context.thinkingLevel;
    return typeof value === "string" && value.length > 0 ? value : "off";
  }

  #getAllowedThinkingLevels(): string[] {
    const advertised =
      this.#pi.getAllowedThinkingLevels?.() ??
      this.#pi.getAvailableThinkingLevels?.();
    const current = this.#getThinkingLevel();
    const derived = deriveThinkingLevels(this.#context.model);
    const levels = dedupeStrings(advertised ?? derived ?? [current]);
    // A custom Pi build may introduce a level before this package knows its model metadata.
    // Preserve the currently active value so the deck never advertises an impossible snapshot.
    if (!levels.includes(current)) levels.unshift(current);
    return levels;
  }

  #getExpansionStates(): ToolExpansionState[] {
    const states = this.#expansion.getStates();
    return states
      .map((state) => {
        const tracked = this.#trackedTools.get(state.id);
        return {
          ...state,
          name: tracked?.name ?? state.name,
          status: tracked?.status ?? state.status,
          turnIndex: tracked?.turnIndex ?? state.turnIndex,
        };
      })
      .sort((a, b) => a.turnIndex - b.turnIndex || a.id.localeCompare(b.id));
  }

  #trackTool(record: Record<string, unknown>, status: ToolStatus): void {
    const id = stringField(record, ["toolCallId", "id", "callId"]);
    if (!id) return;
    const name =
      stringField(record, ["toolName", "name", "tool"]) ??
      this.#trackedTools.get(id)?.name ??
      id;
    this.#trackedTools.set(id, {
      id,
      name,
      status,
      turnIndex: this.#turnIndex,
    });
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
