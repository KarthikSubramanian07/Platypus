import { maskNumber } from "@platypus/shared/config";
import { getActiveConsent, getRow, insertRow, selectRows, updateRow, type Booking, type Business, type Message } from "@platypus/shared/db";
import { composeBookingRequest } from "./copy";
import { latestEvents, newId, now, numberRef, record, type TextDeps } from "./deps";
import { assertSendable, LookupUnavailableError, type DialSendChannel, type NumberSupports } from "./dial-messaging";

/**
 * Outbound texts on TEXT_CHANNEL. Every send passes the same gates, in order:
 * consent on record, the business not paused or unlisted, a number that can
 * receive on the rail (Dial lookup, cached in the event log for 24 hours), then
 * ALLOWED_NUMBERS and the sms rule immediately before the request. Dial's
 * POST /messages is not idempotent, so nothing here ever retries blind.
 */

export type Rail = TextDeps["textChannel"];
export type MessageKind = "booking_request" | "clarify" | "receipt" | "ack" | "stop_confirmation" | "help" | "pause" | "resume" | "undo";

export type SendBookingResult = { message_id: string } | { needs_call: true; reason: string };

/** Lookup failed transiently (502/429). The booking stays pending; ask again later rather than guess. */
export class RoutingUnavailableError extends Error {
  constructor(public readonly retryAfterMs: number | null) {
    super("Dial lookup is unavailable right now; the request was not sent. Try again shortly.");
    this.name = "RoutingUnavailableError";
  }
}

const DAY_MS = 86_400_000;

/** Kept separate so a test can assert the exact Dial channel each rail maps to. */
export function dialChannelFor(rail: Rail): DialSendChannel {
  return rail === "dial" ? "sms" : rail;
}

export function railFor(deps: TextDeps, business: Business): Rail {
  return business.channel_pref ?? deps.textChannel;
}

/** The latest lookup verdict for this number from the event log, if fresher than the max age. */
function cachedSupports(deps: TextDeps, business: Business, number: string): NumberSupports | null {
  const ref = numberRef(number);
  const maxAge = deps.lookupMaxAgeMs ?? DAY_MS;
  for (const e of latestEvents(deps, "routing.lookup", { business_id: business.id })) {
    if (e.payload.number_ref !== ref) continue;
    if (now(deps).getTime() - new Date(e.created_at).getTime() > maxAge) return null;
    return e.payload.supports as NumberSupports;
  }
  return null;
}

/** Dial lookup, recorded as a routing.lookup event (masked number, hashed ref, supports). */
export async function lookupNumber(deps: TextDeps, business: Business, number: string): Promise<NumberSupports> {
  const cached = cachedSupports(deps, business, number);
  if (cached) return cached;
  let supports: NumberSupports;
  try {
    supports = await deps.messaging.lookup(number);
  } catch (error) {
    if (error instanceof LookupUnavailableError) {
      record(deps, {
        type: "routing.lookup_failed",
        actor: "system",
        refs: { business_id: business.id },
        payload: { number_masked: maskNumber(number), number_ref: numberRef(number), status: error.status, retry_after_ms: error.retryAfterMs },
        reason: "Dial could not complete the lookup; nothing is implied about the number",
      });
      throw new RoutingUnavailableError(error.retryAfterMs);
    }
    throw error;
  }
  record(deps, {
    type: "routing.lookup",
    actor: "system",
    refs: { business_id: business.id },
    payload: { number_masked: maskNumber(number), number_ref: numberRef(number), supports },
    reason: "checked what the number can receive before texting it",
  });
  return supports;
}

export type RouteDecision = { ok: true; to: string; rail: Rail; channel: DialSendChannel } | { ok: false; reason: string };

/**
 * Can this number receive on the business's rail?
 *  - imessage / whatsapp: only when lookup says so. An iMessage line silently falls back to SMS
 *    for a non-iMessage recipient, which would break the no-sms rule, so "unknown" is "no".
 *    An inbound message that arrived on the rail is fresh proof and skips the lookup.
 *  - dial: "sms" only to a number that is itself on Dial.
 */
export async function routeNumber(deps: TextDeps, business: Business, number: string, evidence?: { inboundChannel?: string | null }): Promise<RouteDecision> {
  const rail = railFor(deps, business);
  if (rail === "dial") {
    if (!(deps.dialNumbers ?? []).includes(number)) return { ok: false, reason: `${maskNumber(number)} is not a Dial number, and sms to other numbers needs 10DLC` };
    return { ok: true, to: number, rail, channel: "sms" };
  }
  if (evidence?.inboundChannel === rail) return { ok: true, to: number, rail, channel: rail };
  const supports = await lookupNumber(deps, business, number);
  if (!supports[rail]) return { ok: false, reason: `${maskNumber(number)} cannot receive ${rail}` };
  return { ok: true, to: number, rail, channel: rail };
}

