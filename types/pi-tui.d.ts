declare module "@earendil-works/pi-tui" {
  export type MouseButton = "left" | "middle" | "right";
  export type TuiMouseEvent =
    | { type: "press" | "release" | "move"; button: MouseButton; x: number; y: number; shift: boolean; alt: boolean; ctrl: boolean }
    | { type: "wheel"; direction: "up" | "down"; x: number; y: number; shift: boolean; alt: boolean; ctrl: boolean };

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
