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
import { boardRecord, type BoardRecord } from "./board-presentation.js";
import { selectAdoptedScope, currentProviderProjection } from "./scope.js";
import {
  selectSignalsActivityItems,
  selectSignalsTabPresentation,
} from "./signals-presentation.js";

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
function normalizedStatus(value: string | undefined): string {
  return (value ?? "open")
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, " ");
}
function normalizedWaitReason(value: unknown): string {
  return text(value, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function stableWaitId(reason: string): string {
  let hash = 2166136261;
  for (const character of reason) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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
        actions: todo.waitReason
          ? {
              primary: "clear-wait",
              actions: ["clear-wait", "mark-done"],
            }
          : waiting
            ? { primary: "mark-done", actions: ["mark-done"] }
            : { primary: "start", actions: ["start", "mark-done"] },
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
  const signalInbox = selectSignalsTabPresentation(
    provider?.agentBoard,
    "inbox",
  );
  for (const question of signalInbox) {
    if (question.entityType !== "question") continue;
    const id = question.entityId;
    const pending = provider?.agentBoard.pendingQuestions?.find(
      (candidate) => candidate.questionId === id,
    );
    if (!question.userAnswerable && !question.retryableDelivery) continue;
    items.push(
      boardItem({
        uiId: `signals:question:${id}`,
        entityId: id,
        kind: "signal-question",
        source: question as unknown as BoardRecord,
        sourceLabel: "SIGNALS",
        title: question.title,
        summary: question.prompt,
        state: question.statusLabel,
        section: "attention",
        priority: question.retryableDelivery ? 5 : 1,
        sortTimestamp: question.changedAt,
        revision: question.revision,
        ...(pending ? { pendingQuestion: pending } : {}),
        actions: {
          primary: "answer",
          actions: [
            "answer",
            ...(question.recommendedOptionIds.length || question.recommendedText
              ? ["use-recommendation"]
              : []),
            ...(question.dismissible ? ["dismiss-question"] : []),
            ...(question.retryableDelivery && question.answerId
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
  for (const update of selectSignalsTabPresentation(
    provider?.agentBoard,
    "updates",
  )) {
    if (update.entityType !== "update") continue;
    const id = update.entityId;
    if (signalIds.has(id) || update.terminal) continue;
    items.push(
      boardItem({
        uiId: `signals:update:${id}`,
        entityId: id,
        kind: "signal-update",
        source: update as unknown as BoardRecord,
        sourceLabel: "SIGNALS",
        title: update.title,
        summary: update.detail ?? update.stage ?? "Recent update",
        state: update.kind || update.statusLabel,
        section: "recent-signals",
        priority: 70,
        sortTimestamp: update.changedAt,
        revision: update.revision,
        actions: { actions: [] },
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
  const itemWaitReasons = new Set(
    (provider?.todo.items ?? [])
      .map((item) => normalizedWaitReason(item.waitReason))
      .filter(Boolean),
  );
  const providerWaitReasons = [
    provider?.todo.waitReason,
    ...(provider?.todo.externalWaits ?? []),
  ]
    .map(normalizedWaitReason)
    .filter(Boolean);
  const seenProviderWaits = new Set<string>();
  for (const reason of providerWaitReasons) {
    if (seenProviderWaits.has(reason) || itemWaitReasons.has(reason)) continue;
    seenProviderWaits.add(reason);
    const id = `provider-wait:${stableWaitId(reason)}`;
    items.push(
      boardItem({
        uiId: `todo:${id}`,
        entityId: id,
        kind: "todo",
        source: {
          id,
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

function signalActivity(
  projection: AgentBoardProjection | undefined,
): ActivityItem[] {
  return selectSignalsActivityItems(projection).map((source) => {
    const kind =
      source.entityType === "update"
        ? "signal-update"
        : source.entityType === "decision"
          ? "signal-decision"
          : "signal-history";
    const summary =
      source.entityType === "update"
        ? (source.detail ?? source.stage ?? source.statusLabel)
        : source.entityType === "decision"
          ? source.outcome
          : source.statusLabel;
    return activityItem({
      uiId: `signals:${source.entityType}:${source.rowId}`,
      entityId: source.entityId,
      kind,
      title: source.title,
      summary,
      state: source.statusLabel,
      sortTimestamp: source.changedAt,
      source: source as unknown as BoardRecord,
      revision: source.revision,
      actions: {
        actions: [
          ...(source.entityType === "update" &&
          source.terminal &&
          !source.archived
            ? ["archive-update" as const]
            : []),
          ...(source.entityType === "question" &&
          source.retryableDelivery &&
          source.answerId
            ? ["retry-delivery" as const]
            : []),
        ],
      },
    });
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
  items.push(...signalActivity(provider?.agentBoard));
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
