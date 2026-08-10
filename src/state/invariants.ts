import { OrchestratorError } from "../shared/errors.js";
import type { OrchestrationState } from "./types.js";
export function assertInvariants(state: OrchestrationState): void {
  const active = new Set<string>();
  for (const run of Object.values(state.runs)) {
    if (
      !["succeeded", "failed", "cancelled", "timed_out", "lost"].includes(
        run.state,
      ) &&
      run.agentId
    ) {
      if (active.has(run.agentId))
        throw new OrchestratorError(
          "INVALID_REQUEST",
          "An agent has more than one nonterminal run.",
        );
      active.add(run.agentId);
    }
  }
  for (const task of Object.values(state.tasks)) {
    if (task.currentRunId && !state.runs[task.currentRunId])
      throw new OrchestratorError(
        "STATE_CORRUPT",
        "Task points to a missing run.",
      );
  }
}
