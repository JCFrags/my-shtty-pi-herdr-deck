import { runProcess, type ProcessResult } from "../shared/subprocess.js";
export interface GitRunner {
  run(
    argv: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ProcessResult>;
}
export function createGitRunner(): GitRunner {
  return {
    run: (argv, cwd, signal) =>
      runProcess({
        executable: "git",
        argv,
        cwd,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 10_000,
        maxOutputBytes: 8 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      }),
  };
}
export async function gitJson(
  argv: readonly string[],
  cwd: string,
  runner = createGitRunner(),
): Promise<string> {
  const r = await runner.run(argv, cwd);
  if (r.status !== 0 || r.timedOut) throw new Error("GIT_COMMAND_FAILED");
  return r.stdout;
}
