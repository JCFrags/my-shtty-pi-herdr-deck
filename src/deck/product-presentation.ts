import type { Agent, Task, TaskState } from "../state/types.js";
import type {
  AgentBoardPendingQuestion,
  AgentBoardProjection,
  ProviderProjection,
  TodoProjectionItem,
} from "../shared/provider-projections.js";
import type {
  DeckGroup,
  DeckNotification,
  DeckQuestion,
  DeckResult,
  DeckState,
} from "./types.js";
import {
  boardRecord,
  selectBoardPresentation,
  type BoardRecord,
} from "./board-presentation.js";
import { selectAdoptedScope, currentProviderProjection } from "./scope.js";

export type AgentBoardTab = "board" | "files" | "agents" | "activity";
export type BoardSection = "attention" | "work" | "recent-signals";
export type BoardFilter = "attention" | "active" | "all-current";
export type ActivityFilter =
  "all" | "results" | "signals" | "agents" | "errors";
export type SourceLabel = "TODO" | "ORCHESTRATOR" | "SIGNALS";
export type BoardAction =
  | "start"
  | "mark-done"
  | "clear-wait"
  | "cancel-task"
  | "focus-agent"
  | "open-agents"
  | "wait"
  | "stop"
  | "close"
  | "answer"
  | "use-recommendation"
  | "dismiss-question"
  | "retry-delivery"
  | "archive-update"
  | "focus"
  | "prompt"
  | "copy-id"
  | "archive"
  | "retry";

export interface ItemActionAvailability {
  primary?: BoardAction;
  actions: readonly BoardAction[];
  disabledReason?: string;
}

interface BoardItemBase<K extends string, S> {
  uiId: string;
  /** Compatibility alias for the canonical UI ID. */
  id: string;
  entityId: string;
  kind: K;
  source: S;
  sourceLabel: SourceLabel;
  title: string;
  summary: string;
  state: string;
  /** Compatibility alias for state. */
  status: string;
  section: BoardSection;
  priority: number;
  sortTimestamp: string;
  ownerAgentId?: string;
  relatedTaskId?: string;
  relatedRunId?: string;
  relatedGroupId?: string;
  revision?: number;
  pendingQuestion?: AgentBoardPendingQuestion;
  actions: ItemActionAvailability;
}

export type BoardItem =
  | BoardItemBase<"todo", TodoProjectionItem>
  | BoardItemBase<"task", Task>
  | BoardItemBase<"group", DeckGroup>
  | BoardItemBase<"broker-question", DeckQuestion>
  | BoardItemBase<"signal-question", BoardRecord>
  | BoardItemBase<"signal-update", BoardRecord>
  | BoardItemBase<"agent-alert", Agent>;

export interface NormalizedQuestion {
  source: "orchestrator" | "signals";
  uiId: string;
  entityId: string;
  revision?: number;
  prompt: string;
  responseKind:
    "single" | "multiple" | "text" | "single_or_text" | "multiple_or_text";
  options: readonly { id: string; label: string; description?: string }[];
  allowFreeform: boolean;
  recommendedOptionIds: readonly string[];
  recommendedText?: string;
  dismissible: boolean;
  retryableDelivery: boolean;
  answerId?: string;
  deliveryState?: string;
  terminal: boolean;
  timeoutAt?: string;
}

export interface UnifiedBoardPresentation {
  provider?: ProviderProjection;
  attention: BoardItem[];
  work: BoardItem[];
  recentSignals: BoardItem[];
  visible: BoardItem[];
  selected?: BoardItem;
  counts: { attention: number; work: number; recentSignals: number };
  filter: BoardFilter;
}

interface ActivityItemBase<K extends string, S> {
  uiId: string;
  id: string;
  entityId: string;
  kind: K;
  title: string;
  summary: string;
  state: string;
  status: string;
  sortTimestamp: string;
  source: S;
  revision?: number;
  actions: ItemActionAvailability;
}
export type ActivityItem =
  | ActivityItemBase<"result", DeckResult>
  | ActivityItemBase<"terminal-task", Task>
  | ActivityItemBase<"terminal-group", DeckGroup>
  | ActivityItemBase<"terminal-agent", Agent>
  | ActivityItemBase<
      | "signal-update"
      | "signal-decision"
      | "signal-history"
      | "system-error"
      | "system-recovery",
      BoardRecord
    >;

