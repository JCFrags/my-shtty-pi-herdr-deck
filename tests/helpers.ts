import { EventEmitter } from "node:events";
import type { ToolExpansionAdapter } from "../src/bridge/capabilities.js";
import type { DeckController } from "../src/bridge/pi-controller.js";
import type { CommandFrame, DeckState, ToolExpansionState } from "../src/bridge/protocol.js";
import type { PiApiLike, PiContextLike, PiModelLike, PiToolLike } from "../src/pi/types.js";

export function baseState(overrides: Partial<DeckState> = {}): DeckState {
  return {
    sessionId: "session-1",
    herdrPaneId: "1:1/2",
    activity: "idle",
    queuedMessage: false,
    model: { provider: "test", id: "model-1", name: "Model One" },
    modelChoices: [{ provider: "test", id: "model-1", name: "Model One", contextWindow: 1000 }],
    thinkingLevel: "medium",
    allowedThinkingLevels: ["off", "medium", "high"],
    context: { tokens: 420, window: 1000, percent: 42 },
    activeTools: ["read"],
    availableTools: ["read", "bash"],
    tools: [{ id: "call-1", name: "read", expanded: false, status: "complete", turnIndex: 1 }],
    turnIndex: 1,
    ...overrides,
  };
}

export class FakeController implements DeckController {
  readonly paneId: string;
  state: DeckState;
  commands: CommandFrame[] = [];
  readonly #events = new EventEmitter();

  constructor(state = baseState()) {
    this.state = state;
    this.paneId = state.herdrPaneId;
  }

  snapshot(): DeckState {
    return structuredClone(this.state);
  }

  async execute(command: CommandFrame): Promise<unknown> {
    this.commands.push(command);
    if (command.name === "refreshState") return this.snapshot();
    return null;
  }

  subscribe(listener: () => void): () => void {
    this.#events.on("change", listener);
    return () => this.#events.off("change", listener);
  }

  update(overrides: Partial<DeckState>): void {
    this.state = { ...this.state, ...overrides };
    this.#events.emit("change");
  }
}

export class FakeExpansion implements ToolExpansionAdapter {
  states: ToolExpansionState[] = [{ id: "call-1", name: "read", expanded: false, status: "complete", turnIndex: 1 }];
  toolChanges: Array<{ id: string; expanded: boolean }> = [];
  groupChanges: Array<{ scope: "currentTurn" | "session"; expanded: boolean }> = [];
  listeners = new Set<() => void>();

  getStates(): ToolExpansionState[] {
    return structuredClone(this.states);
  }

  setToolExpanded(toolCallId: string, expanded: boolean): void {
    this.toolChanges.push({ id: toolCallId, expanded });
    const state = this.states.find((item) => item.id === toolCallId);
    if (state) state.expanded = expanded;
    this.emit();
  }

  setGroupExpanded(scope: "currentTurn" | "session", expanded: boolean): void {
    this.groupChanges.push({ scope, expanded });
    for (const state of this.states) {
      if (scope === "session" || state.turnIndex === Math.max(...this.states.map((item) => item.turnIndex))) state.expanded = expanded;
    }
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export interface FakePiHarness {
  pi: PiApiLike;
  context: PiContextLike;
  expansion: FakeExpansion;
  messages: Array<{ text: string; deliverAs?: "steer" | "followUp" }>;
  aborted: number;
  compacted: number;
  activeTools: string[];
  thinkingLevel: string;
  model: PiModelLike;
  setIdle(idle: boolean): void;
}

export function createFakePiHarness(): FakePiHarness {
  const models: PiModelLike[] = [
    { provider: "test", id: "model-1", name: "Model One", contextWindow: 1000, reasoning: true },
    { provider: "test", id: "model-2", name: "Model Two", contextWindow: 2000, reasoning: true },
  ];
  const allTools: PiToolLike[] = [{ name: "read" }, { name: "bash" }];
  let idle = true;
  let aborted = 0;
  let compacted = 0;
  let activeTools = ["read"];
  let thinkingLevel = "medium";
  let model = models[0]!;
  const messages: Array<{ text: string; deliverAs?: "steer" | "followUp" }> = [];
  const expansion = new FakeExpansion();
  const context: PiContextLike = {
    ui: {},
    cwd: "/work",
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/tmp/session.jsonl",
      getCwd: () => "/work",
    },
    modelRegistry: {
      getAvailable: () => models,
      getAll: () => models,
      find: (provider, id) => models.find((candidate) => candidate.provider === provider && candidate.id === id),
    },
    model,
    isIdle: () => idle,
    hasPendingMessages: () => false,
    abort: () => { aborted += 1; },
    compact: () => { compacted += 1; },
    getContextUsage: () => ({ tokens: 420, contextWindow: 1000, percent: 42 }),
  };
  const pi: PiApiLike = {
    on: () => undefined,
    registerCommand: () => undefined,
    sendUserMessage: async (text, options) => { messages.push(options?.deliverAs ? { text, deliverAs: options.deliverAs } : { text }); },
    getActiveTools: () => activeTools,
    getAllTools: () => allTools,
    setActiveTools: (tools) => { activeTools = [...tools]; },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level) => { thinkingLevel = level; },
    getAllowedThinkingLevels: () => ["off", "medium", "high"],
    getScopedModels: () => models,
    setModel: async (selected) => { model = selected; context.model = selected; },
  };
  const harness: FakePiHarness = {
    pi,
    context,
    expansion,
    messages,
    get aborted() { return aborted; },
    get compacted() { return compacted; },
    get activeTools() { return activeTools; },
    get thinkingLevel() { return thinkingLevel; },
    get model() { return model; },
    setIdle(value: boolean) { idle = value; },
  };
  Object.defineProperty(context.ui, "toolExpansion", {
    value: {
      getStates: () => expansion.getStates(),
      setToolExpanded: (id: string, expanded: boolean) => expansion.setToolExpanded(id, expanded),
      setGroupExpanded: (scope: "currentTurn" | "session", expanded: boolean) => expansion.setGroupExpanded(scope, expanded),
      subscribe: (listener: () => void) => expansion.subscribe(listener),
    },
    enumerable: true,
  });
  return harness;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
