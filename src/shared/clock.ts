export interface TimerHandle {
  readonly ref?: () => TimerHandle;
  readonly unref?: () => TimerHandle;
}
export interface Clock {
  now(): Date;
  monotonicMs(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  monotonicMs(): number {
    return Number(process.hrtime.bigint()) / 1_000_000;
  }
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    return setTimeout(callback, delayMs);
  }
  clearTimeout(handle: TimerHandle): void {
    clearTimeout(handle as NodeJS.Timeout);
  }
}
export class FakeClock implements Clock {
  #time: number;
  #wall: number;
  constructor(start = 0, wall = Date.UTC(2026, 0, 1)) {
    this.#time = start;
    this.#wall = wall;
  }
  now(): Date {
    return new Date(this.#wall + this.#time);
  }
  monotonicMs(): number {
    return this.#time;
  }
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    return {
      unref: () => undefined,
      ref: () => undefined,
      callback,
      due: this.#time + delayMs,
    } as unknown as TimerHandle;
  }
  clearTimeout(_handle: TimerHandle): void {}
  advance(ms: number): void {
    this.#time += ms;
  }
}
