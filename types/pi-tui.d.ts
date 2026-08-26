declare module "@earendil-works/pi-tui" {
  export type MouseButton = "left" | "middle" | "right";
  export type TuiMouseEvent =
    | {
        type: "press" | "release" | "move";
        button: MouseButton;
        x: number;
        y: number;
        shift: boolean;
        alt: boolean;
        ctrl: boolean;
      }
    | {
        type: "wheel";
        direction: "up" | "down";
        x: number;
        y: number;
        shift: boolean;
        alt: boolean;
        ctrl: boolean;
      };

  export interface Component {
    render(width: number): string[];
    handleInput?(data: string): void;
    handleMouse?(event: TuiMouseEvent): boolean;
    invalidate(): void;
  }

  export interface Terminal {
    start(onInput: (data: string) => void, onResize: () => void): void;
    stop(): void;
    write(data: string): void;
    readonly columns: number;
    readonly rows: number;
    readonly kittyProtocolActive: boolean;
    moveBy(lines: number): void;
    hideCursor(): void;
    showCursor(): void;
    clearLine(): void;
    clearFromCursor(): void;
    clearScreen(): void;
    setTitle(title: string): void;
    setProgress(active: boolean): void;
    setMouseTracking?(enabled: boolean): void;
    drainInput(maxMs?: number, idleMs?: number): Promise<void>;
  }

  export interface SettingItem {
    id: string;
    label: string;
    description?: string;
    currentValue: string;
    values?: string[];
    submenu?: (
      currentValue: string,
      done: (selectedValue?: string) => void,
    ) => Component;
  }

  export interface SettingsListTheme {
    label(text: string, selected: boolean): string;
    value(text: string, selected: boolean): string;
    description(text: string): string;
    cursor: string;
    hint(text: string): string;
  }

  export class SettingsList implements Component {
    constructor(
      items: SettingItem[],
      maxVisible: number,
      theme: SettingsListTheme,
      onChange: (id: string, newValue: string) => void,
      onCancel: () => void,
      options?: { enableSearch?: boolean },
    );
    updateValue(id: string, newValue: string): void;
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
  }

  export class Container implements Component {
    addChild(component: Component): void;
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
  }

  export class Text implements Component {
    constructor(text: string, paddingX?: number, paddingY?: number);
    render(width: number): string[];
    invalidate(): void;
  }

  export class ProcessTerminal implements Terminal {
    start(onInput: (data: string) => void, onResize: () => void): void;
    stop(): void;
    write(data: string): void;
    readonly columns: number;
    readonly rows: number;
    readonly kittyProtocolActive: boolean;
    moveBy(lines: number): void;
    hideCursor(): void;
    showCursor(): void;
    clearLine(): void;
    clearFromCursor(): void;
    clearScreen(): void;
    setTitle(title: string): void;
    setProgress(active: boolean): void;
    setMouseTracking?(enabled: boolean): void;
    drainInput(maxMs?: number, idleMs?: number): Promise<void>;
  }

  export class TUI {
    constructor(terminal: Terminal, showHardwareCursor?: boolean);
    addChild(component: Component): void;
    removeChild(component: Component): void;
    setFocus(component: Component | null): void;
    setMouseTracking(enabled: boolean): void;
    start(): void;
    stop(): void;
    requestRender(force?: boolean): void;
  }

  export function parseMouseInput(data: string): TuiMouseEvent | undefined;
  export function matchesKey(data: string, key: string): boolean;
  export const Key: Record<string, string>;
  export function visibleWidth(text: string): number;
  export function truncateToWidth(text: string, width: number): string;
}

declare module "@pi-herdr-deck/tui" {
  export * from "@earendil-works/pi-tui";
}
