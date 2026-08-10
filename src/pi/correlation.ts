import type { PiSafeState, PiLifecycleEvent, PiAssignment } from "./types.js";

export type CorrelationState =
  | { kind: "none" }
  | { kind: "pending"; assignment: PiAssignment; customEntryWritten: boolean }
  | { kind: "accepted"; assignment: PiAssignment; acceptedAt: string }
  | { kind: "bound"; assignment: PiAssignment; piSessionId: string; agentCycleId: string; firstTurnIndex: number }
  | { kind: "settled"; assignment: PiAssignment; piSessionId: string; agentCycleId: string; firstTurnIndex: number };

export class LifecycleCorrelator {
  #state: CorrelationState = { kind: "none" };
  get state(): CorrelationState { return this.#state; }
  pending(): PiAssignment | undefined {
    return this.#state.kind === "pending" || this.#state.kind === "accepted" ? this.#state.assignment : undefined;
  }
  deliver(assignment: PiAssignment, safe: PiSafeState): "accepted" | "already_accepted" {
    if (assignment.agentId !== safe.agentId || assignment.generation !== safe.generation || assignment.piSessionId !== safe.sessionId)
      throw new Error("PI_IDENTITY_MISMATCH");
    if (!safe.idle || safe.pendingMessages > 0 || this.#state.kind !== "none") {
      if (this.#state.kind !== "none" && this.#state.assignment.id === assignment.id) return "already_accepted";
      throw new Error("AGENT_NOT_IDLE");
    }
    this.#state = { kind: "pending", assignment, customEntryWritten: false };
    return "accepted";
  }
  markCustomEntryWritten(): void {
    if (this.#state.kind !== "pending") throw new Error("ASSIGNMENT_NOT_PENDING");
    this.#state = { ...this.#state, customEntryWritten: true };
  }
  accept(now = new Date().toISOString()): void {
    if (this.#state.kind === "accepted" || this.#state.kind === "bound" || this.#state.kind === "settled") return;
    if (this.#state.kind !== "pending") throw new Error("ASSIGNMENT_NOT_PENDING");
    this.#state = { kind: "accepted", assignment: this.#state.assignment, acceptedAt: now };
  }
  lifecycle(event: PiLifecycleEvent): "bound" | "manual" | "ignored" | "settled" {
    if (event.type === "agent_settled" || event.type === "agent_end") {
      if (this.#state.kind === "bound" && this.matches(event)) {
        if (event.type === "agent_settled") {
          this.#state = { kind: "settled", assignment: this.#state.assignment, piSessionId: this.#state.piSessionId, agentCycleId: this.#state.agentCycleId, firstTurnIndex: this.#state.firstTurnIndex };
          return "settled";
        }
        return "ignored";
      }
      return "manual";
    }
    if (event.type !== "before_agent_start" && event.type !== "agent_start" && event.type !== "turn_start") return "ignored";
    if (this.#state.kind === "accepted" && this.matches(event) && event.agentCycleId && event.turnIndex !== undefined) {
      this.#state = { kind: "bound", assignment: this.#state.assignment, piSessionId: event.piSessionId, agentCycleId: event.agentCycleId, firstTurnIndex: event.turnIndex };
      return "bound";
    }
    return "manual";
  }
  cancel(): void { if (this.#state.kind !== "none") this.#state = { kind: "none" }; }
  private matches(event: PiLifecycleEvent): boolean {
    const assignment = this.#state.kind === "settled" || this.#state.kind === "bound" ? this.#state.assignment : this.pending();
    return !!assignment && assignment.agentId === event.agentId && assignment.generation === event.generation && assignment.piSessionId === event.piSessionId && (assignment.assignmentGeneration === event.assignmentGeneration || event.assignmentGeneration === undefined);
  }
}
