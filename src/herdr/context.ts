export interface HerdrPluginContext {
  raw: Record<string, unknown>;
  ownPaneId?: string;
  targetPaneCandidates: string[];
}

export interface HerdrAgentInfo {
  terminalId: string;
  paneId: string;
  name?: string;
  agent?: string;
  displayAgent?: string;
  title?: string;
  status?: string;
  cwd?: string;
  focused: boolean;
}

export type TargetResolution =
  | {
      kind: "resolved";
      paneId: string;
      agent: HerdrAgentInfo;
      source: "context";
    }
  | { kind: "picker"; agents: HerdrAgentInfo[]; reason: string }
  | { kind: "missing"; reason: string };

const PANE_KEY_PATTERN =
  /(?:^|_)(?:target|source|selected|focused|origin|owner)?_?pane(?:_id)?$/i;
const TARGET_CONTAINER_PATTERN =
  /target|source|selected|focused|invocation|context|origin/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectPaneCandidates(
  value: unknown,
  candidates: Set<string>,
  path: readonly string[] = [],
  depth = 0,
): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 128))
      collectPaneCandidates(item, candidates, path, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = [...path, key];
    const targetishPath = nextPath.some((part) =>
      TARGET_CONTAINER_PATTERN.test(part),
    );
    if (
      typeof nested === "string" &&
      nested.length > 0 &&
      nested.length <= 256 &&
      PANE_KEY_PATTERN.test(key) &&
      targetishPath
    ) {
      candidates.add(nested);
    } else {
      collectPaneCandidates(nested, candidates, nextPath, depth + 1);
    }
  }
}

export function parseHerdrPluginContext(
  json: string | undefined,
  ownPaneId = process.env.HERDR_PANE_ID,
): HerdrPluginContext {
  let raw: Record<string, unknown> = {};
  if (json && json.trim().length > 0) {
    if (Buffer.byteLength(json, "utf8") > 1024 * 1024)
      throw new Error("HERDR_PLUGIN_CONTEXT_JSON exceeds 1 MiB.");
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed))
      throw new Error("HERDR_PLUGIN_CONTEXT_JSON must contain an object.");
    raw = parsed;
  }
  const candidates = new Set<string>();
  collectPaneCandidates(raw, candidates);
  if (ownPaneId) candidates.delete(ownPaneId);
  return {
    raw,
    ...(ownPaneId ? { ownPaneId } : {}),
    targetPaneCandidates: [...candidates],
  };
}

export function isPiAgent(agent: HerdrAgentInfo): boolean {
  const detectedLabels = [agent.agent, agent.displayAgent].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  const fallbackLabels = [agent.title, agent.name].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  // Herdr's detected agent labels are authoritative. Human-assigned names and titles are
  // considered only when the detection fields are absent, so a Codex pane named "pi"
  // cannot be mistaken for a Pi process.
  const labels = (
    detectedLabels.length > 0 ? detectedLabels : fallbackLabels
  ).map((value) => value.trim().toLowerCase());
  return labels.some(
    (label) => label === "pi" || /(?:^|[^a-z0-9])pi(?:[^a-z0-9]|$)/.test(label),
  );
}

export function resolveTargetPane(
  context: HerdrPluginContext,
  agents: readonly HerdrAgentInfo[],
): TargetResolution {
  const livePiAgents = agents
    .filter(isPiAgent)
    .filter((agent) => agent.paneId !== context.ownPaneId);
  const byPane = new Map(livePiAgents.map((agent) => [agent.paneId, agent]));
  const supplied = context.targetPaneCandidates.flatMap((paneId) => {
    const agent = byPane.get(paneId);
    return agent ? [agent] : [];
  });
  const uniqueSupplied = [
    ...new Map(supplied.map((agent) => [agent.paneId, agent])).values(),
  ];
  if (uniqueSupplied.length === 1) {
    const agent = uniqueSupplied[0]!;
    return { kind: "resolved", paneId: agent.paneId, agent, source: "context" };
  }
  if (uniqueSupplied.length > 1) {
    return {
      kind: "picker",
      agents: uniqueSupplied,
      reason: "The Herdr plugin context names more than one live Pi pane.",
    };
  }
  if (livePiAgents.length > 0) {
    return {
      kind: "picker",
      agents: livePiAgents,
      reason: "Select the Pi pane to control.",
    };
  }
  return {
    kind: "missing",
    reason: "No live Pi agent pane was found in Herdr.",
  };
}
