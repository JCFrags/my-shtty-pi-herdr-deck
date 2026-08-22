export const AGENT_BOARD_REQUEST_EVENT = "pi-agent-board:request-summary-v1";
export const AGENT_BOARD_SUMMARY_EVENT = "pi-agent-board:summary-v1";
export const AGENT_BOARD_CHANGED_EVENT = "pi-agent-board:summary-changed-v1";
export const TODO_REQUEST_EVENT = "pi-todo:request-summary-v1";
export const TODO_SUMMARY_EVENT = "pi-todo:summary-v1";
export const TODO_CHANGED_EVENT = "pi-todo:summary-changed-v1";
export const AGENT_BOARD_VIEW_REQUEST_EVENT = "pi-agent-board:view-request-v2";
export const AGENT_BOARD_VIEW_RESPONSE_EVENT =
  "pi-agent-board:view-response-v2";
export const AGENT_BOARD_VIEW_CHANGED_EVENT = "pi-agent-board:view-changed-v2";
export const FILES_PROVIDER_SUMMARY_EVENT = "pi-files-ui:provider-summary-v1";
export const FILES_PROVIDER_VIEW_EVENT = "pi-files-ui:provider-view-change-v1";
export const FILES_PROVIDER_REQUEST_EVENT = "pi-files-ui:provider-request-v1";
export const FILES_PROVIDER_RESPONSE_EVENT = "pi-files-ui:provider-response-v1";
export const FILES_CAPABILITY_REQUEST_EVENT =
  "pi-files-ui:request-capability-v1";
export const FILES_CAPABILITY_EVENT = "pi-files-ui:capability-v1";

export interface AgentBoardQuestionOption {
  id: string;
  label: string;
  description?: string;
}
export interface AgentBoardPendingQuestion {
  questionId: string;
  revision: number;
  question: string;
  response: {
    kind:
      "single" | "multiple" | "text" | "single_or_text" | "multiple_or_text";
    options: AgentBoardQuestionOption[];
  };
  recommendedOptionIds: string[];
  recommendedText?: string;
}
export interface AgentBoardProjectionItem {
  id: string;
  title: string;
  state?: string;
  priority?: string;
}

export interface AgentBoardProjection {
  available: boolean;
  openCount: number;
  items: AgentBoardProjectionItem[];
  pendingQuestions?: AgentBoardPendingQuestion[];
  health?: string;
  preferredCommand?: string;
  view?: unknown;
}
export interface FilesProjection {
  available: boolean;
  capability?: unknown;
  summary?: unknown;
  view?: unknown;
  error?: string;
}

export interface TodoProjectionItem {
  id: string;
  text: string;
  status?: string;
  waitReason?: string;
}

export interface TodoProjection {
  available: boolean;
  total: number;
  completed: number;
  planSize?: number;
  countsByState?: Record<string, number>;
  currentUsefulTask?: TodoProjectionItem;
  waitReason?: string;
  externalWaits?: string[];
  items: TodoProjectionItem[];
}

export interface ProviderProjection {
  ownerAgentId: string;
  piSessionId: string;
  agentBoard: AgentBoardProjection;
  todo: TodoProjection;
  files?: FilesProjection;
}

const MAX_ITEMS = 64;
const MAX_PROJECTION_BYTES = 65_536;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanText(value: unknown, maxBytes = 512): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (/\p{Cc}/u.test(value) || Buffer.byteLength(value, "utf8") > maxBytes)
    return undefined;
  return value;
}

function integer(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Math.min(Number(value), 1_000_000)
    : fallback;
}

function summaryBody(value: unknown): Record<string, unknown> {
  const outer = record(value);
  return record(outer.summary ?? outer.snapshot ?? outer.data ?? value);
}

function sourceItems(body: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys)
    if (Array.isArray(body[key])) return body[key].slice(0, MAX_ITEMS);
  return [];
}

