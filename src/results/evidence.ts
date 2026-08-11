import type { ResultBody } from "./types.js";
import type { GitEvidence } from "../git/porcelain.js";
export type TestEvidenceStatus = "not_reported" | "reported" | "verified";
export interface IndependentEvidence {
  gitEvidenceStatus:
    "not_applicable" | "pending" | "consistent" | "warning" | "contradiction";
  testEvidenceStatus: TestEvidenceStatus;
  git?: GitEvidence;
}
export function assessEvidence(
  result: ResultBody,
  git: GitEvidence | undefined,
  verifyTests?: (test: ResultBody["tests"][number]) => boolean,
): IndependentEvidence {
  const testEvidenceStatus: TestEvidenceStatus =
    result.tests.length === 0
      ? "not_reported"
      : verifyTests && result.tests.every(verifyTests)
        ? "verified"
        : "reported";
  if (!git) return { gitEvidenceStatus: "not_applicable", testEvidenceStatus };
  const claimed = new Set(result.changedFiles.map((f) => f.path));
  const actual = new Set(git.changedFiles);
  const contradiction =
    claimed.size !== actual.size ||
    [...claimed].some((path) => !actual.has(path));
  return {
    gitEvidenceStatus: contradiction ? "contradiction" : "consistent",
    testEvidenceStatus,
    git,
  };
}
