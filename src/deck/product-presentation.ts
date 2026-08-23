import type { Agent, Task } from "../state/types.js";
import type {
  AgentBoardProjection,
  ProviderProjection,
  TodoProjectionItem,
} from "../shared/provider-projections.js";
import type {
  DeckGroup,
  DeckQuestion,
  DeckResult,
  DeckState,
} from "./types.js";
import {
  selectBoardPresentation,
  type BoardRecord,
} from "./board-presentation.js";
import { selectAdoptedScope, currentProviderProjection } from "./scope.js";
import { selectTaskRowPresentation } from "./selections.js";

export type AgentBoardTab = "board" | "files" | "agents" | "activity";

export type BoardItem =
  | {
      kind: "todo";
      id: string;
      title: string;
      status: string;
      waitReason?: string;
      source: TodoProjectionItem;
    }
  | { kind: "task"; id: string; title: string; status: string; source: Task }
  | {
      kind: "group";
      id: string;
      title: string;
      status: string;
      source: DeckGroup;
    }
  | {
      kind: "broker-question";
      id: string;
      title: string;
      status: "attention";
      source: DeckQuestion;
    }
  | {
      kind: "signal-question" | "signal-update" | "signal-recommendation";
      id: string;
      title: string;
      status: string;
      source: BoardRecord;
    };

export type ActivityItem =
  | {
      kind: "result";
      id: string;
      title: string;
      status: string;
      source: DeckResult;
    }
  | { kind: "task"; id: string; title: string; status: string; source: Task }
  | {
      kind: "group";
      id: string;
      title: string;
      status: string;
      source: DeckGroup;
    }
  | { kind: "agent"; id: string; title: string; status: string; source: Agent }
  | {
      kind: "signal-update" | "signal-decision" | "signal-history";
      id: string;
      title: string;
      status: string;
      source: BoardRecord;
    };

export interface UnifiedBoardPresentation {
  provider?: ProviderProjection;
  work: BoardItem[];
  attention: BoardItem[];
  selected?: BoardItem;
  counts: { work: number; attention: number };
}

