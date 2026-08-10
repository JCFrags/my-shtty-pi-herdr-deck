import { spawn } from "node:child_process";
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
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0)
    return Promise.reject(new Error("Process timeout must be finite."));
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, [...spec.argv], {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let timedOut = false;
    const add = (target: Buffer, chunk: Buffer): Buffer =>
      Buffer.concat([target, chunk]).subarray(0, spec.maxOutputBytes);
    child.stdout.on("data", (chunk: Buffer) => {
      out = add(out, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err = add(err, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, spec.timeoutMs);
    spec.signal?.addEventListener("abort", () => child.kill("SIGTERM"), {
      once: true,
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout: out.toString("utf8"),
        stderr: err.toString("utf8"),
        timedOut,
      });
    });
  });
}
