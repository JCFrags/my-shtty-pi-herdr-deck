import { canonicalStringify, cloneCanonical } from "./canonical.mjs";

const ID = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const DISPATCH_ID = "^[A-Za-z0-9][A-Za-z0-9._:-]{7,95}$";
const HASH = "^sha256:[0-9a-f]{64}$";
const BROKER_HASH = "^[0-9a-f]{64}$";

const string = (extra = {}) => ({ type: "string", ...extra });
const integer = (minimum, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum });
const optional = (schema) => schema;
const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const enumString = (values) => ({ type: "string", enum: values });

function result(text, details) {
  const exactDetails = cloneCanonical(details);
  const exactText = canonicalStringify(exactDetails);
  return { content: [{ type: "text", text: `${text}\n\nExact typed result:\n${exactText}` }], details: exactDetails };
}

function definition(name, label, description, parameters, execute, promptGuidelines) {
  return Object.freeze({
    name,
    label,
    description,
    promptSnippet: description,
    promptGuidelines,
    parameters,
    executionMode: "sequential",
    execute,
  });
}

function exactCapabilities(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool capabilities are invalid.");
  const names = ["answer", "attach", "cancel", "controller", "dispatch", "participant", "question", "report", "start", "status", "wait"];
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !names.includes(key))) throw new Error("Tool capabilities have an unknown field.");
  const copied = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value") || typeof descriptor.value !== "boolean") {
      throw new Error(`Tool capability ${name} is invalid.`);
    }
    copied[name] = descriptor.value;
  }
  return copied;
}

