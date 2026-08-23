import type {
  AgentBoardPendingQuestion,
  AgentBoardProjection,
  AgentBoardProjectionItem,
} from "../shared/provider-projections.js";

export type BoardTab = "inbox" | "updates" | "decisions" | "history";
export type BoardRecord = Record<string, unknown>;

export interface BoardPresentation {
  available: boolean;
  openCount: number;
  tabCounts: Record<BoardTab, number>;
  tab: BoardTab;
  rows: BoardRecord[];
  empty: BoardRecord;
  selectedRow?: BoardRecord;
  selectedId?: string;
  selectedRevision: number;
  detail: BoardRecord;
  pendingQuestion?: AgentBoardPendingQuestion;
  userAnswerable: boolean;
  dismissible: boolean;
  retryableDelivery: boolean;
  updateKind: string;
}

export function boardRecord(value: unknown): BoardRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as BoardRecord)
    : {};
}

function rowId(row: BoardRecord): string {
  return String(row.id ?? row.entityId ?? "");
}

function fallbackRows(items: AgentBoardProjectionItem[]): BoardRecord[] {
  return items.map((item) => ({
    id: item.id,
    displayId: item.id,
    title: item.title,
    state: item.state,
    priority: item.priority,
  }));
}

export function selectBoardPresentation(
  projection: AgentBoardProjection | undefined,
  tab: BoardTab,
  selectedId?: string,
): BoardPresentation {
  const outer = boardRecord(projection?.view);
  const model = boardRecord(outer.view ?? outer);
  const tabs = boardRecord(model.tabs);
  const currentTab = boardRecord(tabs[tab]);
  const rows = Array.isArray(currentTab.rows)
    ? currentTab.rows.slice(0, 64).map(boardRecord)
    : tab === "inbox"
      ? fallbackRows(projection?.items ?? [])
      : [];
  const selectedRow =
    (selectedId ? rows.find((row) => rowId(row) === selectedId) : undefined) ??
    rows[0];
  const effectiveId = selectedRow ? rowId(selectedRow) : undefined;
  const details = boardRecord(currentTab.detailsById);
  const detail = boardRecord(
    (effectiveId ? details[effectiveId] : undefined) ?? currentTab.detail,
  );
  const pendingQuestion = projection?.pendingQuestions?.find(
    (question) => question.questionId === effectiveId,
  );
  const rawCounts = boardRecord(model.tabCounts);
  const count = (name: BoardTab): number =>
    Number(
      rawCounts[name] ?? (name === "inbox" ? projection?.openCount : 0) ?? 0,
    );
  return {
    available: projection?.available === true,
    openCount: projection?.openCount ?? 0,
    tabCounts: {
      inbox: count("inbox"),
      updates: count("updates"),
      decisions: count("decisions"),
      history: count("history"),
    },
    tab,
    rows,
    empty: boardRecord(currentTab.empty),
    ...(selectedRow ? { selectedRow } : {}),
    ...(effectiveId ? { selectedId: effectiveId } : {}),
    selectedRevision: Number(selectedRow?.revision ?? 0),
    detail,
    ...(pendingQuestion ? { pendingQuestion } : {}),
    userAnswerable: selectedRow?.userAnswerable === true,
    dismissible: selectedRow?.dismissible === true,
    retryableDelivery: selectedRow?.retryableDelivery === true,
    updateKind: String(selectedRow?.kind ?? ""),
  };
}