export interface ActivityPresentation {
  items: ActivityItem[];
  selected?: ActivityItem;
  counts: Record<ActivityFilter, number>;
  filter: ActivityFilter;
}

const TASK_TERMINAL = new Set<TaskState>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);
const AGENT_TERMINAL = new Set(["stopped", "failed", "orphaned", "replaced"]);
const GROUP_TERMINAL = new Set([
  "completed",
  "succeeded",
  "failed",
  "cancelled",
  "closed",
  "stopped",
]);
const TERMINAL_TODO = new Set([
  "done",
  "completed",
  "complete",
  "cancelled",
  "canceled",
  "closed",
]);
const WAITING_TODO = new Set(["waiting", "blocked", "paused"]);
const SOURCE_PRIORITY: Record<SourceLabel, number> = {
  ORCHESTRATOR: 0,
  SIGNALS: 1,
  TODO: 2,
};

function text(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .trim()
    .slice(0, 4_000);
  return sanitized.length > 0 ? sanitized : fallback;
}
function rowId(row: BoardRecord, index: number): string {
  return text(row.id ?? row.entityId, `row-${index + 1}`);
}
function rowTitle(row: BoardRecord, id: string): string {
  return text(row.title ?? row.question ?? row.detail, id);
}
function rowTimestamp(row: BoardRecord): string {
  return text(
    row.changedAt ?? row.terminalAt ?? row.updatedAt ?? row.createdAt,
    "",
  );
}
function hasAnswerId(row: BoardRecord): boolean {
  const answer =
    row.answer && typeof row.answer === "object" && !Array.isArray(row.answer)
      ? (row.answer as BoardRecord)
      : {};
  return (
    typeof (row.answerId ?? answer.id ?? answer.answerId) === "string" &&
    String(row.answerId ?? answer.id ?? answer.answerId).length > 0
  );
}
function isTerminalSignalRow(row: BoardRecord): boolean {
  return new Set([
    "completed",
    "failed",
    "cancelled",
    "canceled",
    "archived",
    "dismissed",
    "applied",
    "rejected",
  ]).has(
    text(row.state ?? row.status ?? row.statusLabel, "")
      .trim()
      .toLowerCase(),
  );
}
function normalizedStatus(value: string | undefined): string {
  return (value ?? "open")
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, " ");
}
export function isTerminalTaskState(state: TaskState): boolean {
  return TASK_TERMINAL.has(state);
}
export function isTerminalAgentState(state: Agent["state"]): boolean {
  return AGENT_TERMINAL.has(state);
}
export function isTerminalTodoStatus(status: string | undefined): boolean {
  return TERMINAL_TODO.has(normalizedStatus(status));
}
export function isWaitingTodo(item: TodoProjectionItem): boolean {
  return (
    Boolean(item.waitReason) || WAITING_TODO.has(normalizedStatus(item.status))
  );
}

function boardSort(left: BoardItem, right: BoardItem): number {
  return (
    left.section.localeCompare(right.section) ||
    left.priority - right.priority ||
    SOURCE_PRIORITY[left.sourceLabel] - SOURCE_PRIORITY[right.sourceLabel] ||
    (right.sortTimestamp ?? "").localeCompare(left.sortTimestamp ?? "") ||
    left.uiId.localeCompare(right.uiId)
  );
}
function activitySort(left: ActivityItem, right: ActivityItem): number {
  return (
    (right.sortTimestamp ?? "").localeCompare(left.sortTimestamp ?? "") ||
    left.uiId.localeCompare(right.uiId)
  );
}
function boardItem<K extends BoardItem["kind"], S>(
  input: Omit<BoardItemBase<K, S>, "id" | "status">,
): BoardItemBase<K, S> {
  return { ...input, id: input.uiId, status: input.state };
}
function activityItem<K extends ActivityItem["kind"], S>(
  input: Omit<ActivityItemBase<K, S>, "id" | "status">,
): ActivityItemBase<K, S> {
  return { ...input, id: input.uiId, status: input.state };
}
function signals(
  projection: AgentBoardProjection | undefined,
  tab: "inbox" | "updates" | "decisions" | "history",
): BoardRecord[] {
  return selectBoardPresentation(projection, tab).rows;
}

