export type ThemeTone =
  | "title"
  | "heading"
  | "active"
  | "inactive"
  | "healthy"
  | "pending"
  | "error"
  | "muted"
  | "selected"
  | "button"
  | "border"
  | "text";

const ANSI: Record<Exclude<ThemeTone, "text">, string> = {
  title: "\u001b[1;96m",
  heading: "\u001b[1;94m",
  active: "\u001b[1;96m",
  inactive: "\u001b[90m",
  healthy: "\u001b[1;92m",
  pending: "\u001b[1;93m",
  error: "\u001b[1;91m",
  muted: "\u001b[90m",
  selected: "\u001b[1;97;44m",
  button: "\u001b[1;36m",
  border: "\u001b[34m",
};
const RESET = "\u001b[0m";

/** Central terminal theme. Layout must be complete before this function runs. */
export function colorsEnabled(): boolean {
  return (
    process.env.NO_COLOR === undefined &&
    process.env.TERM !== "dumb" &&
    Boolean(process.stdout.isTTY)
  );
}

export function paint(
  value: string,
  tone: ThemeTone,
  enabled = colorsEnabled(),
): string {
  if (!enabled || tone === "text") return value;
  return `${ANSI[tone]}${value}${RESET}`;
}

function semanticTone(line: string): ThemeTone {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("Agent Board") || trimmed.startsWith("AGENT BOARD"))
    return "title";
  if (
    /^(HOME|FILES|AGENTS|INBOX|MORE|WORK|SETTINGS|ORCHESTRATOR|AGENT BOARD|FILES PROVIDER|BOARD DETAIL|PREVIEW|NOTIFICATIONS|CURRENT|RESULTS|GROUPS|HISTORY|PI TODO)/.test(
      trimmed,
    )
  )
    return "heading";
  if (/\b(error|failed|failure|unavailable|timed out|invalid)\b/i.test(trimmed))
    return "error";
  if (/\b(connected|healthy|available|succeeded|complete|✓)\b/i.test(trimmed))
    return "healthy";
  if (/\b(pending|queued|blocked|waiting|notice|open|retry)\b/i.test(trimmed))
    return "pending";
  if (
    /^Help:|^Global totals:|^Provider actions:|^Format:|^Enter submits|^Focus adopted/.test(
      trimmed,
    )
  )
    return "muted";
  if (/^>\s|^\[x\]|^Selected board item:/.test(trimmed)) return "selected";
  if (/\([^)]*\)|\[[^]]+\]/.test(trimmed)) return "button";
  if (/^[├└│─┌┐┘└]/.test(trimmed)) return "border";
  return "text";
}

export function styleLine(line: string, enabled = colorsEnabled()): string {
  if (!enabled) return line;
  if (/^\[(?:[A-Z]+|[A-Za-z]+)\s+\d+\]/.test(line))
    return line.replace(/\[([^\]]+)\]/g, (token, label: string) =>
      paint(token, /[A-Z]/.test(label) ? "active" : "inactive", enabled),
    );
  return paint(line, semanticTone(line), enabled);
}

export function styleLines(
  lines: readonly string[],
  enabled = colorsEnabled(),
): string[] {
  return lines.map((line) => styleLine(line, enabled));
}

export function toneForLine(line: string): ThemeTone {
  return semanticTone(line);
}
