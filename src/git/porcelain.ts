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
      out.push(new TextDecoder().decode(bytes.slice(start, i)));
      start = i + 1;
    }
  }
  return out.filter(Boolean);
}
export function parsePorcelainV2(input: string | Uint8Array): GitStatusEntry[] {
  const data =
      typeof input === "string" ? new TextEncoder().encode(input) : input,
    out: GitStatusEntry[] = [];
  for (const line of fields(data)) {
    if (
      !line.startsWith("1 ") &&
      !line.startsWith("2 ") &&
      !line.startsWith("u ")
    )
      continue;
    const tab = line.indexOf("\t");
    const metadata = tab >= 0 ? line.slice(0, tab) : line;
    const p = metadata.split(" ");
    const xy = p[1] ?? "??";
    const path = tab >= 0 ? line.slice(tab + 1) : p.slice(9).join(" ");
    if (path)
      out.push({
        index: xy[0] ?? ".",
        worktree: xy[1] ?? ".",
        path,
        ...(line.startsWith("2 ") && p.length > p.indexOf("\t") + 1
          ? { origPath: p[p.length - 2] }
          : {}),
      });
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
