import type {
  PiApiLike,
  PiAssignment,
  PiContextLike,
  PiControl,
  PiLifecycleEvent,
  PiSafeState,
  PiAdapterCapabilities,
  PiModelLike,
} from "./types.js";
import { modelChoiceFromPi } from "./types.js";
import { LifecycleCorrelator, type CorrelationState } from "./correlation.js";
import { createId } from "../shared/ids.js";

function sessionId(context: PiContextLike): string {
  const id = context.sessionManager.getSessionId?.();
  if (!id || !/^[\x21-\x7e]{1,256}$/.test(id))
    throw new Error("PI_SESSION_ID_UNAVAILABLE");
  return id;
}
function latestAssistantText(context: PiContextLike): string | undefined {
  const entries = context.sessionManager.getEntries?.() ?? [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const message =
      record.message &&
      typeof record.message === "object" &&
      !Array.isArray(record.message)
        ? (record.message as Record<string, unknown>)
        : record;
    if (message.role !== "assistant") continue;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (item): item is Record<string, unknown> =>
                  !!item && typeof item === "object" && !Array.isArray(item),
              )
              .filter(
                (item) => item.type === "text" && typeof item.text === "string",
              )
              .map((item) => item.text as string)
              .join("\n")
          : undefined;
    if (text && Buffer.byteLength(text, "utf8") <= 65_536) return text;
  }
  return undefined;
}
export function capabilities(
  api: PiApiLike,
  context: PiContextLike,
): PiAdapterCapabilities {
  return {
    core:
      typeof api.sendUserMessage === "function" &&
      typeof context.isIdle === "function",
    prompt: typeof api.sendUserMessage === "function",
    steer: typeof api.sendUserMessage === "function",
    followUp: typeof api.sendUserMessage === "function",
    abort: typeof context.abort === "function",
    compact: typeof context.compact === "function",
    model: typeof api.setModel === "function",
    thinking: typeof api.setThinkingLevel === "function",
    tools: typeof api.setActiveTools === "function",
    toolExpansion: false,
  };
}
export class PiAdapter implements PiControl {
  readonly correlator = new LifecycleCorrelator();
  #api: PiApiLike;
  #context: PiContextLike;
  #agentId: string;
  #generation: number;
  #connectionGeneration: number | undefined;
  #capabilities: PiAdapterCapabilities;
  #activeCycleId: string | undefined;
  #peerAsk:
    | {
        resolve: (answer: string) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  constructor(
    api: PiApiLike,
    context: PiContextLike,
    agentId: string,
    generation: number,
  ) {
    this.#api = api;
    this.#context = context;
    this.#agentId = agentId;
    this.#generation = generation;
    this.#connectionGeneration = undefined;
    this.#activeCycleId = undefined;
    this.#peerAsk = undefined;
    this.#capabilities = capabilities(api, context);
  }
  updateContext(context: PiContextLike): void {
    this.#context = context;
    this.#capabilities = capabilities(this.#api, context);
  }
  #discardPeerAsk(): void {
    if (!this.#peerAsk) return;
    clearTimeout(this.#peerAsk.timer);
    this.#peerAsk = undefined;
  }
  bindIdentity(
    agentId: string,
    generation: number,
    connectionGeneration?: number,
  ): void {
    if (
      !/^[\x21-\x7e]{1,256}$/u.test(agentId) ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      (connectionGeneration !== undefined &&
        (!Number.isSafeInteger(connectionGeneration) ||
          connectionGeneration < 1))
    )
      throw new Error("PI_REGISTRATION_IDENTITY_INVALID");
    this.#agentId = agentId;
    this.#generation = generation;
    this.#connectionGeneration = connectionGeneration;
  }
  safeState(): PiSafeState {
    const model = this.#context.model;
    const usage = this.#context.getContextUsage?.();
    return {
      agentId: this.#agentId,
      generation: this.#generation,
      ...(this.#connectionGeneration !== undefined
        ? { connectionGeneration: this.#connectionGeneration }
        : {}),
      sessionId: sessionId(this.#context),
      idle: this.#context.isIdle(),
      pendingMessages: this.#context.hasPendingMessages() ? 1 : 0,
      activity: this.#context.isIdle() ? "idle" : "working",
      ...(model ? { model: modelChoiceFromPi(model) } : {}),
      ...(this.#context.thinkingLevel
        ? { thinkingLevel: this.#context.thinkingLevel }
        : {}),
      ...(usage ? { contextPercent: usage.percent } : {}),
      activeTools: this.#api.getActiveTools?.() ?? [],
      capabilities: this.#capabilities,
    };
  }
  async deliver(
    assignment: PiAssignment,
  ): Promise<"accepted" | "already_accepted"> {
    const result = this.correlator.deliver(assignment, this.safeState());
    if (result === "already_accepted") return result;
    this.#api.appendEntry?.("pi-herdr-orchestrator-assignment", {
      assignmentId: assignment.id,
      taskId: assignment.taskId,
      runId: assignment.runId,
      generation: assignment.generation,
      assignmentGeneration: assignment.assignmentGeneration,
      status: "pending",
    });
    this.correlator.markCustomEntryWritten();
    await this.prompt(renderAssignment(assignment));
    this.correlator.accept();
    this.persistCorrelation();
    return result;
  }
  onLifecycle(
    event: PiLifecycleEvent,
  ): "bound" | "manual" | "ignored" | "settled" {
    if (event.type === "agent_end" && this.#peerAsk) {
      const pending = this.#peerAsk;
      this.#peerAsk = undefined;
      clearTimeout(pending.timer);
      const answer = latestAssistantText(this.#context);
      if (answer) pending.resolve(answer);
      else pending.reject(new Error("PEER_ANSWER_UNAVAILABLE"));
    }
    const cycle =
      event.type === "agent_start"
        ? (this.#activeCycleId = `cyc_${createId("evt").slice(4)}`)
        : (event.agentCycleId ?? this.#activeCycleId);
    const result = this.correlator.lifecycle(
      cycle ? { ...event, agentCycleId: cycle } : event,
    );
    if (result === "bound" || result === "settled") this.persistCorrelation();
    return result;
  }
  recoveryLifecyclePayload(
    adapterSeq: number,
  ): Record<string, unknown> | undefined {
    const state = this.correlator.state;
    if (state.kind === "bound")
      return this.lifecyclePayload(
        "bound",
        {
          type: "turn_start",
          agentId: state.assignment.agentId,
          generation: state.assignment.generation,
          piSessionId: state.piSessionId,
          assignmentGeneration: state.assignment.assignmentGeneration,
          agentCycleId: state.agentCycleId,
          turnIndex: state.firstTurnIndex,
        },
        adapterSeq,
      );
    if (state.kind === "settled")
      return this.lifecyclePayload(
        "settled",
        {
          type: "agent_settled",
          agentId: state.assignment.agentId,
          generation: state.assignment.generation,
          piSessionId: state.piSessionId,
          assignmentGeneration: state.assignment.assignmentGeneration,
          agentCycleId: state.agentCycleId,
          turnIndex: state.firstTurnIndex,
        },
        adapterSeq,
      );
    return undefined;
  }
  lifecyclePayload(
    result: "bound" | "settled",
    event: PiLifecycleEvent,
    adapterSeq: number,
  ): Record<string, unknown> | undefined {
    const current = this.correlator.state;
    if (
      (current.kind !== "bound" && current.kind !== "settled") ||
      this.#connectionGeneration === undefined ||
      !current.agentCycleId
    )
      return undefined;
    const turnIndex =
      result === "bound" ? event.turnIndex : current.firstTurnIndex;
    if (turnIndex === undefined) return undefined;
    const assignment = current.assignment;
    const state = this.safeState();
    return {
      agentId: state.agentId,
      connectionGeneration: this.#connectionGeneration,
      adapterSeq,
      event: result === "bound" ? "turn_start" : "agent_settled",
      piSessionId: current.piSessionId,
      turnIndex,
      agentCycleId: current.agentCycleId,
      assignment: {
        assignmentId: assignment.id,
        generation: assignment.assignmentGeneration,
      },
      safeData: {
        toolName:
          typeof state.currentTool === "string" &&
          Buffer.byteLength(state.currentTool, "utf8") <= 256 &&
          !/[\u0000-\u001f\u007f]/u.test(state.currentTool)
            ? state.currentTool
            : null,
        contextPercent:
          typeof state.contextPercent === "number" &&
          Number.isFinite(state.contextPercent) &&
          Math.abs(state.contextPercent) <= 10_000
            ? state.contextPercent
            : null,
      },
    };
  }
  clearSettledCycle(): void {
    if (this.correlator.state.kind === "settled")
      this.#activeCycleId = undefined;
  }
  assignmentForTools(): PiAssignment | undefined {
    return this.correlator.activeAssignment();
  }
  correlationState(): CorrelationState {
    return this.correlator.exportState();
  }
  restoreCorrelation(state: CorrelationState): void {
    this.correlator.restoreState(state, this.safeState());
  }
  restoreAssignment(assignment: PiAssignment): void {
    this.correlator.restoreAssignment(assignment, this.safeState());
  }
  restorePersisted(
    kind: "accepted" | "bound" | "settled",
    assignment: PiAssignment,
    agentCycleId?: string,
    firstTurnIndex?: number,
  ): void {
    this.correlator.restorePersisted(
      kind,
      assignment,
      this.safeState(),
      agentCycleId,
      firstTurnIndex,
    );
  }
  persistCorrelation(): void {
    const state = this.correlator.state;
    if (state.kind === "none" || state.kind === "pending") return;
    this.#api.appendEntry?.("pi-herdr-orchestrator-correlation", {
      assignmentId: state.assignment.id,
      taskId: state.assignment.taskId,
      runId: state.assignment.runId,
      agentId: state.assignment.agentId,
      generation: state.assignment.generation,
      assignmentGeneration: state.assignment.assignmentGeneration,
      piSessionId:
        state.kind === "accepted"
          ? state.assignment.piSessionId
          : state.piSessionId,
      kind: state.kind,
      ...(state.kind !== "accepted"
        ? {
            agentCycleId: state.agentCycleId,
            firstTurnIndex: state.firstTurnIndex,
          }
        : {}),
    });
  }
  async handleControl(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: true; answer?: string }> {
    const state = this.safeState();
    const identity = [
      "agentId",
      "generation",
      "piSessionId",
      ...(state.connectionGeneration !== undefined
        ? ["connectionGeneration"]
        : []),
    ];
    if (
      identity.some(
        (key) =>
          params[key] !==
          (key === "agentId"
            ? state.agentId
            : key === "generation"
              ? state.generation
              : key === "piSessionId"
                ? state.sessionId
                : state.connectionGeneration),
      )
    )
      throw new Error("PI_IDENTITY_MISMATCH");
    const allowed = new Set([
      ...identity,
      ...(method === "control.prompt" ||
      method === "control.steer" ||
      method === "control.ask"
        ? [
            "message",
            "delivery",
            ...(method === "control.ask" ? ["timeoutMs"] : []),
          ]
        : method === "control.set_model"
          ? ["provider", "modelId"]
          : method === "control.set_thinking"
            ? ["level"]
            : method === "control.set_tools"
              ? ["tools"]
              : method === "control.set_tool_expansion"
                ? ["name", "expanded"]
                : []),
    ]);
    if (
      ![
        "control.prompt",
        "control.steer",
        "control.ask",
        "control.abort",
        "control.compact",
        "control.set_model",
        "control.set_thinking",
        "control.set_tools",
        "control.set_tool_expansion",
      ].includes(method) ||
      Object.keys(params).some((key) => !allowed.has(key))
    )
      throw new Error("INVALID_REQUEST");
    if (
      method === "control.prompt" ||
      method === "control.steer" ||
      method === "control.ask"
    ) {
      if (
        typeof params.message !== "string" ||
        params.message.length === 0 ||
        Buffer.byteLength(params.message, "utf8") > 65_536 ||
        /[\u0000-\u001f\u007f]/u.test(params.message)
      )
        throw new Error("INVALID_REQUEST");
      if (method === "control.ask") {
        if (
          this.#peerAsk ||
          !Number.isSafeInteger(params.timeoutMs) ||
          Number(params.timeoutMs) < 1 ||
          Number(params.timeoutMs) > 120_000 ||
          (params.delivery !== "normal" && params.delivery !== "follow_up")
        )
          throw new Error("INVALID_REQUEST");
        const answer = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (this.#peerAsk?.timer !== timer) return;
            this.#peerAsk = undefined;
            reject(new Error("PEER_ANSWER_TIMEOUT"));
          }, Number(params.timeoutMs));
          timer.unref?.();
          this.#peerAsk = { resolve, reject, timer };
        });
        try {
          if (params.delivery === "normal") await this.prompt(params.message);
          else await this.followUp(params.message);
          return { ok: true, answer: await answer };
        } catch (error) {
          this.#discardPeerAsk();
          throw error;
        }
      }
      if (method === "control.prompt") {
        if (params.delivery !== undefined && params.delivery !== "normal")
          throw new Error("INVALID_REQUEST");
        await this.prompt(params.message);
      } else {
        if (params.delivery === "steer") await this.steer(params.message);
        else if (params.delivery === "follow_up")
          await this.followUp(params.message);
        else throw new Error("INVALID_REQUEST");
      }
    } else if (method === "control.abort") await this.abort();
    else if (method === "control.compact") await this.compact();
    else if (method === "control.set_model") {
      if (
        typeof params.provider !== "string" ||
        typeof params.modelId !== "string"
      )
        throw new Error("INVALID_REQUEST");
      await this.setModel(params.provider, params.modelId);
    } else if (method === "control.set_thinking") {
      if (typeof params.level !== "string") throw new Error("INVALID_REQUEST");
      await this.setThinking(params.level);
    } else if (method === "control.set_tools") {
      if (
        !Array.isArray(params.tools) ||
        params.tools.length > 128 ||
        params.tools.some(
          (name) =>
            typeof name !== "string" || name.length === 0 || name.length > 128,
        )
      )
        throw new Error("INVALID_REQUEST");
      await this.setTools(params.tools);
    } else {
      if (
        typeof params.name !== "string" ||
        params.name.length === 0 ||
        params.name.length > 128 ||
        typeof params.expanded !== "boolean"
      )
        throw new Error("INVALID_REQUEST");
      await this.expandTool(params.name, params.expanded);
    }
    return { ok: true };
  }
  async prompt(message: string): Promise<void> {
    this.require("prompt");
    const prior = this.correlationState();
    const rebind = prior.kind === "settled";
    if (rebind) {
      this.restoreAssignment(prior.assignment);
      try {
        this.persistCorrelation();
      } catch (error) {
        this.restoreCorrelation(prior);
        throw error;
      }
    }
    try {
      await this.#api.sendUserMessage!(message);
    } catch (error) {
      if (rebind) {
        this.restoreCorrelation(prior);
        try {
          this.persistCorrelation();
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "Prompt delivery and settled-assignment restoration failed.",
          );
        }
      }
      throw error;
    }
  }
  async steer(message: string): Promise<void> {
    this.require("steer");
    if (this.#context.isIdle()) throw new Error("AGENT_NOT_WORKING");
    await this.#api.sendUserMessage!(message, { deliverAs: "steer" });
  }
  async followUp(message: string): Promise<void> {
    this.require("followUp");
    if (this.#context.isIdle()) throw new Error("AGENT_NOT_WORKING");
    await this.#api.sendUserMessage!(message, { deliverAs: "followUp" });
  }
  async abort(): Promise<void> {
    this.require("abort");
    if (this.#context.isIdle()) throw new Error("AGENT_NOT_WORKING");
    this.#context.abort();
  }
  async compact(): Promise<void> {
    this.require("compact");
    if (!this.#context.isIdle()) throw new Error("AGENT_NOT_IDLE");
    await new Promise<void>((resolve, reject) =>
      this.#context.compact({ onComplete: resolve, onError: reject }),
    );
  }
  async setModel(provider: string, modelId: string): Promise<void> {
    this.require("model");
    const model = this.#context.modelRegistry.find?.(provider, modelId);
    if (!model) throw new Error("PI_MODEL_UNAVAILABLE");
    const accepted = await this.#api.setModel!(model);
    if (accepted === false) throw new Error("PI_COMMAND_REJECTED");
  }
  async setThinking(level: string): Promise<void> {
    this.require("thinking");
    const choices =
      this.#api.getAllowedThinkingLevels?.() ??
      this.#api.getAvailableThinkingLevels?.() ??
      [];
    if (!choices.includes(level)) throw new Error("PI_THINKING_UNAVAILABLE");
    this.#api.setThinkingLevel!(level);
  }
  async setTools(names: string[]): Promise<void> {
    this.require("tools");
    const available = new Set(
      (this.#api.getAllTools?.() ?? []).map((tool) => tool.name),
    );
    if (names.some((name) => !available.has(name)))
      throw new Error("PI_TOOL_UNAVAILABLE");
    this.#api.setActiveTools!(names);
  }
  async expandTool(_name: string, _expanded: boolean): Promise<void> {
    throw new Error("PI_CAPABILITY_MISSING");
  }
  private require(capability: keyof PiAdapterCapabilities): void {
    if (!this.#capabilities[capability])
      throw new Error("PI_CAPABILITY_MISSING");
  }
}
export function renderAssignment(assignment: PiAssignment): string {
  const constraints =
    assignment.constraints.map((item) => `- ${item}`).join("\n") || "- None";
  return `# Managed Orchestrator Task\n\nTask ID: ${assignment.taskId}\nRun: ${assignment.runId}\nDeadline: ${assignment.deadline}\n\n## Objective\n${assignment.objective}\n\n## Constraints\n${constraints}\n\n## Completion contract\nBefore ending, call the managed result tool exactly once. Use the structured question tool for blocking questions.`;
}
export function piSessionId(context: PiContextLike): string {
  return sessionId(context);
}
export type { PiModelLike };
