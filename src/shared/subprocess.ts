import { spawn, type ChildProcess } from "node:child_process";
export interface ProcessSpec {
  executable: string;
  argv: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}
export interface ProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "linux" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0)
    return Promise.reject(new Error("Process timeout must be finite."));
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, [...spec.argv], {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      detached: process.platform === "linux",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = Buffer.alloc(0),
      err = Buffer.alloc(0),
      timedOut = false,
      settled = false;
    const finish = (value: ProcessResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const append = (old: Buffer, chunk: Buffer): Buffer => {
      const next = Buffer.concat([old, chunk]);
      if (next.byteLength > spec.maxOutputBytes) {
        killGroup(child, "SIGKILL");
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("PROCESS_OUTPUT_LIMIT"));
        }
        return old;
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      out = append(out, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err = append(err, chunk);
    });
    child.once("error", reject);
    child.once("close", (status, signal) =>
      finish({
        status,
        signal,
        stdout: out.toString("utf8"),
        stderr: err.toString("utf8"),
        timedOut,
      }),
    );
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGKILL");
    }, spec.timeoutMs);
    spec.signal?.addEventListener("abort", () => killGroup(child, "SIGKILL"), {
      once: true,
    });
  });
}