/** The texting cell from the call first, then the listed line. */
export function candidateNumbers(business: Business): string[] {
  return [...new Set([business.text_number_e164, business.phone_e164].filter((n): n is string => Boolean(n)))];
}

/** A PAUSE with a duration ends on its own; the next send checks and resumes. */
export function resumeIfPauseElapsed(deps: TextDeps, business: Business): Business {
  if (business.channel_state !== "paused") return business;
  const pause = latestEvents(deps, "business.channel_changed", { business_id: business.id }).find((e) => e.payload.to === "paused");
  const resumeAt = pause?.payload.resume_at as string | null | undefined;
  if (!resumeAt || new Date(resumeAt).getTime() > now(deps).getTime()) return business;
  const updated = updateRow(deps.db, "businesses", business.id, { channel_state: "text_enabled", updated_at: now(deps).toISOString() });
  record(deps, {
    type: "business.channel_changed",
    actor: "system",
    refs: { business_id: business.id },
    payload: { from: "paused", to: "text_enabled", rail: railFor(deps, business) },
    reason: "the owner's pause ran out",
  });
  return updated;
}

export interface DeliverInput {
  business: Business;
  to: string;
  rail: Rail;
  channel: DialSendChannel;
  body: string;
  kind: MessageKind;
  booking_id?: string | null;
  reason: string;
}

/**
 * The one place a text leaves Platypus. Re-checks ALLOWED_NUMBERS and the sms rule,
 * sends once, stores the row with Dial's message id, and emits message.sent. A failed
 * send is recorded as message.send_failed and rethrown, never retried here.
 */
export async function deliver(deps: TextDeps, input: DeliverInput): Promise<Message> {
  const refs = { business_id: input.business.id, ...(input.booking_id ? { booking_id: input.booking_id } : {}) };
  if (input.body.length >= 300) throw new Error(`Refusing to send ${input.body.length} characters; owner texts stay under 300`);
  assertSendable(input.to, input.channel, { allowedNumbers: deps.allowedNumbers, dialNumbers: deps.dialNumbers ?? [] });
  const attemptedAt = now(deps).toISOString();
  let sent: { id: string; from?: string };
  try {
    sent = await deps.messaging.sendMessage({ to: input.to, body: input.body, channel: input.channel });
  } catch (error) {
    record(deps, {
      type: "message.send_failed",
      actor: "system",
      refs,
      payload: { kind: input.kind, channel: input.rail, body: input.body, number_ref: numberRef(input.to), attempted_at: attemptedAt, error: (error as Error).name, detail: (error as Error).message },
      reason: "Dial did not confirm the send; it is not retried automatically",
    });
    throw error;
  }
  return storeOutbound(deps, input, sent, false);
}

function storeOutbound(deps: TextDeps, input: DeliverInput, sent: { id: string; from?: string }, reconciled: boolean): Message {
  const at = now(deps);
  const message = insertRow(deps.db, "messages", {
    id: newId("message", at.getTime()),
    business_id: input.business.id,
    booking_id: input.booking_id ?? null,
    direction: "outbound",
    channel: input.rail,
    from_e164: deps.ourNumber ?? sent.from ?? "",
    to_e164: input.to,
    body: input.body,
    provider_message_id: sent.id,
    status: "sent",
    reply_class: null,
    classification: null,
    created_at: at.toISOString(),
  });
  record(deps, {
    type: "message.sent",
    actor: "system",
    refs: { message_id: message.id, business_id: input.business.id, ...(input.booking_id ? { booking_id: input.booking_id } : {}) },
    payload: { channel: input.rail, body: input.body, kind: input.kind, ...(reconciled ? { reconciled: true } : {}) },
    reason: input.reason,
  });
  return message;
}

function needsCall(deps: TextDeps, business: Business, booking: Booking, reason: string, extra: Record<string, unknown> = {}): { needs_call: true; reason: string } {
  record(deps, {
    type: "routing.needs_call",
    actor: "system",
    refs: { business_id: business.id, booking_id: booking.id },
    payload: { rail: railFor(deps, business), reason, ...extra },
    reason,
  });
  return { needs_call: true, reason };
}

/** The booking request already sent for this booking, if any (sendBookingRequest is idempotent per booking). */
export function existingRequest(deps: TextDeps, bookingId: string): Message | undefined {
  const sentIds = new Set(
    latestEvents(deps, "message.sent", { booking_id: bookingId })
      .filter((e) => e.payload.kind === "booking_request")
      .map((e) => e.message_id),
  );
  return selectRows(deps.db, "messages", "booking_id = ? AND direction = 'outbound'", [bookingId], "created_at DESC").find((m) => sentIds.has(m.id));
}

/** Consent and channel state, the gates before anything is sent unprompted. */
export function textingBlockedReason(deps: TextDeps, business: Business): string | null {
  if (!getActiveConsent(deps.db, business.id)) return "no text consent on record";
  if (business.channel_state === "unlisted") return "the owner opted out of texts (STOP)";
  if (business.channel_state === "paused") return "the owner paused texts";
  if (business.channel_state !== "text_enabled") return `the business is ${business.channel_state}`;
  return null;
}

