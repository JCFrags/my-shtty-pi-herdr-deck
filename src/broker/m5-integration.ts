import type { Admission } from "../scheduler/scheduler.js";
import type { SchedulerTask } from "../scheduler/types.js";
import type { WorkflowPlan } from "../scheduler/workflows.js";

export type M5BrokerMethod =
  "scheduler.admit" | "scheduler.block" | "workflow.plan" | "task.cancel";

export interface M5BrokerCommand {
  readonly method: M5BrokerMethod;
  readonly params: Record<string, unknown>;
  readonly idempotencyKey: string;
}

export interface M5BrokerTransport {
  send(command: M5BrokerCommand): Promise<unknown>;
}

export interface M5DispatchResult {
  readonly command: M5BrokerCommand;
  readonly result: unknown;
}

function commandId(method: M5BrokerMethod, id: string): string {
  return `m5:${method}:${id}`;
}

function requireMatchingAdmission(
  admission: Admission,
  task: SchedulerTask,
): void {
  if (admission.taskId !== task.id) throw new Error("ADMISSION_TASK_MISMATCH");
}

/**
 * Converts frozen M5 decisions into narrow commands for later broker wiring.
 * The transport is injected so this adapter never opens a socket or changes state.
 */
export class M5BrokerIntegrationAdapter {
  readonly #transport: M5BrokerTransport;

  constructor(transport: M5BrokerTransport) {
    this.#transport = transport;
  }

  prepareAdmission(admission: Admission, task: SchedulerTask): M5BrokerCommand {
    requireMatchingAdmission(admission, task);
    if (admission.admitted) {
      return {
        method: "scheduler.admit",
        params: {
          taskId: task.id,
          parentAgentId: task.parentAgentId,
          profileId: task.profileId,
          depth: task.depth,
        },
        idempotencyKey: commandId("scheduler.admit", task.id),
      };
    }
    return {
      method: "scheduler.block",
      params: { taskId: task.id, reason: admission.reason },
      idempotencyKey: commandId("scheduler.block", task.id),
    };
  }

  prepareWorkflow(plan: WorkflowPlan): M5BrokerCommand {
    return {
      method: "workflow.plan",
      params: {
        workflowId: plan.workflowId,
        mode: plan.mode,
        dryRun: plan.dryRun,
        steps: plan.steps.map((step) => ({
          key: step.key,
          taskId: step.taskId,
          profileId: step.profileId,
          objective: step.objective,
          constraints: [...step.constraints],
          dependsOn: [...step.dependsOn],
          isolationMode: step.isolationMode,
        })),
        estimatedAgentCount: plan.estimatedAgentCount,
        limits: { ...plan.limits },
      },
      idempotencyKey: commandId("workflow.plan", plan.workflowId),
    };
  }

  prepareCancellation(taskId: string, reason = "cancelled"): M5BrokerCommand {
    if (!taskId) throw new Error("TASK_ID_REQUIRED");
    if (!reason || reason.length > 256)
      throw new Error("CANCELLATION_REASON_INVALID");
    return {
      method: "task.cancel",
      params: { taskId, reason },
      idempotencyKey: commandId("task.cancel", taskId),
    };
  }

  async dispatch(
    commands: readonly M5BrokerCommand[],
  ): Promise<readonly M5DispatchResult[]> {
    const results: M5DispatchResult[] = [];
    for (const command of commands)
      results.push({ command, result: await this.#transport.send(command) });
    return results;
  }
}