export function normalizeBrokerQuestion(
  question: DeckQuestion,
): NormalizedQuestion {
  const options = question.options ?? [];
  return {
    source: "orchestrator",
    uiId: `orchestrator:question:${question.id}`,
    entityId: question.id,
    prompt: text(question.prompt, question.id),
    responseKind:
      options.length > 0
        ? question.allowFreeform
          ? "single_or_text"
          : "single"
        : "text",
    options,
    allowFreeform: question.allowFreeform === true || options.length === 0,
    recommendedOptionIds: [],
    dismissible: false,
    retryableDelivery: false,
    terminal:
      question.answered === true ||
      question.state === "answered" ||
      question.state === "cancelled" ||
      question.state === "timed_out",
    ...(question.timeoutAt ? { timeoutAt: question.timeoutAt } : {}),
  };
}
export function normalizeSignalsQuestion(
  question: AgentBoardPendingQuestion,
  row: BoardRecord = {},
): NormalizedQuestion {
  const projection = boardRecord(row.projection);
  const answer = boardRecord(projection.answer ?? row.answer);
  const answerId = text(answer.id ?? answer.answerId ?? row.answerId, "");
  const userAnswerable = projection.userAnswerable ?? row.userAnswerable;
  const retryableDelivery =
    projection.retryableDelivery ?? row.retryableDelivery;
  return {
    source: "signals",
    uiId: `signals:question:${question.questionId}`,
    entityId: question.questionId,
    revision: question.revision,
    prompt: question.question,
    responseKind: question.response.kind,
    options: question.response.options,
    allowFreeform: question.response.kind.includes("text"),
    recommendedOptionIds: question.recommendedOptionIds,
    ...(question.recommendedText
      ? { recommendedText: question.recommendedText }
      : {}),
    dismissible: (projection.dismissible ?? row.dismissible) === true,
    retryableDelivery: retryableDelivery === true,
    ...(answerId ? { answerId } : {}),
    deliveryState: text(
      projection.deliveryState ??
        projection.latestDeliveryAttempt ??
        row.deliveryState ??
        row.state,
      "pending",
    ),
    terminal: userAnswerable === false && retryableDelivery !== true,
  };
}

