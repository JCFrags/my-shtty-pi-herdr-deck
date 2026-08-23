import type { RenderedSurface } from "../screen-types.js";
import type { OverlayState } from "../overlay-screen.js";
import { MAX_OVERLAY_TEXT } from "../overlay-screen.js";
import { SurfaceBuilder } from "../geometry.js";

export interface TextInputScreenOptions {
  width: number;
  state: Extract<OverlayState, { kind: "text-input" }>;
  onCancel(): void;
  onSubmit(): void;
}

export function renderTextInputScreen(
  options: TextInputScreenOptions,
): RenderedSurface {
  const surface = new SurfaceBuilder(options.width);
  const { state } = options;
  surface.addLine(
    `${state.purpose.toUpperCase()}: ${state.value || "Enter"} submits · Escape cancels`,
  );
  surface.addLine(
    `${state.value.slice(0, MAX_OVERLAY_TEXT)}${state.pending === true ? "  (pending…)" : "█"}`,
  );
  if (state.purpose === "create") {
    surface.addLine(
      "Format: title|objective|profile|provider|model|thinking|lifecycle.",
    );
    surface.addLine("Lifecycle is temporary, reusable, retained, or pinned.");
  } else if (state.purpose === "default") {
    surface.addLine(
      "Format: scope|key|provider|model|thinking. The global key is empty.",
    );
  }
  if (state.error) surface.addLine(`! ${state.error}`);
  surface.addButtons([
    { id: "text-input:cancel", label: "Cancel", activate: options.onCancel },
    {
      id: "text-input:submit",
      label: "Submit",
      ...(state.pending === true ? { disabled: true } : {}),
      activate: options.onSubmit,
    },
  ]);
  return surface.finish();
}
