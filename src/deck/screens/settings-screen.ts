import type { RenderedSurface } from "../screen-types.js";
import { SurfaceBuilder } from "../geometry.js";

export interface SettingsScreenOptions {
  width: number;
  scroll: number;
  content: readonly string[];
  onDefault(): void;
  onAutoClose(): void;
  onClose(): void;
}

export function renderSettingsScreen(
  options: SettingsScreenOptions,
): RenderedSurface {
  const surface = new SurfaceBuilder(options.width);
  surface.addLine("SETTINGS  Escape or , closes");
  surface.addLine("");
  surface.addButtons([
    {
      id: "settings:default",
      label: "Set model default",
      activate: options.onDefault,
    },
    {
      id: "settings:auto-close",
      label: "Toggle auto-close",
      activate: options.onAutoClose,
    },
    { id: "settings:close", label: "Close", activate: options.onClose },
  ]);
  surface.addLine("");
  const content = options.content;
  const start = Math.max(
    0,
    Math.min(options.scroll, Math.max(0, content.length - 1)),
  );
  for (const line of content.slice(start)) surface.addLine(line);
  return surface.finish();
}