export function createOrchestrationToolDefinitions(runtime, inputCapabilities) {
  if (runtime === null || typeof runtime !== "object") throw new Error("An enabled orchestration runtime is required.");
  const capabilities = exactCapabilities(inputCapabilities);
  const tools = [];

  if (capabilities.start) tools.push(definition(
    "agent_start_or_reuse",
    "Start or Reuse Approved Agent",
    "Start or reuse one manifest-approved agent and reserve its dispatch without submitting a task.",
    object({
      operationId: string({ pattern: ID }), expectedRevision: integer(0), jobId: string({ pattern: ID }), workId: string({ pattern: ID }),
      dispatchId: string({ pattern: DISPATCH_ID }), contractHash: string({ pattern: HASH }), logicalAgent: string({ pattern: ID }),
      leaseMs: integer(1, 86_400_000),
    }, ["operationId", "expectedRevision", "jobId", "workId", "dispatchId", "contractHash", "logicalAgent", "leaseMs"]),
    async (_id, params) => result("Started or reused the approved agent. The dispatch remains reserved and unsubmitted.", await runtime.startOrReuse(params)),
    ["Do not treat process start or reuse as dispatch acceptance or task start."],
  ));

  if (capabilities.attach) tools.push(definition(
    "agent_attach",
    "Attach Existing Approved Agent",
    "Bind one exact approved existing agent identity and reserve a dispatch without starting or submitting work.",
    object({
      operationId: string({ pattern: ID }), expectedRevision: { const: 0 }, jobId: string({ pattern: ID }), dispatchId: string({ pattern: DISPATCH_ID }),
      workId: string({ pattern: ID }), contractHash: string({ pattern: HASH }), logicalAgent: string({ pattern: ID }), leaseMs: integer(1, 86_400_000),
    }, ["operationId", "expectedRevision", "jobId", "dispatchId", "workId", "contractHash", "logicalAgent", "leaseMs"]),
    async (_id, params) => result("Attached the approved existing identity. No dispatch occurred.", await runtime.attach(params)),
    ["A reserved dispatch is not submitted, accepted, started, settled, or complete."],
  ));

  if (capabilities.dispatch) tools.push(definition(
    "agent_dispatch",
    "Dispatch Approved Agent Task",
    "Submit one bounded task through the durable identity-bound keyed Pi-core admission seam.",
    object({
      operationId: string({ pattern: ID }), expectedRevision: integer(0), jobId: string({ pattern: ID }), dispatchId: string({ pattern: DISPATCH_ID }),
      contractHash: string({ pattern: HASH }),
      payload: object({ schema: { const: "pi-agent-task-payload/1.0.0" }, text: string({ minLength: 1, maxLength: 65_536 }) }, ["schema", "text"]),
    }, ["operationId", "expectedRevision", "jobId", "dispatchId", "contractHash", "payload"]),
    async (_id, params) => result("Processed the keyed dispatch operation. Inspect its exact typed result.", await runtime.dispatch(params)),
    ["Only accepted or already_accepted with a correlated keyed receipt proves admission. Idle and done prove nothing."],
  ));

  if (capabilities.status) tools.push(definition(
    "agent_status",
    "Read Orchestration Status",
    "Read one merged durable broker and orchestration projection. Reconciliation is explicit.",
    object({ jobId: string({ pattern: ID }), reconcile: optional({ type: "boolean" }) }, ["jobId"]),
    async (_id, params) => result("Read the merged durable status. Observation fields are not authority.", await runtime.status(params)),
    ["Treat focus, terminal output, idle, done, and generic exit only as observations."],
  ));

  if (capabilities.wait) tools.push(definition(
    "agent_wait",
    "Create Durable Agent Watch",
    "Create a bounded durable broker or typed orchestration watch and return its handle immediately.",
    object({
      operationId: string({ pattern: ID }), expectedRevision: integer(0), jobId: string({ pattern: ID }),
      kind: enumString(["observation", "validated_report", "dispatch_terminal", "question_open", "answer_accepted", "progress"]),
      timeoutMs: integer(1, 604_800_000), statuses: optional({ type: "array", items: enumString(["idle", "working", "blocked", "done", "unknown"]), minItems: 1, maxItems: 5, uniqueItems: true }),
      pollMs: optional(integer(50, 60_000)), reportId: optional(string({ pattern: ID })), questionId: optional(string({ pattern: ID })),
      planId: optional(string({ pattern: ID })), taskId: optional(string({ pattern: ID })), minimumPercent: optional(integer(0, 100)),
    }, ["operationId", "expectedRevision", "jobId", "kind", "timeoutMs"]),
    async (_id, params) => result("Created a non-blocking durable watch. It proves only its exact predicate.", await runtime.wait(params)),
    ["A satisfied observation or report watch is not task completion. Timers only accelerate journal checks."],
  ));

  if (capabilities.question) tools.push(definition(
    "agent_question",
    "Open Bound Agent Question",
    "Open one durable question for the sole active bound child dispatch.",
    object({
      operationId: string({ pattern: ID }), text: string({ minLength: 1, maxLength: 16_384 }),
      choices: optional({ type: "array", items: string({ minLength: 1, maxLength: 1_024 }), maxItems: 32, uniqueItems: true }),
    }, ["operationId", "text"]),
    async (_id, params) => result("Persisted the bound question before exposing it.", await runtime.question(params)),
    ["The active dispatch, identity, and turn are derived from participant authority. Idle does not answer a question."],
  ));

  if (capabilities.answer) tools.push(definition(
    "agent_answer",
    "Answer Bound Agent Question",
    "Persist and deliver one bounded answer to an exact open question on an approved dispatch.",
    object({
      operationId: string({ pattern: ID }), expectedRevision: integer(0), jobId: string({ pattern: ID }), questionId: string({ pattern: ID }),
      answer: string({ minLength: 1, maxLength: 16_384 }),
    }, ["operationId", "expectedRevision", "jobId", "questionId", "answer"]),
    async (_id, params) => result("Persisted the answer before one exact bound delivery attempt.", await runtime.answer(params)),
    ["A duplicate exact answer replays. A changed answer conflicts and is not delivered."],
  ));

  if (capabilities.report) tools.push(definition(
    "agent_report",
    "Manage Bound Agent Report",
    "Issue, publish, read, validate, or acknowledge one bounded broker report.",
    object({
      action: enumString(["issue_file", "publish", "get", "validate", "acknowledge"]), jobId: string({ pattern: ID }),
      operationId: optional(string({ pattern: ID })), expectedRevision: optional(integer(1)), reportId: optional(string({ pattern: ID })),
      storage: optional(enumString(["inline", "file"])), report: optional({}), expectedSha256: optional(string({ pattern: BROKER_HASH })),
    }, ["action", "jobId"]),
    async (_id, params) => result("Processed the bounded report operation. Report validation does not prove lifecycle.", await runtime.report(params)),
    ["File publication uses only a prior broker-issued staging path. No request selects a destination path."],
  ));

  if (capabilities.controller) tools.push(definition(
    "agent_plan",
    "Manage Workflow Plan",
    "Define or read one bounded dependency DAG, admit ready tasks through deterministic local resource counters, or complete one admitted task.",
    object({
      action: enumString(["define", "admit", "complete", "status"]), planId: string({ pattern: ID }),
      operationId: optional(string({ pattern: ID })), expectedRevision: optional(integer(0)), taskId: optional(string({ pattern: ID })),
      outcome: optional(enumString(["succeeded", "failed"])),
      tasks: optional({ type: "array", minItems: 1, maxItems: 16, items: object({
        taskId: string({ pattern: ID }), jobId: string({ pattern: ID }),
        dependsOn: { type: "array", maxItems: 8, uniqueItems: true, items: string({ pattern: ID }) }, priority: integer(0, 100),
        resources: object({ agentSlots: { const: 1 }, cpuSlots: integer(1, 2), memoryMb: integer(64, 2048) }, ["agentSlots", "cpuSlots", "memoryMb"]),
      }, ["taskId", "jobId", "dependsOn", "priority", "resources"]) }),
    }, ["action", "planId"]),
    async (_id, params) => result("Processed the bounded workflow plan and deterministic resource admission operation.", await runtime.plan(params)),
    ["Dependencies and resource counters are durable authority. Only an admitted task owns its declared local capacity."],
  ));

  if (capabilities.report) tools.push(definition(
    "agent_progress",
    "Publish Structured Progress",
    "Publish or read bounded structured progress for one admitted workflow task.",
    object({
      action: enumString(["update", "get"]), planId: string({ pattern: ID }), taskId: string({ pattern: ID }),
      operationId: optional(string({ pattern: ID })), expectedRevision: optional(integer(0)), phase: optional(string({ minLength: 1, maxLength: 64 })),
      completed: optional(integer(0, 1_000_000)), total: optional(integer(1, 1_000_000)), state: optional(enumString(["active", "blocked", "completed", "failed"])),
      message: optional(string({ minLength: 1, maxLength: 512 })),
    }, ["action", "planId", "taskId"]),
    async (_id, params) => result("Processed bounded structured progress. Progress does not release resources or prove task completion.", await runtime.progress(params)),
    ["Use agent_plan complete for task completion and resource release."],
  ));

  if (capabilities.status) tools.push(definition(
    "agent_events",
    "Wait for Workflow Events",
    "Read or bounded-wait for hash-correlated workflow-ledger events after one exact sequence.",
    object({ afterSequence: integer(0), limit: integer(1, 32), waitMs: integer(0, 60_000), planId: optional(string({ pattern: ID })) }, ["afterSequence", "limit", "waitMs"]),
    async (_id, params) => result("Read the bounded workflow event stream. Each returned event names its durable authority.", await runtime.events(params)),
    ["Advance afterSequence to nextSequence. A timed-out stream is not task failure."],
  ));

  if (capabilities.cancel) {
    const controller = capabilities.controller === true;
    const properties = {
      operationId: string({ pattern: ID }), expectedRevision: integer(0), jobId: string({ pattern: ID }),
      kind: enumString(controller ? ["watch", "task", "dispatch"] : ["watch", "task"]),
      watchId: optional(string({ pattern: ID })), reason: string({ minLength: 1, maxLength: 512 }),
    };
    if (controller) {
      properties.dispatchId = optional(string({ pattern: DISPATCH_ID }));
      properties.mode = optional(enumString(["request", "stop", "kill"]));
      properties.graceMs = optional(integer(0, 300_000));
    }
    tools.push(definition(
      "agent_cancel",
      "Cancel Agent Watch or Dispatch",
      controller ? "Cancel a watch, request task cancellation, or apply dispatch-scoped request, stop, or kill control." : "Cancel a watch or record a task cancellation request without process control.",
      object(properties, ["operationId", "expectedRevision", "jobId", "kind", "reason"]),
      async (_id, params) => result("Processed the bounded cancellation operation. Inspect its exact typed result.", await runtime.cancel(params)),
      ["Cancellation request, acknowledgement, cooperative stop, and exact pidfd force kill are distinct states."],
    ));
  }

  return Object.freeze(tools);
}

export function registerOrchestrationTools(pi, runtime, capabilities) {
  if (pi === null || typeof pi !== "object" || typeof pi.registerTool !== "function") throw new Error("Pi tool registrar is invalid.");
  const tools = createOrchestrationToolDefinitions(runtime, capabilities);
  for (const tool of tools) pi.registerTool(tool);
  return tools.map((tool) => tool.name);
}