export function selectUnifiedBoardPresentation(
  state: DeckState,
  targetPaneId?: string,
  selectedId?: string,
  filter: BoardFilter = "all-current",
): UnifiedBoardPresentation {
  const provider = currentProviderProjection(state, targetPaneId);
  const scoped = selectAdoptedScope(state, targetPaneId).state;
  const items: BoardItem[] = [];
  for (const todo of provider?.todo.items ?? []) {
    if (isTerminalTodoStatus(todo.status)) continue;
    const waiting = isWaitingTodo(todo);
    const status = normalizedStatus(todo.status);
    items.push(
      boardItem({
        uiId: `todo:${todo.id}`,
        entityId: todo.id,
        kind: "todo",
        source: todo,
        sourceLabel: "TODO",
        title: todo.text,
        summary: todo.waitReason ?? status,
        state: status,
        section: waiting ? "attention" : "work",
        priority: waiting ? 20 : 60,
        sortTimestamp: "",
        actions: {
          primary: waiting ? "clear-wait" : "start",
          actions: waiting ? ["clear-wait"] : ["start", "mark-done"],
        },
      }),
    );
  }
  const openQuestions = [...scoped.questions.values()].filter(
    (q) => !normalizeBrokerQuestion(q).terminal,
  );
  const representedTasks = new Set<string>();
  const representedRuns = new Set<string>();
  const representedQuestions = new Set(openQuestions.map((q) => q.id));
  for (const question of openQuestions) {
    if (question.taskId) representedTasks.add(question.taskId);
    if (question.runId) {
      representedRuns.add(question.runId);
      const run = scoped.runs.get(question.runId);
      if (run?.taskId) representedTasks.add(run.taskId);
    }
  }
  const representedGroups = new Set<string>();
  for (const group of scoped.groups.values()) {
    if (
      group.questionIds?.some((id) => representedQuestions.has(id)) ||
      group.taskIds?.some((id) => representedTasks.has(id)) ||
      group.runIds?.some((id) => representedRuns.has(id))
    )
      representedGroups.add(group.id);
  }
  for (const question of openQuestions)
    items.push(
      boardItem({
        uiId: `orchestrator:question:${question.id}`,
        entityId: question.id,
        kind: "broker-question",
        source: question,
        sourceLabel: "ORCHESTRATOR",
        title: question.prompt,
        summary: "Answer required",
        state: "open",
        section: "attention",
        priority: 0,
        sortTimestamp: "",
        ...(question.agentId ? { ownerAgentId: question.agentId } : {}),
        ...(question.taskId ? { relatedTaskId: question.taskId } : {}),
        ...(question.runId ? { relatedRunId: question.runId } : {}),
        actions: { primary: "answer", actions: ["answer"] },
      }),
    );
  for (const task of scoped.tasks.values()) {
    if (
      isTerminalTaskState(task.state) ||
      representedTasks.has(task.id) ||
      (task.currentRunId !== undefined &&
        representedRuns.has(task.currentRunId)) ||
      task.runIds?.some((runId) => representedRuns.has(runId))
    )
      continue;
    const attention = task.state === "blocked";
    const assigned = task.assignedAgentId
      ? scoped.agents.get(task.assignedAgentId)
      : undefined;
    const assignedAgentLive =
      assigned !== undefined && !isTerminalAgentState(assigned.state);
    items.push(
      boardItem({
        uiId: `orchestrator:task:${task.id}`,
        entityId: task.id,
        kind: "task",
        source: task,
        sourceLabel: "ORCHESTRATOR",
        title: text(task.title ?? task.objective, task.id),
        summary: task.objective,
        state: task.state,
        section: attention ? "attention" : "work",
        priority: attention ? 10 : 40,
        sortTimestamp: task.createdAt,
        ...(task.assignedAgentId ? { ownerAgentId: task.assignedAgentId } : {}),
        relatedTaskId: task.id,
        ...(task.currentRunId ? { relatedRunId: task.currentRunId } : {}),
        actions: {
          primary: "cancel-task",
          actions: [
            "cancel-task",
            ...(assignedAgentLive ? ["focus-agent" as const] : []),
            "open-agents",
          ],
        },
      }),
    );
  }
  for (const group of scoped.groups.values()) {
    if (
      GROUP_TERMINAL.has(group.state) ||
      representedGroups.has(group.id) ||
      group.taskIds?.some((taskId) => representedTasks.has(taskId)) ||
      group.runIds?.some((runId) => representedRuns.has(runId))
    )
      continue;
    const attention = group.state === "blocked" || Boolean(group.blockedReason);
    items.push(
      boardItem({
        uiId: `orchestrator:group:${group.id}`,
        entityId: group.id,
        kind: "group",
        source: group,
        sourceLabel: "ORCHESTRATOR",
        title: text(group.title ?? group.name, group.id),
        summary: group.blockedReason ?? group.objective ?? group.state,
        state: group.state,
        section: attention ? "attention" : "work",
        priority: attention ? 15 : 50,
        sortTimestamp: "",
        relatedGroupId: group.id,
        actions: { primary: "wait", actions: ["wait", "stop", "close"] },
      }),
    );
  }
  const signalInbox = selectBoardPresentation(provider?.agentBoard, "inbox");
  for (const [index, row] of signalInbox.rows.entries()) {
    const id = rowId(row, index);
    const pending = provider?.agentBoard.pendingQuestions?.find(
      (q) => q.questionId === id,
    );
    if (row.userAnswerable === false && row.retryableDelivery !== true)
      continue;
    items.push(
      boardItem({
        uiId: `signals:question:${id}`,
        entityId: id,
        kind: "signal-question",
        source: row,
        sourceLabel: "SIGNALS",
        title: rowTitle(row, id),
        summary: text(row.detail ?? row.statusLabel, "Answer required"),
        state: text(row.state ?? row.deliveryState, "pending"),
        section: "attention",
        priority: row.retryableDelivery === true ? 5 : 1,
        sortTimestamp: rowTimestamp(row),
        revision: Number(row.revision ?? pending?.revision ?? 0),
        ...(pending ? { pendingQuestion: pending } : {}),
        actions: {
          primary: "answer",
          actions: [
            "answer",
            ...(pending?.recommendedOptionIds.length || pending?.recommendedText
              ? ["use-recommendation"]
              : []),
            ...(row.dismissible === true ? ["dismiss-question"] : []),
            ...(row.retryableDelivery === true && hasAnswerId(row)
              ? ["retry-delivery"]
              : []),
          ] as BoardAction[],
        },
      }),
    );
  }
  const signalIds = new Set(
    items.filter((i) => i.kind === "signal-question").map((i) => i.entityId),
  );
  for (const [index, row] of signals(
    provider?.agentBoard,
    "updates",
  ).entries()) {
    const id = rowId(row, index);
    if (signalIds.has(id)) continue;
    if (isTerminalSignalRow(row) && row.retryableDelivery !== true) continue;
    items.push(
      boardItem({
        uiId: `signals:update:${id}`,
        entityId: id,
        kind: "signal-update",
        source: row,
        sourceLabel: "SIGNALS",
        title: rowTitle(row, id),
        summary: text(row.detail ?? row.stage, "Recent update"),
        state: text(row.state ?? row.kind, "active"),
        section: "recent-signals",
        priority: 70,
        sortTimestamp: rowTimestamp(row),
        revision: Number(row.revision ?? 0),
        actions: {
          actions: [
            ...(row.archivable === true ? ["archive-update"] : []),
            ...(row.retryableDelivery === true && hasAnswerId(row)
              ? ["retry-delivery"]
              : []),
          ] as BoardAction[],
        },
      }),
    );
  }
  const representedAgents = new Set(
    items.flatMap((i) => (i.ownerAgentId ? [i.ownerAgentId] : [])),
  );
  for (const agent of scoped.agents.values())
    if (agent.state === "blocked" && !representedAgents.has(agent.id))
      items.push(
        boardItem({
          uiId: `orchestrator:agent-alert:${agent.id}`,
          entityId: agent.id,
          kind: "agent-alert",
          source: agent,
          sourceLabel: "ORCHESTRATOR",
          title: text(agent.displayName ?? agent.herdrName, agent.id),
          summary: "Agent is blocked",
          state: agent.state,
          section: "attention",
          priority: 30,
          sortTimestamp: "",
          ownerAgentId: agent.id,
          actions: {
            primary: "focus",
            actions: ["focus", "prompt", "open-agents"],
          },
        }),
      );
  const providerWaitReasons = [
    ...(provider?.todo.waitReason ? [provider.todo.waitReason] : []),
    ...(provider?.todo.externalWaits ?? []),
  ];
  const seenProviderWaits = new Set<string>();
  for (const [index, reason] of providerWaitReasons.entries()) {
    if (seenProviderWaits.has(reason)) continue;
    seenProviderWaits.add(reason);
    items.push(
      boardItem({
        uiId:
          index === 0
            ? "todo:provider-wait"
            : `todo:provider-wait:${index + 1}`,
        entityId: index === 0 ? "provider-wait" : `provider-wait:${index + 1}`,
        kind: "todo",
        source: {
          id: index === 0 ? "provider-wait" : `provider-wait:${index + 1}`,
          text: "Todo provider wait",
          waitReason: reason,
        },
        sourceLabel: "TODO",
        title: "Todo provider wait",
        summary: reason,
        state: "waiting",
        section: "attention",
        priority: 25,
        sortTimestamp: "",
        actions: { actions: [] },
      }),
    );
  }
  const attention = items
    .filter((i) => i.section === "attention")
    .sort(boardSort);
  const work = items.filter((i) => i.section === "work").sort(boardSort);
  const recentSignals = items
    .filter((i) => i.section === "recent-signals")
    .sort(boardSort);
  const visible =
    filter === "attention"
      ? attention
      : filter === "active"
        ? [...work, ...recentSignals]
        : [...attention, ...work, ...recentSignals];
  const selected =
    visible.find((item) => item.uiId === selectedId) ?? visible[0];
  return {
    ...(provider ? { provider } : {}),
    attention,
    work,
    recentSignals,
    visible,
    ...(selected ? { selected } : {}),
    counts: {
      attention: attention.length,
      work: work.length,
      recentSignals: recentSignals.length,
    },
    filter,
  };
}

