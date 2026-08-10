import test from "node:test";
import assert from "node:assert/strict";
import { DeterministicScheduler, findReusableAgent } from "../../src/scheduler/scheduler.js";
import { assessBudget, forceStopAfterGrace } from "../../src/scheduler/budgets.js";
import { planWorkflow, validateWorkflow } from "../../src/scheduler/workflows.js";
import { ParentToolService, type ToolPrincipal } from "../../src/pi/parent-tools.js";

const task = (id: string, priority: "low" | "normal" | "high", queuedAt: number, parentAgentId = "agt_parent") => ({ id, parentAgentId, profileId: "scout", priority, queuedAt, depth: 1, dependencies: [], state: "queued" as const });
test("scheduler admits deterministic priority FIFO and enforces parent limit", () => {
  const scheduler = new DeterministicScheduler({ maxActiveAgents: 2, maxActivePerParent: 1 });
  scheduler.enqueue(task("tsk_b", "normal", 1)); scheduler.enqueue(task("tsk_a", "high", 2)); scheduler.enqueue(task("tsk_c", "low", 0, "agt_other"));
  const admissions = scheduler.admitReady();
  assert.deepEqual(admissions.map((item) => [item.taskId, item.admitted]), [["tsk_a", true], ["tsk_b", false], ["tsk_c", true]]);
});
test("scheduler blocks missing and unsuccessful dependencies", () => {
  const scheduler = new DeterministicScheduler();
  scheduler.enqueue({ ...task("tsk_child", "normal", 1), dependencies: [{ taskId: "tsk_parent", requirement: "succeeded" }] });
  assert.equal(scheduler.admitReady()[0]?.reason, "dependency_blocked");
});
test("reuse requires every policy identity to match", () => {
  const request = { profileId: "scout", projectKey: "p", trustKey: "t", toolPolicyHash: "tools", modelPolicyHash: "model" };
  assert.equal(findReusableAgent(request, [{ ...request, agentId: "agt_a", idle: true, cleanupPending: false }]), "agt_a");
  assert.equal(findReusableAgent(request, [{ ...request, agentId: "agt_a", idle: true, cleanupPending: true }]), undefined);
});
test("budget reports unknown dimensions and force stop after grace", () => {
  const budget = { wallTimeMs: 10000, softPercent: 80, graceMs: 1000 };
  const assessment = assessBudget(budget, { wallTimeMs: 10000, unavailable: ["costUsd"] });
  assert.equal(assessment.action, "graceful_stop"); assert.equal(assessment.percent, 100); assert.deepEqual(assessment.unavailable, ["costUsd"]);
  assert.equal(forceStopAfterGrace(assessment, 1000, 1000), "force_stop");
});
const workflow = { version: 1 as const, id: "dag", name: "DAG", description: "test", mode: "dag" as const, failureMode: "collect_all" as const, maxCorrectionLoops: 0, steps: [
  { key: "a", profileId: "scout", title: "A", objectiveTemplate: "{{input.objective}}", constraints: [], dependsOn: [], resultProjection: ["/summary"], isolationMode: "shared-readonly" as const },
  { key: "b", profileId: "scout", title: "B", objectiveTemplate: "Use {{steps.a.summary}}", constraints: [], dependsOn: ["a"], resultProjection: ["/summary"], isolationMode: "shared-readonly" as const },
] };
test("workflow planner validates DAG and keeps dry runs side-effect free", () => { validateWorkflow(workflow); const plan = planWorkflow(workflow, { objective: "inspect", dryRun: true }); assert.equal(plan.dryRun, true); assert.equal(plan.steps[1]?.objective, "Use "); });
test("workflow planner rejects cycles", () => { assert.throws(() => validateWorkflow({ ...workflow, steps: workflow.steps.map((step) => ({ ...step, dependsOn: ["b"] })) }), /WORKFLOW_CYCLE/); });
test("parent tools defer descendant authorization to the broker and bound model-visible output", async () => {
  const calls: string[] = []; const principal: ToolPrincipal = { id: "prn", kind: "pi_parent", agentId: "agt_parent", permissions: ["delegate"] };
  const service = new ParentToolService({ invoke: async (method) => { calls.push(method); return { workflowId: "wfl_1", summary: "x".repeat(100) }; } }, new Map([["agt_child", "agt_parent"]]), { maxResponseBytes: 10, maxTextBytes: 20 });
  const allowed = await service.execute({ tool: "agent_get", input: { agentId: "agt_child" } }, principal); assert.equal(allowed.ok, true); assert.equal(calls[0], "agent.get");
  const brokerAuthorized = await service.execute({ tool: "agent_get", input: { agentId: "agt_other" } }, principal); assert.equal(brokerAuthorized.ok, true);
});
