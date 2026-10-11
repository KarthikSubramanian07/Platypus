/**
 * Business hours and slot generation in the business's own time zone.
 *
 * Hours are stored the way an owner says them: {"mon-fri": "08:00-18:00", "sat": "09:00-14:00"}.
 * Keys are a day, a range of days ("tue-sat", wrapping ranges like "fri-mon" work) or a
 * comma list ("mon,wed"); "daily" means every day. Values are one or more "HH:MM-HH:MM"
 * intervals separated by commas, or "closed". A more specific key wins over a broader one,
 * so {"mon-sat": "08:00-17:00", "sat": "09:00-14:00"} gives Saturday the short day.
 *
 * Every wall-clock time is converted to an instant with the zone's offset at that instant,
 * not at midnight, so slots stay correct across daylight-saving changes.
 */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Minutes after local midnight; close may be 1440 ("24:00"). */
export interface OpenInterval {
  open: number;
  close: number;
}

export type WeeklyHours = Record<Weekday, OpenInterval[]>;

const TIME = /^(\d{1,2}):(\d{2})$/;

function parseClock(value: string): number | undefined {
  const m = TIME.exec(value.trim());
  if (!m) return undefined;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return undefined;
  return hours * 60 + minutes;
}

function parseDays(key: string): Weekday[] {
  const k = key.trim().toLowerCase();
  if (k === "daily" || k === "every day" || k === "mon-sun") return [...WEEKDAYS];
  const days: Weekday[] = [];
  for (const part of k.split(",")) {
    const [from, to] = part.split("-").map((s) => s.trim().slice(0, 3)) as [string, string | undefined];
    const a = WEEKDAYS.indexOf(from as Weekday);
    if (a < 0) continue;
    if (to === undefined) {
      days.push(WEEKDAYS[a]!);
      continue;
    }
    const b = WEEKDAYS.indexOf(to as Weekday);
    if (b < 0) continue;
    for (let i = a; ; i = (i + 1) % 7) {
      days.push(WEEKDAYS[i]!);
      if (i === b) break;
    }
  }
  return days;
}

function parseIntervals(value: string): OpenInterval[] {
  if (/^\s*closed\s*$/i.test(value)) return [];
  const out: OpenInterval[] = [];
  for (const part of value.split(",")) {
    const [a, b] = part.split("-");
    const open = a === undefined ? undefined : parseClock(a);
    const close = b === undefined ? undefined : parseClock(b);
    if (open !== undefined && close !== undefined && open < close) out.push({ open, close });
  }
  return out.sort((x, y) => x.open - y.open);
}

/** Parses stored hours. Entries it cannot read are skipped rather than guessed at. */
export function parseBusinessHours(hours: Record<string, string>): WeeklyHours {
  const week = Object.fromEntries(WEEKDAYS.map((d) => [d, [] as OpenInterval[]])) as WeeklyHours;
  const entries = Object.entries(hours)
    .map(([key, value]) => ({ days: parseDays(key), intervals: parseIntervals(value) }))
    .filter((e) => e.days.length > 0)
    // Broad keys first, so narrower keys overwrite them.
    .sort((x, y) => y.days.length - x.days.length);
  for (const { days, intervals } of entries) for (const day of days) week[day] = intervals;
  return week;
}

// ---- Time-zone arithmetic without a date library ------------------------------

/** The zone's UTC offset in minutes at `at` (for example -420 for PDT). */
export function offsetMinutes(at: Date, timeZone: string): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(part ?? "");
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** The local calendar date (YYYY-MM-DD) of `at` in `timeZone`. */
export function localDateOf(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** YYYY-MM-DD plus `days`, as a calendar operation. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(js + 6) % 7]!;
}

/**
 * The instant that reads `minutes` after midnight on `date` in `timeZone`.
 * Two passes: the offset is re-read at the candidate instant, which fixes the
 * hours between midnight and a daylight-saving switch.
 */
export function zonedInstant(date: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, 0, minutes);
  const first = naive - offsetMinutes(new Date(naive), timeZone) * 60_000;
  const second = naive - offsetMinutes(new Date(first), timeZone) * 60_000;
  return new Date(second);
}

// ---- Slots --------------------------------------------------------------------

export interface SlotRequest {
  hours: Record<string, string>;
  timeZone: string;
  window: { start: string; end: string };
  durationMinutes: number;
  /** Nothing earlier than this is offered (normally the clock's now). */
  notBefore: Date;
  /** Returns true when [start, end) clashes with a hold or booking. */
  isBusy?: (start: Date, end: Date) => boolean;
  limit?: number;
  /** How far apart offered start times are. Defaults to the duration rounded up to 30 minutes, capped at 60. */
  stepMinutes?: number;
  /** Days scanned at most, so a huge window stays cheap. */
  maxDays?: number;
}

export interface GeneratedSlot {
  start: string;
  end: string;
}

const GRID_MINUTES = 30;

export function defaultStepMinutes(durationMinutes: number): number {
  return Math.min(60, Math.max(GRID_MINUTES, Math.ceil(durationMinutes / GRID_MINUTES) * GRID_MINUTES));
}

/**
 * Open start times inside the window, within business hours, long enough for the
 * service, not in the past and not busy. Start times sit on a 30-minute grid
 * counted from opening time, and are `stepMinutes` apart.
 */
export function generateSlots(req: SlotRequest): GeneratedSlot[] {
  const windowStart = new Date(req.window.start).getTime();
  const windowEnd = new Date(req.window.end).getTime();
  if (!(windowStart < windowEnd)) return [];
  const duration = Math.max(1, Math.round(req.durationMinutes)) * 60_000;
  const step = (req.stepMinutes ?? defaultStepMinutes(req.durationMinutes)) * 60_000;
  const grid = GRID_MINUTES * 60_000;
  const limit = req.limit ?? 8;
  const maxDays = req.maxDays ?? 14;
  const week = parseBusinessHours(req.hours);
  const lowerBound = Math.max(windowStart, req.notBefore.getTime());

  const slots: GeneratedSlot[] = [];
  // Start one day early: a window can begin late in the evening UTC of the previous local day.
  let date = addDays(localDateOf(new Date(windowStart), req.timeZone), -1);
  const lastDate = localDateOf(new Date(windowEnd), req.timeZone);
  for (let day = 0; day <= maxDays + 1 && date <= lastDate && slots.length < limit; day++, date = addDays(date, 1)) {
    for (const interval of week[weekdayOf(date)]) {
      const open = zonedInstant(date, interval.open, req.timeZone).getTime();
      const close = zonedInstant(date, interval.close, req.timeZone).getTime();
      const earliest = Math.max(open, lowerBound);
      let t = open + Math.ceil((earliest - open) / grid) * grid;
      for (; t + duration <= close && t + duration <= windowEnd && slots.length < limit; t += step) {
        const start = new Date(t);
        const end = new Date(t + duration);
        if (req.isBusy?.(start, end)) continue;
        slots.push({ start: start.toISOString(), end: end.toISOString() });
      }
    }
  }
  return slots;
}

/** "Mon Oct 12, 2:00 PM" in the business's zone, for sentences the voice agent reads aloud. */
export function speakableTime(at: string | Date, timeZone: string, withDay = true): string {
  const opts: Intl.DateTimeFormatOptions = withDay
    ? { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { timeZone, hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(at));
}
