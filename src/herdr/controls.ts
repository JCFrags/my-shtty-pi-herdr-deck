import { basename, isAbsolute } from "node:path";
import type { HerdrCli } from "./cli.js";
import type { HerdrSessionReference, HerdrSnapshot } from "./types.js";

export function piSessionMatches(
  sessionId: string,
  legacySessionId: string | undefined,
  reference: HerdrSessionReference | undefined,
): boolean {
  if (legacySessionId !== undefined) return legacySessionId === sessionId;
  if (!reference || reference.source !== "herdr:pi" || reference.agent !== "pi")
    return false;
  if (reference.kind === "id") return reference.value === sessionId;
  if (reference.kind !== "path" || !isAbsolute(reference.value)) return false;
  const name = basename(reference.value);
  return name === `${sessionId}.jsonl` || name.endsWith(`_${sessionId}.jsonl`);
}
export interface OccupantGuard {
  paneId: string;
  terminalId?: string;
  sessionId?: string;
  generation?: number;
}
export async function revalidateOccupant(
  cli: HerdrCli,
  snapshot: () => Promise<HerdrSnapshot>,
  guard: OccupantGuard,
): Promise<void> {
  void cli;
  const s = await snapshot();
  const pane = s.panes.find((p) => p.id === guard.paneId);
  const occupant = pane?.occupant;
  const terminal = occupant?.terminalId ?? pane?.terminalId;
  if (
    !pane ||
    !occupant ||
    (guard.terminalId !== undefined && terminal !== guard.terminalId) ||
    (guard.sessionId !== undefined &&
      !piSessionMatches(
        guard.sessionId,
        occupant.sessionId,
        occupant.sessionReference,
      )) ||
    (guard.generation !== undefined && occupant.generation !== guard.generation)
  )
    throw new Error("HERDR_IDENTITY_MISMATCH");
}
export async function focus(
  cli: HerdrCli,
  snapshot: () => Promise<HerdrSnapshot>,
  guard: OccupantGuard,
) {
  await revalidateOccupant(cli, snapshot, guard);
  await cli.focusAgent(guard.paneId);
}
export async function interrupt(
  cli: HerdrCli,
  snapshot: () => Promise<HerdrSnapshot>,
  guard: OccupantGuard,
) {
  await revalidateOccupant(cli, snapshot, guard);
  await cli.interruptAgent(guard.paneId);
}
export async function close(
  cli: HerdrCli,
  snapshot: () => Promise<HerdrSnapshot>,
  guard: OccupantGuard,
) {
  await revalidateOccupant(cli, snapshot, guard);
  await cli.closePane(guard.paneId);
}
