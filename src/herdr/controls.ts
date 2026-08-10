import type { HerdrCli } from "./cli.js";
import type { HerdrSnapshot } from "./types.js";
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
    (guard.sessionId !== undefined && occupant.sessionId !== guard.sessionId) ||
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
