import { appendFile, lstat, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

const SECRET =
  /(sk-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,}]+)/giu;
export function redact(value: string): string {
  return value.replace(SECRET, "[REDACTED]");
}
export interface SafeLogRecord {
  timestamp: string;
  level: "error" | "warn" | "info" | "debug" | "trace";
  event: string;
  data?: Record<string, string | number | boolean | null>;
}
export async function appendSafeLog(
  path: string,
  record: SafeLogRecord,
  maxBytes = 10 * 1024 * 1024,
): Promise<void> {
  const line = `${JSON.stringify({ ...record, data: record.data ? Object.fromEntries(Object.entries(record.data).map(([key, value]) => [key, typeof value === "string" ? redact(value) : value])) : undefined })}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const current = await lstat(path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      (process.getuid?.() !== undefined && current.uid !== process.getuid()) ||
      (current.mode & 0o077) !== 0
    )
      throw new Error("Unsafe log path.");
    if (current.size + Buffer.byteLength(line) > maxBytes)
      await rename(path, `${path}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await appendFile(path, line, { mode: 0o600 });
  const final = await stat(path);
  if (!final.isFile() || (final.mode & 0o077) !== 0)
    throw new Error("Log path became unsafe.");
}