const TERMINAL_SIGNAL_STATES = new Set([
  "applied",
  "answered",
  "cancelled",
  "closed",
  "complete",
  "completed",
  "done",
  "failed",
  "rejected",
  "resolved",
  "succeeded",
  "timed_out",
  "timed out",
]);

function isTerminalSignalRecord(row: BoardRecord): boolean {
  if (typeof row.terminalAt === "string" && row.terminalAt.length > 0)
    return true;
  const state = String(row.status ?? row.statusLabel ?? row.state ?? "")
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, " ");
  return TERMINAL_SIGNAL_STATES.has(state);
}

function signalDetailsById(
  projection: AgentBoardProjection | undefined,
  tab: "updates" | "decisions" | "history",
): Record<string, BoardRecord> {
  const outer = boardRecord(projection?.view);
  const model = boardRecord(outer.view ?? outer);
  const currentTab = boardRecord(boardRecord(model.tabs)[tab]);
  const details = boardRecord(currentTab.detailsById);
  return Object.fromEntries(
    Object.entries(details).map(([id, value]) => [id, boardRecord(value)]),
  );
}

function signalActivity(
  projection: AgentBoardProjection | undefined,
  tab: "updates" | "decisions" | "history",
): ActivityItem[] {
  const kind =
    tab === "updates"
      ? "signal-update"
      : tab === "decisions"
        ? "signal-decision"
        : "signal-history";
  const detailsById = signalDetailsById(projection, tab);
  return signals(projection, tab).flatMap((row, index) => {
    const id = rowId(row, index);
    // Updates are live provider state, not history. Decisions and history are
    // also admitted only when their provider record is terminal.
    const detail = detailsById[id] ?? {};
    const source = { ...row, ...detail };
    if (!isTerminalSignalRecord(source)) return [];
    return [
      activityItem({
        uiId: `signals:${tab}:${id}`,
        entityId: id,
        kind,
        title: rowTitle(source, id),
        summary: text(source.detail ?? source.outcome ?? source.answer, id),
        state: text(source.statusLabel ?? source.state ?? source.kind, tab),
        sortTimestamp: rowTimestamp(source),
        source,
        ...(Number.isSafeInteger(source.revision)
          ? { revision: Number(source.revision) }
          : {}),
        actions: {
          actions: [
            ...(source.archivable === true ? ["archive-update"] : []),
            ...(source.retryableDelivery === true && hasAnswerId(source)
              ? ["retry-delivery"]
              : []),
          ] as BoardAction[],
        },
      }),
    ];
  });
}