export interface ActivityPresentation {
  items: ActivityItem[];
  selected?: ActivityItem;
  counts: Record<ActivityItem["kind"], number>;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function rowId(row: BoardRecord, index: number): string {
  return text(row.id ?? row.entityId, `row-${index + 1}`);
}

function rowTitle(row: BoardRecord, id: string): string {
  return text(row.title ?? row.question ?? row.detail, id);
}

function stable<T extends { kind: string; id: string }>(items: T[]): T[] {
  return items.sort((left, right) =>
    `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
  );
}

function signals(
  projection: AgentBoardProjection | undefined,
  tab: "inbox" | "updates" | "decisions" | "history",
): BoardRecord[] {
  return selectBoardPresentation(projection, tab).rows;
}

export function selectUnifiedBoardPresentation(
  state: DeckState,
  targetPaneId?: string,
  selectedId?: string,
): UnifiedBoardPresentation {
  const provider = currentProviderProjection(state, targetPaneId);
  const scoped = selectAdoptedScope(state, targetPaneId).state;
  const todo: BoardItem[] = (provider?.todo.items ?? []).map((item) => ({
    kind: "todo",
    id: `todo:${item.id}`,
    title: item.text,
    status: item.status ?? (item.waitReason ? "waiting" : "open"),
    ...(item.waitReason ? { waitReason: item.waitReason } : {}),
    source: item,
  }));
  const tasks: BoardItem[] = [...scoped.tasks.values()]
    .filter(
      (item) =>
        !["completed", "failed", "cancelled", "closed"].includes(item.state),
    )
    .map((item) => ({
      kind: "task",
      id: `task:${item.id}`,
      title: text(item.title ?? item.objective, item.id),
      status: item.state,
      source: item,
    }));
  const groups: BoardItem[] = [...scoped.groups.values()]
    .filter(
      (item) =>
        !["completed", "failed", "cancelled", "closed", "stopped"].includes(
          item.state,
        ),
    )
    .map((item) => ({
      kind: "group",
      id: `group:${item.id}`,
      title: text(item.title ?? item.name, item.id),
      status: item.state,
      source: item,
    }));
  const questions: BoardItem[] = [...scoped.questions.values()]
    .filter((item) => !item.answered && item.state !== "answered")
    .map((item) => ({
      kind: "broker-question",
      id: `question:${item.id}`,
      title: item.prompt,
      status: "attention",
      source: item,
    }));
  const signalRows = (
    [
      ["inbox", "signal-question"],
      ["updates", "signal-update"],
      ["decisions", "signal-recommendation"],
    ] as const
  ).flatMap(([tab, kind]) =>
    signals(provider?.agentBoard, tab).map((row, index): BoardItem => {
      const id = rowId(row, index);
      return {
        kind,
        id: `${kind}:${id}`,
        title: rowTitle(row, id),
        status: text(row.statusLabel ?? row.state, tab),
        source: row,
      };
    }),
  );
  const work = stable([...todo, ...tasks, ...groups]);
  const attention = stable([...questions, ...signalRows]);
  const all = [...attention, ...work];
  return {
    ...(provider ? { provider } : {}),
    work,
    attention,
    ...((all.find((item) => item.id === selectedId) ?? all[0])
      ? { selected: all.find((item) => item.id === selectedId) ?? all[0] }
      : {}),
    counts: { work: work.length, attention: attention.length },
  };
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
  return signals(projection, tab).map((row, index) => {
    const id = rowId(row, index);
    return {
      kind,
      id: `${kind}:${id}`,
      title: rowTitle(row, id),
      status: text(row.statusLabel ?? row.state ?? row.kind, tab),
      source: row,
    };
  });
}

export function selectActivityPresentation(
  state: DeckState,
  targetPaneId?: string,
  selectedId?: string,
): ActivityPresentation {
  const provider = currentProviderProjection(state, targetPaneId);
  const scoped = selectAdoptedScope(state, targetPaneId).state;
  const taskRows = selectTaskRowPresentation(scoped).history.map(
    (item): ActivityItem => ({
      kind: "task",
      id: `task:${item.id}`,
      title: text(item.title ?? item.objective, item.id),
      status: item.state,
      source: item,
    }),
  );
  const results = [...scoped.results.values()].map((item): ActivityItem => ({
    kind: "result",
    id: `result:${item.id}`,
    title: text(item.summary, item.id),
    status: item.status,
    source: item,
  }));
  const groups = [...scoped.groups.values()]
    .filter((item) =>
      ["completed", "failed", "cancelled", "closed", "stopped"].includes(
        item.state,
      ),
    )
    .map((item): ActivityItem => ({
      kind: "group",
      id: `group:${item.id}`,
      title: text(item.title ?? item.name, item.id),
      status: item.state,
      source: item,
    }));
  const agents = [...scoped.agents.values()]
    .filter((item) => ["closed", "stopped", "failed"].includes(item.state))
    .map((item): ActivityItem => ({
      kind: "agent",
      id: `agent:${item.id}`,
      title: text(item.displayName ?? item.herdrName, item.id),
      status: item.state,
      source: item,
    }));
  const items = stable([
    ...results,
    ...taskRows,
    ...groups,
    ...agents,
    ...signalActivity(provider?.agentBoard, "updates"),
    ...signalActivity(provider?.agentBoard, "decisions"),
    ...signalActivity(provider?.agentBoard, "history"),
  ]);
  const counts = Object.fromEntries(
    (
      [
        "result",
        "task",
        "group",
        "agent",
        "signal-update",
        "signal-decision",
        "signal-history",
      ] as const
    ).map((kind) => [kind, items.filter((item) => item.kind === kind).length]),
  ) as ActivityPresentation["counts"];
  return {
    items,
    ...((items.find((item) => item.id === selectedId) ?? items[0])
      ? { selected: items.find((item) => item.id === selectedId) ?? items[0] }
      : {}),
    counts,
  };
}
