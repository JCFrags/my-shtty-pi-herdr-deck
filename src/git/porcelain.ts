export interface GitStatusEntry {
  index: string;
  worktree: string;
  path: string;
  origPath?: string;
}
export interface GitEvidence {
  repositoryRoot: string;
  head: string;
  branch: string;
  dirty: boolean;
  entries: GitStatusEntry[];
  changedFiles: string[];
}
function fields(bytes: Uint8Array): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0) {
      out.push(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(start, i)),
      );
      start = i + 1;
    }
  }
  return out.filter(Boolean);
}
export function parsePorcelainV2(input: string | Uint8Array): GitStatusEntry[] {
  const data =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const records = fields(data),
    out: GitStatusEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith("1 ") || record.startsWith("u ")) {
      const tab = record.indexOf("\t");
      const meta = tab >= 0 ? record.slice(0, tab) : record;
      const p = meta.split(" ");
      const xy = p[1] ?? "??";
      const path = tab >= 0 ? record.slice(tab + 1) : p.slice(9).join(" ");
      if (path) out.push({ index: xy[0] ?? ".", worktree: xy[1] ?? ".", path });
    } else if (record.startsWith("2 ")) {
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const p = record.slice(0, tab).split(" ");
      const xy = p[1] ?? "??";
      const path = record.slice(tab + 1);
      const origPath = records[++i];
      if (path)
        out.push({
          index: xy[0] ?? ".",
          worktree: xy[1] ?? ".",
          path,
          ...(origPath ? { origPath } : {}),
        });
    }
  }
  return out;
}
export function parseNameList(input: string | Uint8Array): string[] {
  return fields(
    typeof input === "string" ? new TextEncoder().encode(input) : input,
  );
}
export function evidenceFromOutputs(
  root: string,
  head: string,
  branch: string,
  status: string | Uint8Array,
  changed: string | string[],
): GitEvidence {
  const entries = parsePorcelainV2(status);
  return {
    repositoryRoot: root,
    head,
    branch,
    dirty: entries.length > 0,
    entries,
    changedFiles:
      typeof changed === "string" ? parseNameList(changed) : changed,
  };
}
