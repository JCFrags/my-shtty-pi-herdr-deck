import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { ResolvedPaths } from "../shared/paths.js";
import { readPrivateRegular } from "../shared/private-fs.js";
import { exportState } from "./retention.js";

export type RecoveryClass = "healthy" | "read_only_recovery";

export interface RecoveryVerification {
  valid: boolean;
  lastSeq: number;
  lastHash: string;
  readOnly: boolean;
  corruption?: string;
}

export interface RecoveryEvidence {
  verification: RecoveryVerification;
  expectedSeq?: number;
  expectedHash?: string;
}

export interface RecoveryPlan {
  class: RecoveryClass;
  verified: boolean;
  exportRequired: boolean;
  mutation: "none";
  reason?: string;
  confirmed: {
    sequence: boolean;
    digest: boolean;
  };
}

export interface RecoveryExport {
  output: string;
  manifest: string[];
  source: RecoveryVerification;
}

function validDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

/** Classify persisted state without opening a repair or mutation path. */
export function classifyRecovery(
  verification: RecoveryVerification,
): RecoveryClass {
  return verification.readOnly ||
    !verification.valid ||
    !!verification.corruption
    ? "read_only_recovery"
    : "healthy";
}

/** Confirm that a recovery decision still refers to the verified log suffix. */
export function confirmRecoveryEvidence(evidence: RecoveryEvidence): boolean {
  const { verification } = evidence;
  if (!Number.isSafeInteger(verification.lastSeq) || verification.lastSeq < 0)
    return false;
  if (!validDigest(verification.lastHash)) return false;
  const sequence =
    evidence.expectedSeq === undefined ||
    evidence.expectedSeq === verification.lastSeq;
  const digest =
    evidence.expectedHash === undefined ||
    evidence.expectedHash === verification.lastHash;
  return sequence && digest;
}

/** Produce a verified, read-only recovery plan. This function never writes state. */
export function planRecovery(evidence: RecoveryEvidence): RecoveryPlan {
  const confirmed = {
    sequence:
      evidence.expectedSeq === undefined ||
      evidence.expectedSeq === evidence.verification.lastSeq,
    digest:
      evidence.expectedHash === undefined ||
      evidence.expectedHash === evidence.verification.lastHash,
  };
  const verified = confirmRecoveryEvidence(evidence);
  const recoveryClass = classifyRecovery(evidence.verification);
  return {
    class: recoveryClass,
    verified,
    exportRequired: recoveryClass === "read_only_recovery" && verified,
    mutation: "none",
    ...(evidence.verification.corruption
      ? { reason: evidence.verification.corruption }
      : {}),
    confirmed,
  };
}

/**
 * Export verified state before any separately approved repair operation.
 * This is the only function here that writes, and it writes only a new export.
 */
export async function exportBeforeRepair(
  paths: ResolvedPaths,
  output: string,
  evidence: RecoveryEvidence,
): Promise<RecoveryExport> {
  const plan = planRecovery(evidence);
  if (!plan.verified) throw new Error("Recovery evidence is not confirmed.");
  if (plan.class !== "read_only_recovery")
    throw new Error(
      "An export-before-repair is required only for recovery state.",
    );
  const result = await exportState(paths, output);
  const manifest = [
    `recovery-class:${plan.class}`,
    `sequence:${evidence.verification.lastSeq}`,
    `digest:${evidence.verification.lastHash}`,
    ...result.manifest,
  ];
  // exportState already creates the private manifest. Return the augmented
  // record without changing canonical state or repair targets.
  return { output: result.output, manifest, source: evidence.verification };
}

/** Verify an exported file digest without changing it. */
export async function digestExportedFile(
  output: string,
  fileName: string,
  expectedDigest: string,
): Promise<boolean> {
  if (!validDigest(expectedDigest)) return false;
  const candidate = basename(fileName);
  if (!candidate || candidate === "." || candidate === "..") return false;
  try {
    const content = await readPrivateRegular(join(output, candidate));
    const digest = createHash("sha256").update(content).digest("hex");
    return digest === expectedDigest;
  } catch {
    return false;
  }
}
