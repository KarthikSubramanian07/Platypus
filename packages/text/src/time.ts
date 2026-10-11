import * as chrono from "chrono-node";

/**
 * Times in owner replies, resolved in the business's time zone.
 *
 * chrono-node 2.10 silently ignores IANA zone names in its reference, so we pass
 * the numeric UTC offset of the reference instant (computed with Intl). Owners
 * write "3" for 3pm: a bare hour 1-6 means pm and 7-11 means am unless they said
 * am/pm. A reply with a time but no day is about the day we offered, not today.
 */

/** UTC offset of `timeZone` at `at`, in minutes (America/Los_Angeles in October: -420). */
export function offsetMinutes(at: Date, timeZone: string): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(part ?? "");
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** The local calendar date (YYYY-MM-DD) of `at` in `timeZone`. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** ISO-8601 with the zone's offset for the wall-clock time `hour:minute` on `date` ("2026-10-13T15:00:00-07:00"). */
export function zonedIso(date: string, hour: number, minute: number, timeZone: string): string {
  const wall = `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  const guess = new Date(`${wall}Z`);
  let offset = offsetMinutes(guess, timeZone);
  // Re-check once at the corrected instant so DST boundaries resolve to the right offset.
  offset = offsetMinutes(new Date(guess.getTime() - offset * 60_000), timeZone);
  return `${wall}${formatOffset(offset)}`;
}

/** Wall-clock parts of an instant in a zone. */
export function localParts(at: Date | string, timeZone: string): { date: string; weekday: string; month: string; day: number; hour: number; minute: number } {
  const d = new Date(at);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: localDate(d, timeZone),
    weekday: parts.weekday ?? "",
    month: parts.month ?? "",
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** "10am", "9:30am", "12pm". */
export function formatClock(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${hour < 12 ? "am" : "pm"}`;
}

/** "Tue 10am" in the business's zone. */
export function formatShort(at: Date | string, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${p.weekday} ${formatClock(p.hour, p.minute)}`;
}

/** "Tue Oct 13, 10am" in the business's zone. */
export function formatLong(at: Date | string, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${p.weekday} ${p.month} ${p.day}, ${formatClock(p.hour, p.minute)}`;
}

/** chrono's casual English plus "10a" and "2p", which owners type and chrono does not know. */
const parser = chrono.casual.clone();
parser.parsers.push({
  pattern: () => /(?<![\w:$.])(\d{1,2})(?::([0-5]\d))?\s?([ap])(?![\w])/i,
  extract: (_context, match) => {
    const hour = Number(match[1]);
    if (hour < 1 || hour > 12) return null;
    const pm = match[3]!.toLowerCase() === "p";
    return {
      hour: (hour % 12) + (pm ? 12 : 0),
      minute: match[2] ? Number(match[2]) : 0,
      meridiem: pm ? chrono.Meridiem.PM : chrono.Meridiem.AM,
    };
  },
});

const DAY_WORD = String.raw`(?:today|tonight|tomorrow|tmrw|tmr|tom|(?:next |this )?(?:mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday))`;

/** "tomorrow 3" and "wed 9:30" become "tomorrow at 3" and "wed at 9:30", which chrono reads as one time. */
export function normalizeTimeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\btmrw\b|\btmr\b/g, "tomorrow")
    .replace(new RegExp(String.raw`\b(${DAY_WORD})\s+(\d{1,2}(?::\d{2})?(?:\s?[ap]m?)?)(?![\d/]|st|nd|rd|th)`, "g"), "$1 at $2")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TimeAnchor {
  /** The moment the reply arrived. */
  now: Date;
  /** The business's IANA zone. */
  timeZone: string;
  /** Local date (YYYY-MM-DD) of the slot we offered; a reply with a time and no day lands on it. */
  anchorDate?: string | null;
}

