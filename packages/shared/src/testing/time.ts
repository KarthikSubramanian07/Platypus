/** Wall-clock helpers in a business's time zone, without a date library. */
function offsetMinutes(at: Date, timeZone: string): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(part ?? "");
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** The local calendar date (YYYY-MM-DD) of `at` in `timeZone`, shifted by `days`. */
export function localDate(at: Date, timeZone: string, days = 0): string {
  const shifted = new Date(at.getTime() + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(shifted);
}

/** The instant that reads `hour:minute` on `date` in `timeZone`. */
export function zonedTime(date: string, hour: number, minute: number, timeZone: string): Date {
  const guess = new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  const offset = offsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - offset * 60_000);
}

export function addMinutes(at: Date | string, minutes: number): Date {
  return new Date(new Date(at).getTime() + minutes * 60_000);
}
