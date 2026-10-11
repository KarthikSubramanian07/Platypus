/** Injectable time so holds, expiry and fixtures are deterministic in tests. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface ManualClock extends Clock {
  set(at: Date | string): void;
  advance(ms: number): void;
}

export function manualClock(start: Date | string = "2026-10-11T18:00:00.000Z"): ManualClock {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    set: (at) => {
      current = new Date(at).getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

export const iso = (clock: Clock): string => clock.now().toISOString();