/**
 * OwnerChannels.sendBookingRequest (contracts/seams.ts): text an opted-in owner the
 * request, or say why a call is needed instead. Calling it twice for one booking
 * returns the first message rather than texting the owner twice.
 */
export async function sendBookingRequest(deps: TextDeps, input: { booking_id: string; business_id: string }): Promise<SendBookingResult> {
  const booking = getRow(deps.db, "bookings", input.booking_id);
  if (!booking) throw new Error(`Booking not found: ${input.booking_id}`);
  if (booking.business_id !== input.business_id) throw new Error("The booking belongs to a different business");
  let business = getRow(deps.db, "businesses", input.business_id);
  if (!business) throw new Error(`Business not found: ${input.business_id}`);

  const already = existingRequest(deps, booking.id);
  if (already) return { message_id: already.id };
  if (booking.status !== "pending") throw new Error(`Booking ${booking.short_code} is ${booking.status}, not pending; nothing to ask the owner`);

  business = resumeIfPauseElapsed(deps, business);
  const blocked = textingBlockedReason(deps, business);
  if (blocked) return needsCall(deps, business, booking, blocked);

  const reasons: string[] = [];
  for (const number of candidateNumbers(business)) {
    const route = await routeNumber(deps, business, number);
    if (!route.ok) {
      reasons.push(route.reason);
      continue;
    }
    const body = composeBookingRequest(booking, business.timezone);
    const message = await deliver(deps, {
      business,
      to: route.to,
      rail: route.rail,
      channel: route.channel,
      body,
      kind: "booking_request",
      booking_id: booking.id,
      reason: "owner opted in to texts",
    });
    return { message_id: message.id };
  }
  return needsCall(deps, business, booking, `no number for this business can receive ${railFor(deps, business)}`, { tried: reasons });
}

export type ResendResult = { status: "resent"; message_id: string } | { status: "already_sent"; message_id: string } | { needs_call: true; reason: string };

/**
 * "Resend last text" without ever sending twice by accident. Before any second POST
 * it asks Dial (GET /messages) whether the last attempt actually went out:
 *  - the last attempt failed but Dial has it: record it and stop (already_sent);
 *  - the last attempt succeeded and Dial has it: stop, unless `force` (an explicit resend);
 *  - otherwise: send again.
 */
export async function resendLast(deps: TextDeps, bookingId: string, options: { force?: boolean } = {}): Promise<ResendResult> {
  const booking = getRow(deps.db, "bookings", bookingId);
  if (!booking) throw new Error(`Booking not found: ${bookingId}`);
  const business = getRow(deps.db, "businesses", booking.business_id)!;
  const attempts = [...latestEvents(deps, "message.sent", { booking_id: bookingId }), ...latestEvents(deps, "message.send_failed", { booking_id: bookingId })]
    .filter((e) => e.payload.kind === "booking_request")
    .sort((a, b) => (a.id < b.id ? 1 : -1));
  const last = attempts[0];
  if (!last) throw new Error(`Nothing has been sent for booking ${booking.short_code}`);

  const blocked = textingBlockedReason(deps, business);
  if (blocked) return needsCall(deps, business, booking, blocked);

  const body = last.payload.body as string;
  const lastRow = last.type === "message.sent" && last.message_id ? getRow(deps.db, "messages", last.message_id) : undefined;
  const to = lastRow?.to_e164 ?? candidateNumbers(business).find((n) => numberRef(n) === last.payload.number_ref);
  if (!to) return needsCall(deps, business, booking, "the number the request went to is no longer on file");

  const attemptedAt = (last.payload.attempted_at as string | undefined) ?? last.created_at;
  const since = new Date(new Date(attemptedAt).getTime() - 60_000).toISOString();
  const outbox = await deps.messaging.listMessages({ contact: to, direction: "outbound", since });
  const match = outbox.find((m) => m.body === body);
  const route = await routeNumber(deps, business, to);
  if (!route.ok) return needsCall(deps, business, booking, route.reason);
  const base = { business, to, rail: route.rail, channel: route.channel, body, kind: "booking_request" as const, booking_id: booking.id };

  if (match && !lastRow) {
    const existing = selectRows(deps.db, "messages", "provider_message_id = ?", [match.id])[0];
    const row = existing ?? storeOutbound(deps, { ...base, reason: "Dial confirms the earlier attempt went out" }, { id: match.id, from: match.from }, true);
    return { status: "already_sent", message_id: row.id };
  }
  if (match && lastRow && !options.force) return { status: "already_sent", message_id: lastRow.id };
  const message = await deliver(deps, { ...base, reason: lastRow ? "resent on request" : "the earlier attempt never reached Dial" });
  return { status: "resent", message_id: message.id };
}
