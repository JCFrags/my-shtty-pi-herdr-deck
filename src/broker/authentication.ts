import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import type { PrincipalKind } from "../shared/protocol/frames.js";
import { OrchestratorError } from "../shared/errors.js";
export interface Principal {
  id: string;
  kind: PrincipalKind;
  permissions: readonly string[];
  agentId?: string;
  generation?: number;
  piSessionId?: string;
}
export interface AgentCredential {
  agentId: string;
  generation: number;
  tokenHash: string;
  piSessionId: string;
  parentAgentId?: string;
}
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function verifySecret(expected: string, received: string): boolean {
  const a = Buffer.from(digest(expected), "hex");
  const b = Buffer.from(digest(received), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}
export function authenticate(
  secret: string,
  received: string,
  kind: PrincipalKind,
  credential?: AgentCredential,
  token?: string,
  generation?: number,
  piSessionId?: string,
): Principal {
  if (kind === "pi_child") {
    if (
      !credential ||
      !token ||
      credential.tokenHash !== digest(token) ||
      credential.generation !== generation ||
      credential.piSessionId !== piSessionId
    )
      throw new OrchestratorError(
        "AUTH_FAILED",
        "Managed agent identity is not valid.",
      );
    return {
      id: "prn_00000000000000000000000003",
      kind,
      agentId: credential.agentId,
      generation: credential.generation,
      piSessionId: credential.piSessionId,
      permissions: [
        "read:state",
        "read:results",
        "manage:self",
        "answer:descendants",
      ],
    };
  }
  if (!verifySecret(secret, received))
    throw new OrchestratorError("AUTH_FAILED", "Client authentication failed.");
  const permissions =
    kind === "observer"
      ? ["read:state"]
      : [
          "read:state",
          "read:results",
          "read:audit",
          "manage:all",
          "configure",
          "repair",
          "delegate",
        ];
  const principalId =
    kind === "observer"
      ? "prn_00000000000000000000000002"
      : "prn_00000000000000000000000001";
  return { id: principalId, kind, permissions };
}
export function requirePermission(
  principal: Principal,
  permission: string,
): void {
  if (
    !principal.permissions.includes(permission) &&
    !principal.permissions.includes("manage:all")
  )
    throw new OrchestratorError(
      "PERMISSION_DENIED",
      `Permission ${permission} is required.`,
    );
}