export function normalizeAgentBoardProjection(
  value: unknown,
): AgentBoardProjection {
  const body = summaryBody(value);
  const source = sourceItems(body, [
    "questions",
    "items",
    "openQuestions",
    "significantActiveUpdates",
    "entries",
  ]);
  const items = source.flatMap((entry, index): AgentBoardProjectionItem[] => {
    const item = record(entry);
    const title = cleanText(
      item.question ?? item.title ?? item.prompt ?? item.text,
    );
    if (!title) return [];
    const id =
      cleanText(item.id ?? item.questionId, 256) ?? `agent-board-${index + 1}`;
    const state = cleanText(item.state ?? item.status ?? item.kind, 64);
    const priority = cleanText(item.priority, 64);
    return [
      {
        id,
        title,
        ...(state ? { state } : {}),
        ...(priority ? { priority } : {}),
      },
    ];
  });
  return {
    available: true,
    openCount: integer(
      body.openCount ??
        body.pendingCount ??
        body.pendingAsyncQuestionCount ??
        body.count,
      items.length,
    ),
    items,
    pendingQuestions: normalizePendingQuestions(body.pendingQuestions),
  };
}

function normalizePendingQuestions(
  value: unknown,
): AgentBoardPendingQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((entry): AgentBoardPendingQuestion[] => {
    const q = record(entry);
    const questionId = cleanText(q.questionId, 256);
    const question = cleanText(q.question, 4000);
    const response = record(q.response);
    const kind = response.kind;
    if (
      !questionId ||
      !question ||
      !Number.isSafeInteger(q.revision) ||
      ![
        "single",
        "multiple",
        "text",
        "single_or_text",
        "multiple_or_text",
      ].includes(kind as string)
    )
      return [];
    const options = Array.isArray(response.options)
      ? response.options.slice(0, 16).flatMap((o) => {
          const r = record(o);
          const id = cleanText(r.id, 128);
          const label = cleanText(r.label, 500);
          const description = cleanText(r.description, 500);
          return id && label
            ? [{ id, label, ...(description ? { description } : {}) }]
            : [];
        })
      : [];
    return [
      {
        questionId,
        revision: q.revision as number,
        question,
        response: {
          kind: kind as AgentBoardPendingQuestion["response"]["kind"],
          options,
        },
        recommendedOptionIds: Array.isArray(q.recommendedOptionIds)
          ? q.recommendedOptionIds
              .filter((x): x is string => typeof x === "string")
              .slice(0, 16)
          : [],
        ...(typeof q.recommendedText === "string" &&
        cleanText(q.recommendedText, 4000)
          ? { recommendedText: cleanText(q.recommendedText, 4000)! }
          : {}),
      },
    ];
  });
}

export function normalizeTodoProjection(value: unknown): TodoProjection {
  const body = summaryBody(value);
  const source = sourceItems(body, [
    "items",
    "todos",
    "tasks",
    "unfinishedTasks",
    "entries",
  ]);
  const items = source.flatMap((entry, index): TodoProjectionItem[] => {
    const item = record(entry);
    const itemText = cleanText(
      item.text ?? item.title ?? item.task ?? item.description,
    );
    if (!itemText) return [];
    const id = cleanText(item.id ?? item.todoId, 256) ?? `todo-${index + 1}`;
    const status = cleanText(item.status ?? item.state, 64);
    const waitReason = cleanText(
      item.waitReason ?? item.externalWaitReason ?? item.blockedReason,
      512,
    );
    return [
      {
        id,
        text: itemText,
        ...(status ? { status } : {}),
        ...(waitReason ? { waitReason } : {}),
      },
    ];
  });
  const completedByItems = items.filter((item) =>
    ["done", "completed", "complete"].includes(
      item.status?.toLowerCase() ?? "",
    ),
  ).length;
  const rawCounts = record(body.countsByState);
  const countsByState = Object.fromEntries(
    Object.entries(rawCounts).flatMap(([key, value]) => {
      const cleanKey = cleanText(key, 64);
      return cleanKey ? [[cleanKey, integer(value, 0)]] : [];
    }),
  );
  const currentRaw = record(
    body.currentUsefulTask ?? body.currentTask ?? body.current,
  );
  const currentUsefulTask =
    currentRaw.text || currentRaw.title || currentRaw.task
      ? normalizeTodoProjection({ items: [currentRaw] }).items[0]
      : undefined;
  const waitReason = cleanText(body.waitReason ?? body.blockedReason, 512);
  const externalWaits = Array.isArray(body.externalWaits)
    ? body.externalWaits.slice(0, 16).flatMap((entry) => {
        const item = record(entry);
        const value =
          cleanText(entry) ??
          cleanText(item.reason ?? item.message ?? item.waitReason, 512);
        return value ? [value] : [];
      })
    : [];
  const planSize = integer(
    body.planSize ?? body.total ?? body.count,
    items.length,
  );
  return {
    available: true,
    total: integer(body.total ?? body.count ?? body.planSize, planSize),
    completed: integer(
      body.completed ?? body.completedCount ?? countsByState.done,
      completedByItems,
    ),
    planSize,
    countsByState,
    ...(currentUsefulTask ? { currentUsefulTask } : {}),
    ...(waitReason ? { waitReason } : {}),
    externalWaits,
    items,
  };
}

