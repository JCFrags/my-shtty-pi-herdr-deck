import type { RenderedSurface } from "../screen-types.js";
import { SurfaceBuilder } from "../geometry.js";

export function renderHelpScreen(
  width: number,
  onClose: () => void,
): RenderedSurface {
  const surface = new SurfaceBuilder(width);
  surface.addLine("HELP  Escape or ? closes");
  surface.addLine("1 Board  2 Files  3 Agents  4 Activity");
  surface.addLine(
    "Board combines current work, questions, Signals updates, and recommendations.",
  );
  surface.addLine(
    "Files: row previews; caret expands; checkbox selects; each pane scrolls independently.",
  );
  surface.addLine(
    "Agents: f focus, p prompt, a ask, i interrupt, s stop, x close.",
  );
  surface.addLine(
    "Activity contains results, decisions, updates, groups, tasks, and lifecycle history.",
  );
  surface.addButtons([{ id: "help:close", label: "Close", activate: onClose }]);
  return surface.finish();
}