export interface ParsedTime {
  /** The words that named the time, after normalization ("tomorrow at 3"). */
  text: string;
  /** Local date the owner meant, YYYY-MM-DD. */
  date: string;
  /** True when the owner named an hour; false for a day alone ("wed"). */
  has_time: boolean;
  hour: number | null;
  minute: number | null;
  /** ISO-8601 with offset, only when an hour was named. */
  iso: string | null;
  index: number;
  length: number;
}

const NEGATION_BEFORE = /(?:\bcan'?t|\bcannot|\bcan not|\bnot|\bno|\bwon'?t|\bunable to|\bbooked)\s+(?:do\s+|make\s+|on\s+|be\s+there\s+|work\s+)?$/;

/** Every time in a reply, resolved; days the owner ruled out ("can't do tue") are dropped. */
export function parseTimes(text: string, anchor: TimeAnchor): ParsedTime[] {
  const normalized = normalizeTimeText(text);
  const reference = { instant: anchor.now, timezone: offsetMinutes(anchor.now, anchor.timeZone) };
  const results = parser.parse(normalized, reference, { forwardDate: true });
  const out: ParsedTime[] = [];
  for (const r of results) {
    const before = normalized.slice(Math.max(0, r.index - 24), r.index);
    if (NEGATION_BEFORE.test(before)) continue;
    if (/^(?:right )?now$/.test(r.text)) continue; // "from now on" is a rule, not a time
    const s = r.start;
    const dayNamed = s.isCertain("day") || s.isCertain("weekday");
    const hourNamed = s.isCertain("hour");
    if (!dayNamed && !hourNamed) continue; // "this week", "now-ish": not a time anyone can book
    let date: string;
    if (dayNamed) {
      date = `${s.get("year")}-${String(s.get("month")).padStart(2, "0")}-${String(s.get("day")).padStart(2, "0")}`;
    } else {
      date = anchor.anchorDate ?? localDate(anchor.now, anchor.timeZone);
    }
    let hour: number | null = null;
    let minute: number | null = null;
    if (hourNamed) {
      hour = s.get("hour") ?? 0;
      minute = s.get("minute") ?? 0;
      if (!s.isCertain("meridiem") && hour >= 1 && hour <= 6) hour += 12;
    }
    out.push({
      text: r.text,
      date,
      has_time: hourNamed,
      hour,
      minute,
      iso: hour === null ? null : zonedIso(date, hour, minute ?? 0, anchor.timeZone),
      index: r.index,
      length: r.text.length,
    });
  }
  return out;
}

/** Words around a time that do not change its meaning: "how about 2pm?", "3pm instead". */
const LEADING = /^(?:(?:how|what) about|can do|could do|i can do|maybe|or|try)\s+/;
const TRAILING = /\s+(?:instead|then|works|ok|okay|pls|please)$/;

/**
 * The time when it is the whole message, or null. "booked solid this week" and
 * "only weekdays from now on" contain parsable dates but are not counters.
 */
export function parseWholeTime(text: string, anchor: TimeAnchor): ParsedTime | null {
  let core = normalizeTimeText(text).replace(/[?!.,]+/g, " ").replace(/\s+/g, " ").trim();
  const led = LEADING.test(core);
  core = core.replace(LEADING, "").replace(TRAILING, "").trim();
  if (!core || /\bnow\b|\basap\b/.test(core)) return null;
  // "how about 4?" names an hour; a bare "4" with nothing around it stays ambiguous.
  if (led && /^\d{1,2}(?::\d{2})?$/.test(core)) core = `at ${core}`;
  const times = parseTimes(core, anchor);
  if (times.length !== 1) return null;
  const t = times[0]!;
  return t.index === 0 && t.length === core.length ? t : null;
}

/** Parses a time phrase the model extracted ("3pm", "10", "wed 9:30"), anchored like an owner reply. */
export function parseExtractedTime(phrase: string, anchor: TimeAnchor): ParsedTime | null {
  const cleaned = phrase.trim();
  const withAt = /^\d{1,2}(?::\d{2})?$/.test(cleaned) ? `at ${cleaned}` : cleaned;
  const times = parseTimes(withAt, anchor);
  return times.at(-1) ?? null;
}
