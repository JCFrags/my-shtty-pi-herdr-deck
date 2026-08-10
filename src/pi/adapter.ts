import type { PiApiLike, PiAssignment, PiContextLike, PiControl, PiLifecycleEvent, PiSafeState, PiAdapterCapabilities, PiModelLike } from "./types.js";
import { modelChoiceFromPi } from "./types.js";
import { LifecycleCorrelator } from "./correlation.js";

function sessionId(context: PiContextLike): string {
  const id = context.sessionManager.getSessionId?.();
  if (!id || !/^[\x21-\x7e]{1,256}$/.test(id)) throw new Error("PI_SESSION_ID_UNAVAILABLE");
  return id;
}
export function capabilities(api: PiApiLike, context: PiContextLike): PiAdapterCapabilities {
  return { core: typeof api.sendUserMessage === "function" && typeof context.isIdle === "function", prompt: typeof api.sendUserMessage === "function", steer: typeof api.sendUserMessage === "function", followUp: typeof api.sendUserMessage === "function", abort: typeof context.abort === "function", compact: typeof context.compact === "function", model: typeof api.setModel === "function", thinking: typeof api.setThinkingLevel === "function", tools: typeof api.setActiveTools === "function", toolExpansion: false };
}
export class PiAdapter implements PiControl {
  readonly correlator = new LifecycleCorrelator();
  #api: PiApiLike;
  #context: PiContextLike;
  #agentId: string;
  #generation: number;
  #capabilities: PiAdapterCapabilities;
  constructor(api: PiApiLike, context: PiContextLike, agentId: string, generation: number) { this.#api = api; this.#context = context; this.#agentId = agentId; this.#generation = generation; this.#capabilities = capabilities(api, context); }
  updateContext(context: PiContextLike): void { this.#context = context; this.#capabilities = capabilities(this.#api, context); }
  safeState(): PiSafeState { const model = this.#context.model; const usage = this.#context.getContextUsage?.(); return { agentId: this.#agentId, generation: this.#generation, sessionId: sessionId(this.#context), idle: this.#context.isIdle(), pendingMessages: this.#context.hasPendingMessages() ? 1 : 0, activity: this.#context.isIdle() ? "idle" : "working", ...(model ? { model: modelChoiceFromPi(model) } : {}), ...(this.#context.thinkingLevel ? { thinkingLevel: this.#context.thinkingLevel } : {}), ...(usage ? { contextPercent: usage.percent } : {}), activeTools: this.#api.getActiveTools?.() ?? [], capabilities: this.#capabilities }; }
  async deliver(assignment: PiAssignment): Promise<"accepted" | "already_accepted"> { const result = this.correlator.deliver(assignment, this.safeState()); if (result === "already_accepted") return result; this.#api.appendEntry?.("pi-herdr-orchestrator-assignment", { assignmentId: assignment.id, taskId: assignment.taskId, runId: assignment.runId, generation: assignment.generation, assignmentGeneration: assignment.assignmentGeneration, status: "pending" }); this.correlator.markCustomEntryWritten(); await this.prompt(renderAssignment(assignment)); this.correlator.accept(); return result; }
  onLifecycle(event: PiLifecycleEvent): "bound" | "manual" | "ignored" | "settled" { return this.correlator.lifecycle(event); }
  assignmentForTools(): PiAssignment | undefined { return this.correlator.pending(); }
  async prompt(message: string): Promise<void> { this.require("prompt"); await this.#api.sendUserMessage!(message); }
  async steer(message: string): Promise<void> { this.require("steer"); if (this.#context.isIdle()) throw new Error("AGENT_NOT_WORKING"); await this.#api.sendUserMessage!(message, { deliverAs: "steer" }); }
  async followUp(message: string): Promise<void> { this.require("followUp"); if (this.#context.isIdle()) throw new Error("AGENT_NOT_WORKING"); await this.#api.sendUserMessage!(message, { deliverAs: "followUp" }); }
  async abort(): Promise<void> { this.require("abort"); if (this.#context.isIdle()) throw new Error("AGENT_NOT_WORKING"); this.#context.abort(); }
  async compact(): Promise<void> { this.require("compact"); if (!this.#context.isIdle()) throw new Error("AGENT_NOT_IDLE"); await new Promise<void>((resolve, reject) => this.#context.compact({ onComplete: resolve, onError: reject })); }
  async setModel(provider: string, modelId: string): Promise<void> { this.require("model"); const model = this.#context.modelRegistry.find?.(provider, modelId); if (!model) throw new Error("PI_MODEL_UNAVAILABLE"); const accepted = await this.#api.setModel!(model); if (accepted === false) throw new Error("PI_COMMAND_REJECTED"); }
  async setThinking(level: string): Promise<void> { this.require("thinking"); const choices = this.#api.getAllowedThinkingLevels?.() ?? this.#api.getAvailableThinkingLevels?.() ?? []; if (!choices.includes(level)) throw new Error("PI_THINKING_UNAVAILABLE"); this.#api.setThinkingLevel!(level); }
  async setTools(names: string[]): Promise<void> { this.require("tools"); const available = new Set((this.#api.getAllTools?.() ?? []).map((tool) => tool.name)); if (names.some((name) => !available.has(name))) throw new Error("PI_TOOL_UNAVAILABLE"); this.#api.setActiveTools!(names); }
  async expandTool(_name: string, _expanded: boolean): Promise<void> { throw new Error("PI_CAPABILITY_MISSING"); }
  private require(capability: keyof PiAdapterCapabilities): void { if (!this.#capabilities[capability]) throw new Error("PI_CAPABILITY_MISSING"); }
}
export function renderAssignment(assignment: PiAssignment): string { const constraints = assignment.constraints.map((item) => `- ${item}`).join("\n") || "- None"; return `# Managed Orchestrator Task\n\nTask ID: ${assignment.taskId}\nRun: ${assignment.runId}\nDeadline: ${assignment.deadline}\n\n## Objective\n${assignment.objective}\n\n## Constraints\n${constraints}\n\n## Completion contract\nBefore ending, call the managed result tool exactly once. Use the structured question tool for blocking questions.`; }
export function piSessionId(context: PiContextLike): string { return sessionId(context); }
export type { PiModelLike };
