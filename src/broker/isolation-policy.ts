import { OrchestratorError } from "../shared/errors.js";

export type ProductionIsolation = "shared-readonly" | "worktree";
export type RequestedIsolation = unknown;

interface ShippedProfileContract {
  readonly defaultIsolation: ProductionIsolation;
  readonly allowSharedOverride: boolean;
}

// This table is the checked-in projection of the shipped profiles/*.json contract.
// Unknown IDs are never assigned a permissive default.
const SHIPPED_PROFILE_CONTRACT: Readonly<
  Record<string, ShippedProfileContract>
> = Object.freeze({
  implementer: { defaultIsolation: "worktree", allowSharedOverride: false },
  planner: { defaultIsolation: "shared-readonly", allowSharedOverride: false },
  reviewer: { defaultIsolation: "shared-readonly", allowSharedOverride: false },
  scout: { defaultIsolation: "shared-readonly", allowSharedOverride: false },
  "test-runner": {
    defaultIsolation: "shared-readonly",
    allowSharedOverride: false,
  },
});

function profileContract(profileId: string): ShippedProfileContract {
  const contract = SHIPPED_PROFILE_CONTRACT[profileId];
  if (!contract)
    throw new OrchestratorError(
      "INVALID_REQUEST",
      "The profile ID is not a shipped profile.",
    );
  return contract;
}

export function resolveIsolation(
  profileId: string,
  requested: RequestedIsolation,
): ProductionIsolation {
  const contract = profileContract(profileId);
  if (requested === undefined || requested === "profile-default")
    return contract.defaultIsolation;
  if (requested === "worktree") return "worktree";
  if (requested === "shared-readonly") {
    if (
      contract.defaultIsolation === "worktree" &&
      !contract.allowSharedOverride
    )
      throw new OrchestratorError(
        "PERMISSION_DENIED",
        "This profile does not permit shared-readonly isolation.",
      );
    return "shared-readonly";
  }
  throw new OrchestratorError(
    "INVALID_REQUEST",
    "The requested isolation mode is not supported by production provisioning.",
  );
}

export function resolveWorkflowIsolation(
  profileId: string,
  requested: RequestedIsolation,
): ProductionIsolation {
  if (requested === "reuse-worktree") {
    profileContract(profileId);
    return profileContract(profileId).defaultIsolation;
  }
  return resolveIsolation(profileId, requested);
}
