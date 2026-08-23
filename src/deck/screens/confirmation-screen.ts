import type { RenderedSurface } from "../screen-types.js";
import type { OverlayState } from "../overlay-screen.js";
import { SurfaceBuilder } from "../geometry.js";

export function renderConfirmationScreen(
  width: number,
  state: Extract<OverlayState, { kind: "confirm" }>,
  onCancel: () => void,
  onConfirm: () => void,
): RenderedSurface {
  const surface = new SurfaceBuilder(width);
  surface.addLine("CONFIRMATION");
  surface.addLine(state.summary);
  const guard = state.guard ?? {};
  surface.addLine(`Target: ${guard.targetId ?? guard.agentId ?? "unknown"}`);
  if (state.pending === true) surface.addLine("Pending…");
  if (state.error) surface.addLine(`! ${state.error}`);
  surface.addLine("");
  surface.addButtons([
    { id: "confirm:cancel", label: "Cancel", activate: onCancel },
    {
      id: "confirm:accept",
      label: state.pending === true ? "Pending…" : "Confirm",
      ...(state.pending === true ? { disabled: true } : {}),
      activate: onConfirm,
    },
  ]);
  return surface.finish();
}
