/**
 * Wall-clock helpers in a business's time zone, on Intl alone. The voice agent
 * gets times with the business's local offset ("2026-10-12T14:00:00-07:00"), not
 * UTC, because a model converting zones mid-call is a model getting it wrong.
 */

export interface LocalParts {
  date: string; // YYYY-MM-DD
  hour: number;
  minute: number;
  weekday: string; // Monday
}

export function localParts(at: Date, timeZone: string): LocalParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "long",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday ?? "",
  };
}

/** Minutes east of UTC for `timeZone` at `at` (-420 for PDT). */
export function offsetMinutes(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name ?? "");
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** "-07:00" */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** The instant that reads `hour:minute` on local `date` in `timeZone`. */
export function zonedInstant(date: string, hour: number, minute: number, timeZone: string): Date {
  const guess = new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  let instant = new Date(guess.getTime() - offsetMinutes(guess, timeZone) * 60_000);
  // Second pass settles instants near a DST switch.
  instant = new Date(guess.getTime() - offsetMinutes(instant, timeZone) * 60_000);
  return instant;
}

/** ISO-8601 with the local offset: 2026-10-12T12:00:00-07:00. */
export function localIso(at: Date, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${p.date}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:00${formatOffset(offsetMinutes(at, timeZone))}`;
}

function dayDiff(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T12:00:00Z`) - Date.parse(`${fromDate}T12:00:00Z`)) / 86_400_000);
}

/**
 * How a person says a window: "tomorrow afternoon", "today", "Thursday morning".
 * Returns the day words on their own too, capitalised for the start of a sentence.
 */
export function describeWindow(startIso: string, endIso: string, now: Date, timeZone: string): { windowWords: string; dayWords: string } {
  const start = localParts(new Date(startIso), timeZone);
  const end = localParts(new Date(endIso), timeZone);
  const diff = dayDiff(localParts(now, timeZone).date, start.date);
  const day =
    diff === 0
      ? "today"
      : diff === 1
        ? "tomorrow"
        : diff > 1 && diff < 7
          ? start.weekday
          : new Intl.DateTimeFormat("en-US", { timeZone, month: "long", day: "numeric" }).format(new Date(startIso));
  const endHour = end.date === start.date ? end.hour + end.minute / 60 : 24;
  let part = "";
  if (start.hour >= 17) part = "evening";
  else if (start.hour >= 12 && endHour <= 18) part = "afternoon";
  else if (endHour <= 12.01) part = "morning";
  const farDate = !(diff >= 0 && diff < 7);
  let windowWords: string;
  if (farDate) windowWords = `on ${day}${part ? ` in the ${part}` : ""}`;
  else if (day === "today" && part) windowWords = `this ${part}`;
  else windowWords = part ? `${day} ${part}` : day;
  const dayWords = farDate ? `On ${day}` : day.charAt(0).toUpperCase() + day.slice(1);
  return { windowWords, dayWords };
}
