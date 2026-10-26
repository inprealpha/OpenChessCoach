// Time comes from a Clock so tests and verify mode can use a fake one.
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private current: number;
  constructor(start: Date | string = '2026-01-01T12:00:00.000Z') {
    this.current = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  set(to: Date | string): void {
    this.current = new Date(to).getTime();
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export function iso(clock: Clock): string {
  return clock.now().toISOString();
}
