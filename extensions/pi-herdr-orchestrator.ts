import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiAdapter, piSessionId } from "../src/pi/adapter.js";
import {
  PiBrokerClient,
  type PiHerdrSessionReference,
} from "../src/pi/broker-client.js";
import { isAbsolute, resolve } from "node:path";
import type {
  PiApiLike,
  PiAssignment,
  PiContextLike,
  PiLifecycleEvent,
} from "../src/pi/types.js";
import {
  registerManagedChildTools,
  registerParentTools,
  type PiToolBinding,
} from "../src/pi/tools.js";
import { PARENT_TOOL_NAMES } from "../src/pi/parent-tool-schema.js";
import { openPiHerd } from "../src/herdr/pi-herd-command.js";
import {
  createStateReporter,
  type PiStateReporter,
} from "../src/pi/state-reporter.js";
import {
  readBrokerSecretFile,
  readManagedTokenFile,
  siblingSecretPath,
} from "../src/pi/token-file.js";
import { resolveHerdrPaths } from "../src/shared/paths.js";
import { ProviderProjectionCollector } from "../src/pi/provider-projection-collector.js";
import { ProviderEventAdapters } from "../src/pi/provider-event-adapters.js";
import { openAgentSettings } from "../src/pi/agent-settings.js";
export const ORCHESTRATION_TOOLS = new Set([
  "orchestrator_result",
  "orchestrator_ask",
  ...PARENT_TOOL_NAMES,
]);
const LEGACY_ORCHESTRATION_TOOLS = new Set([
  "agent_start_or_reuse",
  "agent_attach",
  "agent_dispatch",
  "agent_status",
  "agent_question",
  "agent_report",
  "agent_plan",
  "agent_progress",
  "agent_events",
  "agent_cancel",
]);
const KEY = Symbol.for("pi-herdr-orchestrator.runtime.v1");
const CREDENTIAL_KEY = Symbol.for("pi-herdr-orchestrator.credential.v1");
const TOOL_KEY = Symbol.for("pi-herdr-orchestrator.tools.v1");
interface Runtime {
  cleanup(reason?: string): void;
}
type Global = typeof globalThis & {
  [KEY]?: Runtime;
  [CREDENTIAL_KEY]?: string;
  [TOOL_KEY]?: PiToolBinding;
};
function inactive(context: PiContextLike): void {
  context.ui.setStatus?.(
    "pi-herdr-orchestrator",
    "Orchestrator inactive: Pi is outside a Herdr pane.",
  );
}
export function reconcileActiveTools(
  pi: PiApiLike,
  allowed: readonly string[],
): void {
  if (!pi.setActiveTools) return;
  const current = pi.getActiveTools?.() ?? [];
  const definitions = pi.getAllTools?.() ?? [];
  const counts = new Map<string, number>();
  for (const tool of definitions)
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  const conflicts = [
    ...new Set([
      ...definitions
        .filter((tool) => LEGACY_ORCHESTRATION_TOOLS.has(tool.name))
        .map((tool) => tool.name),
      ...[...counts]
        .filter(([name, count]) => ORCHESTRATION_TOOLS.has(name) && count > 1)
        .map(([name]) => name),
      ...allowed.filter(
        (name, index) =>
          !ORCHESTRATION_TOOLS.has(name) || allowed.indexOf(name) !== index,
      ),
    ]),
  ].sort();
  if (conflicts.length > 0) {
    pi.setActiveTools(
      current.filter(
        (name) =>
          !ORCHESTRATION_TOOLS.has(name) &&
          !LEGACY_ORCHESTRATION_TOOLS.has(name),
      ),
    );
    throw new Error(
      `ORCHESTRATION_TOOL_OWNERSHIP_CONFLICT:${conflicts.join(",")}`,
    );
  }
  const next = [
    ...current.filter((name) => !ORCHESTRATION_TOOLS.has(name)),
    ...allowed,
  ];
  pi.setActiveTools([...new Set(next)]);
}
function text(value: unknown, max = 4096): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error("INVALID_REQUEST");
  return value;
}
export function piHerdrSessionReference(
  context: PiContextLike,
): PiHerdrSessionReference {
  const path = context.sessionManager.getSessionFile?.();
  if (path !== undefined) {
    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      Buffer.byteLength(path, "utf8") > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(path)
    )
      throw new Error("PI_SESSION_REFERENCE_INVALID");
    return { source: "herdr:pi", agent: "pi", kind: "path", value: path };
  }
  const id = context.sessionManager.getSessionId?.();
  if (
    !id ||
    Buffer.byteLength(id, "utf8") > 256 ||
    /[\u0000-\u001f\u007f]/u.test(id)
  )
    throw new Error("PI_SESSION_REFERENCE_INVALID");
  return { source: "herdr:pi", agent: "pi", kind: "id", value: id };
}
function integer(
  value: unknown,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new Error("INVALID_REQUEST");
  return value as number;
}
interface PersistedCorrelation {
  assignmentId: string;
  taskId: string;
  runId: string;
  agentId: string;
  generation: number;
  assignmentGeneration: number;
  piSessionId: string;
  kind: "accepted" | "bound" | "settled";
  agentCycleId?: string;
  firstTurnIndex?: number;
}
function assertAnswer(
  value: unknown,
): asserts value is { optionId: string | null; text: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_REQUEST");
  const answer = value as Record<string, unknown>;
  if (
    Object.keys(answer).length !== 2 ||
    !Object.hasOwn(answer, "optionId") ||
    !Object.hasOwn(answer, "text") ||
    (answer.optionId !== null &&
      (typeof answer.optionId !== "string" ||
        answer.optionId.length === 0 ||
        Buffer.byteLength(answer.optionId, "utf8") > 32 ||
        !/^[A-Za-z0-9_-]{1,32}$/u.test(answer.optionId))) ||
    (answer.text !== null &&
      (typeof answer.text !== "string" ||
        answer.text.length === 0 ||
        Buffer.byteLength(answer.text, "utf8") > 16_384 ||
        /[\u0000-\u001f\u007f]/u.test(answer.text))) ||
    (answer.optionId === null && answer.text === null)
  )
    throw new Error("INVALID_REQUEST");
}
function readPersistedCorrelation(
  context: PiContextLike,
): PersistedCorrelation | undefined {
  const entries = context.sessionManager.getEntries?.() ?? [];
  const bounded = (value: unknown, max: number): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const source = entry as Record<string, unknown>;
    if (
      source.customType !== "pi-herdr-orchestrator-correlation" ||
      !Object.hasOwn(source, "data")
    )
      continue;
    const data = source.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const value = data as Record<string, unknown>;
    const kind = value.kind;
    const keys =
      kind === "accepted"
        ? [
            "assignmentId",
            "taskId",
            "runId",
            "agentId",
            "generation",
            "assignmentGeneration",
            "piSessionId",
            "kind",
          ]
        : [
            "assignmentId",
            "taskId",
            "runId",
            "agentId",
            "generation",
            "assignmentGeneration",
            "piSessionId",
            "kind",
            "agentCycleId",
            "firstTurnIndex",
          ];
    if (
      Object.keys(value).some((key) => !keys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(value, key)) ||
      !["accepted", "bound", "settled"].includes(kind as string) ||
      !bounded(value.assignmentId, 256) ||
      !bounded(value.taskId, 256) ||
      !bounded(value.runId, 256) ||
      !bounded(value.agentId, 256) ||
      !bounded(value.piSessionId, 256) ||
      !Number.isSafeInteger(value.generation) ||
      (value.generation as number) < 1 ||
      !Number.isSafeInteger(value.assignmentGeneration) ||
      (value.assignmentGeneration as number) < 1
    )
      continue;
    if (
      kind !== "accepted" &&
      (!bounded(value.agentCycleId, 256) ||
        !Number.isSafeInteger(value.firstTurnIndex) ||
        (value.firstTurnIndex as number) < 0 ||
        (value.firstTurnIndex as number) > 1_000_000_000)
    )
      continue;
    return value as unknown as PersistedCorrelation;
  }
  return undefined;
}
export function validateAssignment(
  value: unknown,
  state: ReturnType<PiAdapter["safeState"]>,
  expectedSession: string,
): PiAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_REQUEST");
  const source = value as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "taskId",
    "runId",
    "agentId",
    "generation",
    "assignmentGeneration",
    "piSessionId",
    "objective",
    "constraints",
    "deadline",
    "dependencyResults",
    "resultContract",
  ]);
  if (Object.keys(source).some((key) => !allowed.has(key)))
    throw new Error("INVALID_REQUEST");
  const assignment: PiAssignment = {
    id: text(source.id, 256),
    taskId: text(source.taskId, 256),
    runId: text(source.runId, 256),
    agentId: text(source.agentId, 256),
    generation: integer(source.generation),
    assignmentGeneration: integer(source.assignmentGeneration),
    piSessionId:
      source.piSessionId === undefined
        ? expectedSession
        : text(source.piSessionId, 256),
    objective: text(source.objective, 16_384),
    constraints: [],
    deadline: text(source.deadline, 128),
  };
  if (
    assignment.agentId !== state.agentId ||
    assignment.generation !== state.generation ||
    assignment.piSessionId !== expectedSession
  )
    throw new Error("PI_IDENTITY_MISMATCH");
  if (source.dependencyResults !== undefined) {
    if (
      !Array.isArray(source.dependencyResults) ||
      source.dependencyResults.length > 64
    )
      throw new Error("INVALID_REQUEST");
    for (const item of source.dependencyResults) {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item as object).some(
          (key) => !["taskId", "resultId", "status", "summary"].includes(key),
        )
      )
        throw new Error("INVALID_REQUEST");
      const projection = item as Record<string, unknown>;
      text(projection.taskId, 256);
      if (projection.resultId !== undefined) text(projection.resultId, 256);
      if (projection.status !== undefined) text(projection.status, 64);
      if (projection.summary !== undefined) text(projection.summary, 4096);
    }
  }
  if (source.resultContract !== undefined) {
    if (
      !source.resultContract ||
      typeof source.resultContract !== "object" ||
      Array.isArray(source.resultContract) ||
      Object.keys(source.resultContract as object).some(
        (key) => !["schemaVersion", "required"].includes(key),
      )
    )
      throw new Error("INVALID_REQUEST");
    const contract = source.resultContract as Record<string, unknown>;
    integer(contract.schemaVersion, 1, 100);
    if (typeof contract.required !== "boolean")
      throw new Error("INVALID_REQUEST");
  }
  if (
    !Array.isArray(source.constraints) ||
    source.constraints.length > 64 ||
    source.constraints.some(
      (item) =>
        typeof item !== "string" ||
        Buffer.byteLength(item, "utf8") > 4096 ||
        /[\u0000-\u001f\u007f]/u.test(item),
    )
  )
    throw new Error("INVALID_REQUEST");
  assignment.constraints = [...source.constraints] as string[];
  const encoded = JSON.stringify(source);
  if (Buffer.byteLength(encoded, "utf8") > 262_144)
    throw new Error("LIMIT_EXCEEDED");
  return assignment;
}
export default async function piHerdrOrchestrator(
  api: ExtensionAPI,
): Promise<void> {
  const pi = api as unknown as PiApiLike;
  const global = globalThis as Global;
  global[KEY]?.cleanup("reload");
  const runtimeCredential = global[CREDENTIAL_KEY];
  const binding: PiToolBinding = global[TOOL_KEY] ?? {
    adapter: undefined,
    client: undefined,
  };
  global[TOOL_KEY] = binding;
  let runtimeToken: string | undefined = runtimeCredential;
  let reconnectNow: () => void = () => undefined;
  let reconnectAttempts = 0;
  let stateReporter: PiStateReporter | undefined;
  let childToolsRegistered = false;
  let parentToolsRegistered = false;
  let adapter: PiAdapter | undefined;
  let client: PiBrokerClient | undefined;
  const notifiedTerminalTasks = new Set<string>();
  const handleBrokerEvent = (
    event: import("../src/pi/broker-client.js").PiBrokerEvent,
  ): void => {
    if (
      event.event !== "task.state_changed" ||
      typeof event.refs.taskId !== "string" ||
      !["succeeded", "failed", "cancelled", "timed_out", "blocked"].includes(
        String(event.data.to ?? ""),
      ) ||
      notifiedTerminalTasks.has(event.refs.taskId)
    )
      return;
    const activeClient = client;
    const activeAdapter = adapter;
    if (!activeClient?.connected || !activeAdapter) return;
    const taskId = event.refs.taskId;
    void activeClient
      .request("task.get", { taskId }, { timeoutMs: 10_000 })
      .then((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const task = value as Record<string, unknown>;
        if (task.parentAgentId !== activeAdapter.safeState().agentId) return;
        notifiedTerminalTasks.add(taskId);
        if (notifiedTerminalTasks.size > 1_024)
          notifiedTerminalTasks.delete(
            notifiedTerminalTasks.values().next().value as string,
          );
        const state = String(task.state ?? event.data.to ?? "terminal");
        const title = typeof task.title === "string" ? task.title : taskId;
        pi.sendMessage?.(
          {
            customType: "pi-herdr-task-terminal",
            content: `Managed task ${taskId} (${title}) reached ${state}. Collect its result now and continue the remaining work without waiting for a user prompt.`,
            display: true,
            details: { taskId, state },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      })
      .catch(() => undefined);
  };
  const providerCollector = new ProviderProjectionCollector(
    pi.events,
    async (projection) => {
      if (!client?.connected) throw new Error("AGENT_DISCONNECTED");
      await client.request("presentation.projection.update", { projection });
    },
  );
  let providerActions = pi.events
    ? new ProviderEventAdapters(pi.events)
    : undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let reconnectDelay = 1_000;
  const pendingClients = new Set<PiBrokerClient>();
  let heartbeat: NodeJS.Timeout | undefined;
  let startEpoch = 0;
  let pendingLifecycle: Array<{
    client: PiBrokerClient;
    adapter: PiAdapter;
    payload: Record<string, unknown>;
    settled: boolean;
  }> = [];
  let lifecycleInFlight = false;
  const managed = process.env.PI_HERDR_ORCH_MANAGED === "1";
  if (managed) {
    registerManagedChildTools(pi, binding);
    childToolsRegistered = true;
  }
  const herdrPaneActive =
    process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
  const herdrActive = herdrPaneActive && !!process.env.HERDR_SOCKET_PATH;
  const managedContext =
    herdrPaneActive &&
    !!process.env.PI_HERDR_ORCH_BROKER_SOCKET &&
    !!process.env.PI_HERDR_ORCH_SESSION_KEY;
  const adoptedContext = herdrActive;
  binding.parentAuthorized = false;
  if (!managed && adoptedContext) {
    registerParentTools(pi, binding);
    parentToolsRegistered = true;
  }
  const runtime: Runtime = {
    cleanup(reason) {
      const preserveCredential = ["reload", "new", "resume", "fork"].includes(
        reason ?? "",
      );
      startEpoch++;
      if (heartbeat) clearInterval(heartbeat);
      providerCollector.stop();
      stateReporter?.dispose();
      stateReporter = undefined;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      heartbeat = undefined;
      if (adapter) binding.correlationState = adapter.correlationState();
      binding.adapter = undefined;
      binding.client = undefined;
      binding.parentAuthorized = false;
      client?.close();
      for (const pending of pendingClients) pending.close();
      pendingClients.clear();
      client = undefined;
      adapter = undefined;
      pendingLifecycle = [];
      lifecycleInFlight = false;
      if (!preserveCredential) {
        runtimeToken = undefined;
        delete global[CREDENTIAL_KEY];
      }
    },
  };
  global[KEY] = runtime;
  const start = async (
    next: PiContextLike,
    reconnect = false,
  ): Promise<void> => {
    // Rebind event-backed provider actions for every session/reload. The Pi
    // host can replace its event bus while retaining this extension runtime.
    providerActions = pi.events
      ? new ProviderEventAdapters(pi.events)
      : undefined;
    providerCollector.start();
    if (!reconnect) {
      reconnectAttempts = 0;
      reconnectDelay = 1_000;
    }
    const epoch = ++startEpoch;
    if (adapter) binding.correlationState = adapter.correlationState();
    stateReporter?.dispose();
    stateReporter = undefined;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    client?.close();
    for (const pending of pendingClients) pending.close();
    pendingClients.clear();
    client = undefined;
    adapter = undefined;
    binding.adapter = undefined;
    binding.client = undefined;
    binding.parentAuthorized = false;
    lifecycleInFlight = false;
    if (managed ? !managedContext : !adoptedContext) {
      inactive(next);
      return;
    }
    const scheduleAttachRetry = (): void => {
      if (epoch !== startEpoch || reconnectTimer) return;
      const delay = reconnectDelay;
      reconnectAttempts++;
      reconnectDelay = Math.min(30_000, reconnectDelay * 2);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void start(next, true);
      }, delay);
      reconnectTimer.unref?.();
    };
    let socketPath: string;
    let orchestrationSessionKey: string;
    if (managed) {
      socketPath = process.env.PI_HERDR_ORCH_BROKER_SOCKET!;
      orchestrationSessionKey = process.env.PI_HERDR_ORCH_SESSION_KEY!;
    } else {
      try {
        const { paths } = await resolveHerdrPaths();
        socketPath = paths.socket;
        orchestrationSessionKey = paths.sessionKey;
      } catch (error) {
        next.ui.setStatus?.(
          "pi-herdr-orchestrator",
          error instanceof Error
            ? `Orchestrator inactive: ${error.message}`
            : "Orchestrator startup failed.",
        );
        scheduleAttachRetry();
        return;
      }
    }
    if (epoch !== startEpoch) return;
    const agentId = process.env.PI_HERDR_ORCH_AGENT_ID ?? "";
    const generation = Number(process.env.PI_HERDR_ORCH_GENERATION ?? "1");
    const candidateAdapter = new PiAdapter(pi, next, agentId, generation);
    const persisted = readPersistedCorrelation(next);
    const reconcileAssignment = (assignment: PiAssignment): void => {
      if (
        persisted &&
        persisted.assignmentId === assignment.id &&
        persisted.taskId === assignment.taskId &&
        persisted.runId === assignment.runId &&
        persisted.agentId === assignment.agentId &&
        persisted.generation === assignment.generation &&
        persisted.assignmentGeneration === assignment.assignmentGeneration &&
        persisted.piSessionId === assignment.piSessionId
      )
        candidateAdapter.restorePersisted(
          persisted.kind,
          assignment,
          persisted.agentCycleId,
          persisted.firstTurnIndex,
        );
      else if (
        binding.correlationState &&
        binding.correlationState.kind !== "none" &&
        binding.correlationState.assignment.id === assignment.id &&
        binding.correlationState.assignment.taskId === assignment.taskId &&
        binding.correlationState.assignment.runId === assignment.runId &&
        binding.correlationState.assignment.generation ===
          assignment.generation &&
        binding.correlationState.assignment.assignmentGeneration ===
          assignment.assignmentGeneration
      )
        candidateAdapter.restoreCorrelation(binding.correlationState);
    };
    let registered = false;
    let scheduleReconnect: () => void = () => undefined;
    const handleControlRequest = async (request: {
      id: string;
      method: string;
      params: Record<string, unknown>;
    }): Promise<unknown> => {
      if (!registered) throw new Error("PI_REGISTRATION_PENDING");
      return candidateAdapter.handleControl(request.method, request.params);
    };
    const handleServerRequest = async (request: {
      id: string;
      method: string;
      params: Record<string, unknown>;
    }): Promise<unknown> => {
      if (!registered) throw new Error("PI_REGISTRATION_PENDING");
      const state = candidateAdapter.safeState();
      if (request.method === "question.deliver_answer") {
        if (
          Object.keys(request.params).some(
            (key) =>
              ![
                "questionId",
                "runId",
                "toolCallId",
                "state",
                "answer",
                "expected",
              ].includes(key),
          ) ||
          !["questionId", "runId", "toolCallId", "state", "expected"].every(
            (key) => Object.hasOwn(request.params, key),
          )
        )
          throw new Error("INVALID_REQUEST");
        const questionId = text(request.params.questionId, 256);
        const runId = text(request.params.runId, 256);
        const toolCallId = text(request.params.toolCallId, 256);
        const deliveryState = request.params.state;
        if (
          deliveryState !== "answered" &&
          deliveryState !== "cancelled" &&
          deliveryState !== "timed_out"
        )
          throw new Error("INVALID_REQUEST");
        const expected = request.params.expected;
        if (
          !expected ||
          typeof expected !== "object" ||
          Array.isArray(expected)
        )
          throw new Error("INVALID_REQUEST");
        const guard = expected as Record<string, unknown>;
        if (
          Object.keys(guard).some(
            (key) =>
              ![
                "piSessionId",
                "agentId",
                "generation",
                "connectionGeneration",
                "assignmentGeneration",
                "runId",
              ].includes(key),
          ) ||
          text(guard.piSessionId, 256) !== state.sessionId ||
          text(guard.agentId, 256) !== state.agentId ||
          integer(guard.generation) !== state.generation ||
          integer(guard.connectionGeneration) !== state.connectionGeneration ||
          text(guard.runId, 256) !== runId
        )
          throw new Error("PI_IDENTITY_MISMATCH");
        const assignment = candidateAdapter.assignmentForTools();
        if (
          !assignment ||
          assignment.runId !== runId ||
          integer(guard.assignmentGeneration) !==
            assignment.assignmentGeneration
        )
          throw new Error("RUN_MISMATCH");
        if (deliveryState === "answered") {
          assertAnswer(request.params.answer);
        }
        if (
          deliveryState !== "answered" &&
          Object.hasOwn(request.params, "answer")
        )
          throw new Error("INVALID_REQUEST");
        if (
          !candidateClient.resolveQuestionDelivery(
            questionId,
            runId,
            toolCallId,
            {
              state: deliveryState,
              ...(deliveryState === "answered"
                ? { answer: request.params.answer }
                : {}),
            },
          )
        )
          throw new Error("QUESTION_DELIVERY_INVALID");
        return { accepted: true };
      }
      if (request.method === "provider.files_open") {
        if (!providerActions) throw new Error("PROVIDER_UNAVAILABLE");
        return await providerActions.filesOpen();
      }
      if (request.method === "provider.files_action") {
        if (!providerActions || typeof request.params.action !== "string")
          throw new Error("PROVIDER_UNAVAILABLE");
        const { action, expected: _expected, ...fields } = request.params;
        return await providerActions.files(
          action as import("../src/pi/provider-event-adapters.js").FilesProviderAction,
          fields as never,
        );
      }
      if (request.method === "provider.agent_board_view") {
        if (!providerActions) throw new Error("PROVIDER_UNAVAILABLE");
        const selections = request.params.selections;
        if (
          selections !== undefined &&
          (!selections ||
            typeof selections !== "object" ||
            Array.isArray(selections))
        )
          throw new Error("INVALID_REQUEST");
        return await providerActions.boardView(
          selections as Record<string, string> | undefined,
        );
      }
      if (request.method === "provider.todo_action") {
        const p = request.params;
        if (
          Object.keys(p).some(
            (key) => !["action", "taskId", "expected"].includes(key),
          ) ||
          !["start", "done", "clear_wait"].includes(p.action as string) ||
          typeof p.taskId !== "string" ||
          p.taskId.length === 0
        )
          throw new Error("INVALID_REQUEST");
        const expected = p.expected;
        if (
          !expected ||
          typeof expected !== "object" ||
          Array.isArray(expected)
        )
          throw new Error("INVALID_REQUEST");
        const guard = expected as Record<string, unknown>;
        if (
          Object.keys(guard).some(
            (key) =>
              ![
                "agentId",
                "generation",
                "connectionGeneration",
                "piSessionId",
              ].includes(key),
          ) ||
          text(guard.agentId, 256) !== state.agentId ||
          integer(guard.generation) !== state.generation ||
          text(guard.piSessionId, 256) !== state.sessionId ||
          integer(guard.connectionGeneration) !== state.connectionGeneration
        )
          throw new Error("PI_IDENTITY_MISMATCH");
        if (!providerActions) throw new Error("PROVIDER_UNAVAILABLE");
        return await providerActions.todo(
          p.action as "start" | "done" | "clear_wait",
          p.taskId,
        );
      }
      if (request.method === "provider.agent_board_action") {
        const p = request.params;
        if (!providerActions || typeof p.action !== "string")
          throw new Error("PROVIDER_UNAVAILABLE");
        const { expected: _expected, ...fields } = p;
        if (p.action === "open-ui")
          return await providerActions.agentBoardOpen(2);
        return await providerActions.agentBoardAction(p.action, fields);
      }
      if (request.method !== "assignment.deliver")
        throw new Error("PI_METHOD_UNAVAILABLE");
      if (
        Object.keys(request.params).some(
          (key) => key !== "assignment" && key !== "expected",
        )
      )
        throw new Error("INVALID_REQUEST");
      const expected = request.params.expected;
      if (!expected || typeof expected !== "object" || Array.isArray(expected))
        throw new Error("INVALID_REQUEST");
      const guard = expected as Record<string, unknown>;
      if (
        Object.keys(guard).some(
          (key) =>
            !["piSessionId", "activity", "connectionGeneration"].includes(key),
        ) ||
        text(guard.piSessionId, 256) !== state.sessionId ||
        guard.activity !== state.activity ||
        integer(guard.connectionGeneration) !== state.connectionGeneration
      )
        throw new Error("PI_IDENTITY_MISMATCH");
      const assignment = validateAssignment(
        request.params.assignment,
        state,
        state.sessionId,
      );
      reconcileAssignment(assignment);
      return { status: await candidateAdapter.deliver(assignment) };
    };
    const tokenFile = process.env.PI_HERDR_ORCH_TOKEN_FILE;
    const token = managed
      ? (runtimeToken ??
        (tokenFile
          ? await readManagedTokenFile(tokenFile).catch(() => undefined)
          : undefined))
      : undefined;
    if (epoch !== startEpoch) return;
    if (managed && !token) {
      next.ui.setStatus?.(
        "pi-herdr-orchestrator",
        "Managed token file unavailable; orchestration controls are disabled.",
      );
      return;
    }
    const secret = !managed
      ? await (async () => {
          try {
            return await readBrokerSecretFile(siblingSecretPath(socketPath));
          } catch {
            return undefined;
          }
        })()
      : undefined;
    if (epoch !== startEpoch) return;
    if (!managed && !secret) {
      next.ui.setStatus?.(
        "pi-herdr-orchestrator",
        "Broker startup is pending; orchestration controls are disabled.",
      );
      scheduleAttachRetry();
      return;
    }
    const candidateClient =
      managed && token
        ? new PiBrokerClient({
            socketPath,
            sessionKey: orchestrationSessionKey,
            piSessionId: piSessionId(next),
            agentId,
            generation,
            token,
            onServerRequest: handleServerRequest,
            onControlRequest: handleControlRequest,
            onEvent: handleBrokerEvent,
          })
        : new PiBrokerClient({
            socketPath,
            sessionKey: orchestrationSessionKey,
            piSessionId: piSessionId(next),
            secret: secret!,
            onServerRequest: handleServerRequest,
            onControlRequest: handleControlRequest,
            onEvent: handleBrokerEvent,
          });
    pendingClients.add(candidateClient);
    try {
      const connected = (await candidateClient.connect()) as {
        broker?: { lastEventSeq?: unknown };
      };
      const subscriptionCursor = Number.isSafeInteger(
        connected.broker?.lastEventSeq,
      )
        ? (connected.broker?.lastEventSeq as number)
        : 0;
      if (epoch !== startEpoch) {
        pendingClients.delete(candidateClient);
        candidateClient.close();
        return;
      }
      const registration = await candidateClient.register(
        candidateAdapter.safeState(),
        piHerdrSessionReference(next),
      );
      if (epoch !== startEpoch) {
        pendingClients.delete(candidateClient);
        candidateClient.close();
        return;
      }
      pendingClients.delete(candidateClient);
      candidateAdapter.bindIdentity(
        registration.agentId,
        registration.generation,
        registration.connectionGeneration,
      );
      if (registration.assignment !== undefined) {
        try {
          const recoveredAssignment = validateAssignment(
            registration.assignment,
            candidateAdapter.safeState(),
            candidateAdapter.safeState().sessionId,
          );
          reconcileAssignment(recoveredAssignment);
          if (candidateAdapter.correlator.state.kind === "none")
            candidateAdapter.restoreAssignment(recoveredAssignment);
        } catch {
          candidateAdapter.correlator.cancel();
        }
      }
      pendingLifecycle = [];
      const recoveredPayload = candidateAdapter.recoveryLifecyclePayload(
        candidateClient.nextAdapterSeq(),
      );
      if (recoveredPayload)
        pendingLifecycle.push({
          client: candidateClient,
          adapter: candidateAdapter,
          payload: recoveredPayload,
          settled: candidateAdapter.correlator.state.kind === "settled",
        });
      lifecycleInFlight = false;
      if (managed && token) {
        runtimeToken = token;
        global[CREDENTIAL_KEY] = token;
      }
      registered = true;
      reconnectDelay = 1_000;
      reconnectAttempts = 0;
      adapter = candidateAdapter;
      client = candidateClient;
      binding.adapter = candidateAdapter;
      binding.client = candidateClient;
      if (managed && !childToolsRegistered) {
        registerManagedChildTools(pi, binding);
        childToolsRegistered = true;
      }
      const parentAuthorized =
        registration.permissions.includes("delegate") ||
        registration.permissions.includes("manage:all");
      binding.parentAuthorized = parentAuthorized;
      if (parentAuthorized && !parentToolsRegistered) {
        registerParentTools(pi, binding);
        parentToolsRegistered = true;
      }
      reconcileActiveTools(pi, [
        ...(managed ? ["orchestrator_result", "orchestrator_ask"] : []),
        ...(parentAuthorized ? PARENT_TOOL_NAMES : []),
      ]);
      candidateClient.markRegistrationReady();
      if (parentAuthorized)
        await candidateClient.request(
          "events.subscribe",
          {
            fromSeq: subscriptionCursor,
            filters: { events: ["task.state_changed"] },
            includeSnapshot: false,
          },
          { timeoutMs: 10_000 },
        );
      providerCollector.bind(
        registration.agentId,
        candidateAdapter.safeState().sessionId,
      );
      providerCollector.request();
      scheduleReconnect = scheduleAttachRetry;
      reconnectNow = scheduleReconnect;
      stateReporter = createStateReporter(
        { heartbeat: (state) => candidateClient.heartbeat(state) },
        {
          heartbeatMs: registration.heartbeatMs,
          // A semantic heartbeat rejection does not mean the socket is gone.
          // Re-registering a healthy adapter creates a reconnect loop and makes
          // provider actions target an identity that changes every second.
          onError: () => {
            if (!candidateClient.connected) scheduleReconnect();
          },
        },
      );
      const flushLifecycle = () => {
        const pending = pendingLifecycle[0];
        if (
          !pending ||
          lifecycleInFlight ||
          pending.client !== candidateClient ||
          !candidateClient.connected
        )
          return;
        lifecycleInFlight = true;
        void candidateClient
          .request("agent.lifecycle_event", pending.payload, {
            timeoutMs: 30_000,
          })
          .then(() => {
            if (pendingLifecycle[0] === pending) {
              pendingLifecycle.shift();
              if (pending.settled) pending.adapter.clearSettledCycle();
            }
          })
          .catch(() => {
            // A recovered lifecycle frame can become stale after reload. Drop
            // that frame while the registered socket is still healthy instead
            // of replacing the adapter forever.
            if (candidateClient.connected) {
              if (pendingLifecycle[0] === pending) pendingLifecycle.shift();
            } else scheduleReconnect();
          })
          .finally(() => {
            lifecycleInFlight = false;
          });
      };
      heartbeat = setInterval(
        () => {
          if (client === candidateClient && candidateClient.connected) {
            flushLifecycle();
            // Provider event listeners publish changes. Re-publishing the same
            // projection on every heartbeat redraws the whole Pi Herd pane.
            stateReporter?.report(candidateAdapter.safeState());
          } else if (client === candidateClient) scheduleReconnect();
        },
        Math.min(registration.heartbeatMs, 5_000),
      );
      heartbeat.unref();
      next.ui.setStatus?.(
        "pi-herdr-orchestrator",
        managed ? "Managed Pi connected" : "Adopted Pi connected",
      );
    } catch {
      pendingClients.delete(candidateClient);
      candidateClient.close();
      if (epoch === startEpoch) {
        next.ui.setStatus?.(
          "pi-herdr-orchestrator",
          "Broker unavailable; orchestration controls are disabled.",
        );
        const delay = reconnectDelay;
        reconnectAttempts++;
        reconnectDelay = Math.min(30_000, reconnectDelay * 2);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          void start(next, true);
        }, delay);
        reconnectTimer.unref?.();
      }
    }
  };
  const openAgentBoard = async (_args: string, raw: unknown): Promise<void> => {
    const context = raw as PiContextLike;
    try {
      context.ui.notify?.(await openPiHerd(), "info");
    } catch (error) {
      context.ui.notify?.(
        error instanceof Error ? error.message : String(error),
        "warning",
      );
    }
  };
  api.registerCommand("agent-board", {
    description: "Open and focus Agent Board beside this Pi pane",
    handler: openAgentBoard,
  });
  api.registerCommand("agent-settings", {
    description: "Choose agent models and per-model thinking levels",
    handler: async (_args, next) => {
      const context = next as PiContextLike;
      await start(context);
      await openAgentSettings(client, context);
    },
  });
  api.registerCommand("pi-herd", {
    description: "Open Agent Board (Pi Herd compatibility alias)",
    handler: openAgentBoard,
  });
  api.registerCommand("orchestrator-status", {
    description: "Show Pi Herd Orchestrator status",
    handler: async (_args, next) => {
      await start(next as PiContextLike);
      providerCollector.request();
      (next as PiContextLike).ui.notify?.(
        client?.connected
          ? "Pi Herd Orchestrator connected."
          : "Pi Herd Orchestrator disconnected.",
        client?.connected ? "info" : "warning",
      );
    },
  });
  api.on("session_start", (_event, next) => {
    if (managed)
      reconcileActiveTools(pi, ["orchestrator_result", "orchestrator_ask"]);
    void start(next as PiContextLike);
  });
  api.on("session_shutdown", (event) =>
    runtime.cleanup(
      event && typeof event === "object" && "reason" in event
        ? String((event as { reason?: unknown }).reason)
        : "quit",
    ),
  );
  for (const type of [
    "before_agent_start",
    "agent_start",
    "turn_start",
    "turn_end",
    "agent_end",
    "agent_settled",
    "session_compact",
    "tool_execution_start",
    "tool_execution_end",
  ] as const)
    api.on(type, (_event, raw) => {
      const current = adapter;
      const currentClient = client;
      if (!current) return;
      const next = raw as PiContextLike;
      current.updateContext(next);
      const safe = current.safeState();
      const incoming = (
        _event && typeof _event === "object" ? _event : {}
      ) as Record<string, unknown>;
      const lifecycle: PiLifecycleEvent = {
        type,
        agentId: safe.agentId,
        generation: safe.generation,
        piSessionId: safe.sessionId,
        ...(safe.connectionGeneration !== undefined
          ? { connectionGeneration: safe.connectionGeneration }
          : {}),
        ...(Number.isSafeInteger(incoming.turnIndex)
          ? { turnIndex: incoming.turnIndex as number }
          : {}),
        ...(typeof incoming.agentCycleId === "string" &&
        incoming.agentCycleId.length <= 256
          ? { agentCycleId: incoming.agentCycleId }
          : {}),
      };
      const result = current.onLifecycle(lifecycle);
      if (currentClient && (result === "bound" || result === "settled")) {
        const payload = current.lifecyclePayload(
          result,
          lifecycle,
          currentClient.nextAdapterSeq(),
        );
        if (
          payload &&
          !pendingLifecycle.some(
            (item) => JSON.stringify(item.payload) === JSON.stringify(payload),
          )
        ) {
          if (pendingLifecycle.length < 8)
            pendingLifecycle.push({
              client: currentClient,
              adapter: current,
              payload,
              settled: result === "settled",
            });
        }
      }
      if (
        currentClient?.connected &&
        pendingLifecycle.length > 0 &&
        !lifecycleInFlight &&
        pendingLifecycle[0]?.client === currentClient
      ) {
        const pending = pendingLifecycle[0];
        lifecycleInFlight = true;
        void currentClient
          .request("agent.lifecycle_event", pending.payload, {
            timeoutMs: 30_000,
          })
          .then(() => {
            if (pendingLifecycle[0] === pending) {
              pendingLifecycle.shift();
              if (pending.settled) current.clearSettledCycle();
            }
          })
          .catch(() => {
            reconnectNow();
          })
          .finally(() => {
            lifecycleInFlight = false;
          });
      }
      if (
        currentClient?.connected &&
        !["tool_execution_start", "tool_execution_end"].includes(type)
      )
        stateReporter?.report(safe);
    });
}
