import type { PiSafeState } from "./types.js";
import { validateHeartbeatState } from "./registration.js";
export interface PiStateTransport {
  heartbeat(state: PiSafeState): Promise<unknown>;
}
export interface PiStateReporterOptions {
  heartbeatMs?: number;
  now?: () => number;
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onError?: (error: unknown) => void;
}
export type ReportOutcome = "sent" | "coalesced";
export class PiStateReporter {
  readonly heartbeatMs: number;
  #transport: PiStateTransport;
  #now: () => number;
  #setTimer: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  #clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  #inFlight = false;
  #pending: PiSafeState | undefined;
  #lastSentAt = Number.NEGATIVE_INFINITY;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #onError: (error: unknown) => void;
  constructor(
    transport: PiStateTransport,
    options: PiStateReporterOptions = {},
  ) {
    this.#transport = transport;
    this.heartbeatMs = options.heartbeatMs ?? 5_000;
    if (
      !Number.isSafeInteger(this.heartbeatMs) ||
      this.heartbeatMs < 0 ||
      this.heartbeatMs > 60_000
    )
      throw new Error("PI_HEARTBEAT_INTERVAL_INVALID");
    this.#now = options.now ?? Date.now;
    this.#setTimer =
      options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.#onError = options.onError ?? (() => undefined);
  }
  get pending(): boolean {
    return this.#pending !== undefined || this.#inFlight;
  }
  report(state: PiSafeState): ReportOutcome {
    this.#pending = validateHeartbeatState(state);
    if (this.#inFlight) return "coalesced";
    const delay = Math.max(
      0,
      this.#lastSentAt + this.heartbeatMs - this.#now(),
    );
    if (delay > 0) {
      this.#schedule(delay);
      return "coalesced";
    }
    void this.#drain();
    return "sent";
  }
  dispose(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    this.#pending = undefined;
  }
  #schedule(delay: number): void {
    if (this.#timer !== undefined) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      void this.#drain();
    }, delay);
  }
  async #drain(): Promise<void> {
    if (this.#inFlight || this.#pending === undefined) return;
    const state = this.#pending;
    this.#pending = undefined;
    this.#inFlight = true;
    try {
      await this.#transport.heartbeat(state);
      this.#lastSentAt = this.#now();
    } catch (error) {
      this.#onError(error);
    } finally {
      this.#inFlight = false;
      if (this.#pending !== undefined) {
        const delay = Math.max(
          0,
          this.#lastSentAt + this.heartbeatMs - this.#now(),
        );
        if (delay > 0) this.#schedule(delay);
        else void this.#drain();
      }
    }
  }
}
export function createStateReporter(
  transport: PiStateTransport,
  options?: PiStateReporterOptions,
): PiStateReporter {
  return new PiStateReporter(transport, options);
}
