import { gitJson, type GitRunner } from "./runner.js";
import { evidenceFromOutputs, type GitEvidence } from "./porcelain.js";
export async function collectGitEvidence(
  cwd: string,
  base?: string,
  runner?: GitRunner,
): Promise<GitEvidence> {
  const root = await gitJson(["rev-parse", "--show-toplevel"], cwd, runner);
  const head = await gitJson(["rev-parse", "HEAD"], cwd, runner);
  const branch = await gitJson(["branch", "--show-current"], cwd, runner);
  const status = await gitJson(["status", "--porcelain=v2", "-z"], cwd, runner);
  const changed = base
    ? await gitJson(
        ["diff", "--name-only", "-z", `${base}...HEAD`],
        cwd,
        runner,
      )
    : await gitJson(["diff", "--name-only", "-z"], cwd, runner);
  return evidenceFromOutputs(
    root.trim(),
    head.trim(),
    branch.trim(),
    status,
    changed,
  );
}