export function selectActivityPresentation(
  state: DeckState,
  targetPaneId?: string,
  selectedId?: string,
  filter: ActivityFilter = "all",
  notifications: readonly DeckNotification[] = [],
): ActivityPresentation {
  const provider = currentProviderProjection(state, targetPaneId);
  const scoped = selectAdoptedScope(state, targetPaneId).state;
  const representedTasks = new Set<string>();
  const items: ActivityItem[] = [];
  for (const result of scoped.results.values()) {
    if (result.taskId) representedTasks.add(result.taskId);
    const task = result.taskId ? scoped.tasks.get(result.taskId) : undefined;
    if (task?.id) representedTasks.add(task.id);
    items.push(
      activityItem({
        uiId: `orchestrator:result:${result.id}`,
        entityId: result.id,
        kind: "result",
        title: text(result.summary, result.id),
        summary: text(result.summary, result.status),
        state: result.status,
        sortTimestamp: task?.resultCollectedAt ?? task?.createdAt ?? "",
        source: result,
        actions: { actions: ["copy-id"] },
      }),
    );
  }
  for (const task of scoped.tasks.values())
    if (
      isTerminalTaskState(task.state) &&
      !representedTasks.has(task.id) &&
      ![...scoped.results.values()].some(
        (r) =>
          r.runId &&
          (r.runId === task.currentRunId || task.runIds?.includes(r.runId)),
      )
    )
      items.push(
        activityItem({
          uiId: `orchestrator:task:${task.id}`,
          entityId: task.id,
          kind: "terminal-task",
          title: text(task.title ?? task.objective, task.id),
          summary: task.terminalReason?.message ?? task.objective,
          state: task.state,
          sortTimestamp: task.resultCollectedAt ?? task.createdAt,
          source: task,
          actions: { actions: ["copy-id"] },
        }),
      );
  for (const group of scoped.groups.values())
    if (GROUP_TERMINAL.has(group.state))
      items.push(
        activityItem({
          uiId: `orchestrator:group:${group.id}`,
          entityId: group.id,
          kind: "terminal-group",
          title: text(group.title ?? group.name, group.id),
          summary: group.blockedReason ?? group.objective ?? group.state,
          state: group.state,
          sortTimestamp: "",
          source: group,
          actions: { actions: ["copy-id"] },
        }),
      );
  for (const agent of scoped.agents.values())
    if (isTerminalAgentState(agent.state))
      items.push(
        activityItem({
          uiId: `orchestrator:agent:${agent.id}`,
          entityId: agent.id,
          kind: "terminal-agent",
          title: text(agent.displayName ?? agent.herdrName, agent.id),
          summary: agent.closeReason ?? agent.state,
          state: agent.state,
          sortTimestamp: "",
          source: agent,
          actions: {
            actions: [
              "copy-id",
              ...(agent.paneId ? ["focus"] : []),
            ] as BoardAction[],
          },
        }),
      );
  const signalByEntity = new Map<string, ActivityItem>();
  for (const item of [
    ...signalActivity(provider?.agentBoard, "updates"),
    ...signalActivity(provider?.agentBoard, "decisions"),
    ...signalActivity(provider?.agentBoard, "history"),
  ]) {
    const existing = signalByEntity.get(item.entityId);
    const rank = (value: ActivityItem) =>
      value.kind === "signal-history"
        ? 3
        : value.kind === "signal-decision"
          ? 2
          : 1;
    if (!existing || rank(item) > rank(existing))
      signalByEntity.set(item.entityId, item);
  }
  items.push(...signalByEntity.values());
  for (const notification of notifications.slice(-100)) {
    if (
      !["failure", "timeout", "budget", "recovery"].includes(notification.kind)
    )
      continue;
    const recovery = notification.kind === "recovery";
    items.push(
      activityItem({
        uiId: `system:${notification.id}`,
        entityId: notification.id,
        kind: recovery ? "system-recovery" : "system-error",
        title: recovery ? "System recovery" : `System ${notification.kind}`,
        summary: notification.text,
        state: notification.kind,
        sortTimestamp: String(notification.seq).padStart(16, "0"),
        source: {
          id: notification.id,
          title: notification.text,
          state: notification.kind,
          sequence: notification.seq,
        },
        actions: { actions: ["copy-id"] },
      }),
    );
  }
  const include = (item: ActivityItem): boolean =>
    filter === "all" ||
    (filter === "results" &&
      ["result", "terminal-task", "terminal-group"].includes(item.kind)) ||
    (filter === "signals" && item.kind.startsWith("signal-")) ||
    (filter === "agents" && item.kind === "terminal-agent") ||
    (filter === "errors" &&
      (item.kind.startsWith("system-") ||
        ["failed", "timed_out"].includes(item.state)));
  const all = items.sort(activitySort);
  const visible = all.filter(include);
  const selected =
    visible.find((item) => item.uiId === selectedId) ?? visible[0];
  const counts: Record<ActivityFilter, number> = {
    all: all.length,
    results: all.filter((i) =>
      ["result", "terminal-task", "terminal-group"].includes(i.kind),
    ).length,
    signals: all.filter((i) => i.kind.startsWith("signal-")).length,
    agents: all.filter((i) => i.kind === "terminal-agent").length,
    errors: all.filter(
      (i) =>
        i.kind.startsWith("system-") ||
        ["failed", "timed_out"].includes(i.state),
    ).length,
  };
  return { items: visible, ...(selected ? { selected } : {}), counts, filter };
}