export function unavailableProviderProjection(
  ownerAgentId: string,
  piSessionId: string,
): ProviderProjection {
  return {
    ownerAgentId,
    piSessionId,
    agentBoard: {
      available: false,
      openCount: 0,
      items: [],
      pendingQuestions: [],
    },
    todo: {
      available: false,
      total: 0,
      completed: 0,
      planSize: 0,
      countsByState: {},
      externalWaits: [],
      items: [],
    },
    files: { available: false },
  };
}

export function validateProviderProjection(value: unknown): ProviderProjection {
  const source = record(value);
  if (
    Object.keys(source).some(
      (key) =>
        ![
          "ownerAgentId",
          "piSessionId",
          "agentBoard",
          "todo",
          "files",
        ].includes(key),
    )
  )
    throw new Error("INVALID_PROVIDER_PROJECTION");
  const ownerAgentId = cleanText(source.ownerAgentId, 256);
  const piSessionId = cleanText(source.piSessionId, 256);
  if (!ownerAgentId || !piSessionId)
    throw new Error("INVALID_PROVIDER_PROJECTION");
  const agentBoard = normalizeValidatedAgentBoard(source.agentBoard);
  const todo = normalizeValidatedTodo(source.todo);
  const files =
    source.files === undefined
      ? { available: false }
      : normalizeValidatedFiles(source.files);
  const projection: ProviderProjection = {
    ownerAgentId,
    piSessionId,
    agentBoard,
    todo,
    files,
  };
  if (
    Buffer.byteLength(JSON.stringify(projection), "utf8") > MAX_PROJECTION_BYTES
  )
    throw new Error("INVALID_PROVIDER_PROJECTION");
  return projection;
}

function normalizeValidatedAgentBoard(value: unknown): AgentBoardProjection {
  const source = record(value);
  if (typeof source.available !== "boolean" || !Array.isArray(source.items))
    throw new Error("INVALID_PROVIDER_PROJECTION");
  const normalized = normalizeAgentBoardProjection({
    questions: source.items,
    pendingQuestions: source.pendingQuestions,
    openCount: source.openCount,
  });
  return {
    ...normalized,
    available: source.available,
    ...(typeof source.health === "string" ? { health: source.health } : {}),
    ...(typeof source.preferredCommand === "string"
      ? { preferredCommand: source.preferredCommand }
      : {}),
    ...(source.view !== undefined ? { view: source.view } : {}),
  };
}
function normalizeValidatedFiles(value: unknown): FilesProjection {
  const source = record(value);
  if (typeof source.available !== "boolean")
    throw new Error("INVALID_PROVIDER_PROJECTION");
  return {
    available: source.available,
    ...(source.capability !== undefined
      ? { capability: source.capability }
      : {}),
    ...(source.summary !== undefined ? { summary: source.summary } : {}),
    ...(source.view !== undefined ? { view: source.view } : {}),
    ...(typeof source.error === "string" ? { error: source.error } : {}),
  };
}

function normalizeValidatedTodo(value: unknown): TodoProjection {
  const source = record(value);
  if (typeof source.available !== "boolean" || !Array.isArray(source.items))
    throw new Error("INVALID_PROVIDER_PROJECTION");
  const normalized = normalizeTodoProjection({
    items: source.items,
    total: source.total,
    completed: source.completed,
    planSize: source.planSize,
    countsByState: source.countsByState,
    currentUsefulTask: source.currentUsefulTask,
    waitReason: source.waitReason,
    externalWaits: source.externalWaits,
  });
  return { ...normalized, available: source.available };
}
