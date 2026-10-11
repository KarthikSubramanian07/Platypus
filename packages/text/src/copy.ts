import type { Booking } from "@platypus/shared/db";
import { sanitizeUntrustedText } from "@platypus/shared/safety";
import type { ReactionKind } from "./classify";
import { formatCents } from "./money";
import { formatClock, formatLong, formatShort, localParts, type ParsedTime } from "./time";

/**
 * Every word Platypus texts an owner (spec B.7: texts are the product). Each one is
 * plain, specific, answerable with one word, and under 300 characters. Fields that
 * came from an agent (service, details, requester) are untrusted: links are
 * stripped, whitespace collapsed and lengths capped before they reach a phone.
 *
 * "cancel" is an opt-out word, so no copy ever says "Reply UNDO to cancel".
 */

export const MAX_TEXT_LENGTH = 300;

export const STOP_COPY = "You're unlisted and won't get more texts from Platypus. Text JOIN anytime to come back.";
export const HELP_COPY = "Platypus: AI-assisted job requests for your shop. Reply STOP to opt out, PAUSE to pause. Msg&data rates may apply.";
export const RESUME_COPY = "You're back on Platypus texts. Reply STOP to opt out, HELP for help.";
export const NOTHING_TO_UNDO_COPY = "Nothing to undo from the last 24 hours.";
export const NO_OPEN_JOB_COPY = "Thanks! There's no open job right now. We'll text you when one comes in.";

export function pauseCopy(days: number | null): string {
  return days
    ? `Paused for ${days} day${days === 1 ? "" : "s"}. Platypus won't text you new jobs until then. Text RESUME to come back sooner.`
    : "Paused. Platypus won't text you new jobs until you text RESUME.";
}

const field = (text: string, max: number) => sanitizeUntrustedText(text, max).replace(/[.\s]+$/, "");

type BookingFields = Pick<Booking, "service" | "details" | "requested_by" | "slot_start" | "window_start" | "window_end" | "short_code">;

/** "Tue 10am" for a held slot; "Tue 12pm-5pm" or "Tue-Thu, Oct 13-15" for a window. */
export function whenLabel(booking: Pick<Booking, "slot_start" | "window_start" | "window_end">, timeZone: string): string {
  if (booking.slot_start) return formatShort(booking.slot_start, timeZone);
  if (!booking.window_start) return "time flexible";
  const s = localParts(booking.window_start, timeZone);
  if (!booking.window_end) return `from ${formatShort(booking.window_start, timeZone)}`;
  const e = localParts(booking.window_end, timeZone);
  if (s.date === e.date) return `${s.weekday} ${formatClock(s.hour, s.minute)}-${formatClock(e.hour, e.minute)}`;
  return s.month === e.month ? `${s.weekday}-${e.weekday}, ${s.month} ${s.day}-${e.day}` : `${s.weekday} ${s.month} ${s.day}-${e.weekday} ${e.month} ${e.day}`;
}

/**
 * The request itself (spec B.7): "New job via Platypus (AI-assisted): brake inspection,
 * Tue 10am, 2019 Civic. From Alex's assistant. Reply Y, N, or a time."
 */
export function composeBookingRequest(booking: BookingFields, timeZone: string): string {
  const when = whenLabel(booking, timeZone);
  const from = booking.requested_by ? field(booking.requested_by, 40) : "a customer's AI assistant";
  const build = (serviceMax: number, detailsMax: number) => {
    const service = field(booking.service, serviceMax) || "a job";
    const details = booking.details && detailsMax > 0 ? field(booking.details, detailsMax) : "";
    return `New job via Platypus (AI-assisted): ${service}, ${when}${details ? `, ${details}` : ""}. From ${from}. Reply Y, N, or a time.`;
  };
  for (const [s, d] of [[80, 80], [60, 40], [40, 0], [24, 0]] as const) {
    const body = build(s, d);
    if (body.length < MAX_TEXT_LENGTH) return body;
  }
  return build(16, 0).slice(0, MAX_TEXT_LENGTH - 1);
}

/** The one-line question when a reply is unclear: "Just to confirm: brake inspection Tue Oct 13, 10am? Reply Y or N." */
export function composeConfirmPrompt(booking: BookingFields, timeZone: string): string {
  const service = field(booking.service, 60) || "the job";
  if (booking.slot_start) return `Just to confirm: ${service} ${formatLong(booking.slot_start, timeZone)}? Reply Y or N.`;
  return `Just to confirm: can you take the ${service}, ${whenLabel(booking, timeZone)}? Reply Y or N.`;
}

const REACTION_EMOJI: Partial<Record<ReactionKind, string>> = { like: "👍", love: "❤️", emphasize: "‼️" };

/** A Tapback never books: "Got your 👍. Reply Y to confirm brake inspection Tue 10am." */
export function composeReactionPrompt(booking: BookingFields, timeZone: string, reaction: ReactionKind): string {
  const service = field(booking.service, 60) || "the job";
  const emoji = REACTION_EMOJI[reaction];
  return `${emoji ? `Got your ${emoji}. ` : ""}Reply Y to confirm ${service} ${whenLabel(booking, timeZone)}, or N to pass.`;
}

/** After a confirmed yes: what was booked, its reference, and how to reverse it. */
export function composeReceipt(booking: BookingFields, timeZone: string): string {
  return `Booked: ${field(booking.service, 60) || "job"}, ${whenLabel(booking, timeZone)}. Ref ${booking.short_code}. Reply UNDO to reverse it.`;
}

export function composeUndone(booking: BookingFields, timeZone: string): string {
  return `Undone: ${field(booking.service, 60) || "the job"}, ${whenLabel(booking, timeZone)} is cancelled. Ref ${booking.short_code}.`;
}

export const DECLINE_ACK_COPY = "Got it, we'll let them know. Thanks!";

/** After a counter: "Thanks. We'll offer Wed 9:30am for $300 to the customer and text you back." */
export function composeCounterAck(time: ParsedTime | null, priceCents: number | null | undefined, timeZone: string): string {
  const parts: string[] = [];
  if (time?.iso) parts.push(formatShort(time.iso, timeZone));
  else if (time) parts.push(localParts(`${time.date}T12:00:00Z`, "UTC").weekday);
  if (typeof priceCents === "number") parts.push(`${parts.length ? "for " : ""}${formatCents(priceCents)}`);
  return `Thanks. We'll offer ${parts.join(" ") || "that"} to the customer and text you back.`;
}

export function composeNoted(booking: BookingFields | null, timeZone: string): string {
  return booking ? `Noted, thanks. For the ${field(booking.service, 60) || "open job"} ${whenLabel(booking, timeZone)}, reply Y or N.` : "Noted, thanks.";
}
