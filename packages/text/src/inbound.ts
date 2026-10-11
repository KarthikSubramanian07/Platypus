import { BookingError, confirm, getBookingByShortCode, transition } from "@platypus/shared/booking";
import type { TextInbound } from "@platypus/shared/contracts";
import {
  getActiveConsent,
  getBusinessByNumber,
  getMessageByProviderId,
  getRow,
  insertRow,
  selectRows,
  updateRow,
  type Booking,
  type Business,
  type Message,
} from "@platypus/shared/db";
import { sanitizeUntrustedText } from "@platypus/shared/safety";
import { classifyReply, type ClassifyResult, type ReplyingTo } from "./classify";
import {
  composeConfirmPrompt,
  composeCounterAck,
  composeNoted,
  composeReactionPrompt,
  composeReceipt,
  composeUndone,
  DECLINE_ACK_COPY,
  HELP_COPY,
  NO_OPEN_JOB_COPY,
  NOTHING_TO_UNDO_COPY,
  pauseCopy,
  RESUME_COPY,
  STOP_COPY,
} from "./copy";
import { bookingCtx, latestEvents, newId, now, record, type TextDeps } from "./deps";
import { deliver, railFor, routeNumber, textingBlockedReason, type MessageKind } from "./outbound";
import { toE164 } from "./phone";

/**
 * Inbound owner texts, from the webhook or the events stream (both land here).
 *
 *  1. Deduplicate on Dial's message id: messages.provider_message_id is UNIQUE, so
 *     two deliveries racing each other store one row and act once.
 *  2. Store the message and emit message.received.
 *  3. Keywords first (STOP, HELP, PAUSE, UNDO, JOIN), with no model anywhere near them.
 *  4. Otherwise classify against the booking the owner is answering, and act:
 *     accept confirms with text evidence, decline and counter move the booking,
 *     anything unclear gets a one-line question (twice at most, then a person).
 */

export interface InboundInput extends TextInbound {
  /** Dial's `reaction` (a Tapback emoji) when the message is a reaction. */
  reaction?: string | null;
  /** Dial's `replyToId`: the message this one replies or reacts to. */
  reply_to_id?: string | null;
  /** Dial's raw channel ("imessage", "rcs", "unknown", ...), used as proof of what the number can receive. */
  dial_channel?: string | null;
}

export type InboundOutcome =
  | { status: "duplicate" }
  | { status: "unknown_sender"; message_id: string }
  | { status: "processed"; message_id: string; business_id: string; booking_id: string | null; result: ClassifyResult; action: string };

/** After this many clarifying questions about one booking, stop asking and flag it for a person. */
export const MAX_CLARIFICATIONS = 2;
const UNDO_WINDOW_MS = 24 * 3_600_000;
const SHORT_CODE_IN_TEXT = /\b([A-Z]{2,4}-[2-9A-HJKMNP-Z]{3})\b/i;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && String((error as { code: unknown }).code).startsWith("SQLITE_CONSTRAINT");
}

/** The booking a reply is about: the message it threads onto, a short code in it, or the newest open request. */
function resolveBooking(deps: TextDeps, business: Business, input: InboundInput): Booking | null {
  if (input.reply_to_id) {
    const target = getMessageByProviderId(deps.db, input.reply_to_id);
    if (target?.direction === "outbound" && target.business_id === business.id && target.booking_id) {
      const booking = getRow(deps.db, "bookings", target.booking_id);
      if (booking?.status === "pending") return booking;
    }
  }
  const code = SHORT_CODE_IN_TEXT.exec(input.body)?.[1];
  if (code) {
    const booking = getBookingByShortCode(bookingCtx(deps), code);
    if (booking && booking.business_id === business.id && booking.status === "pending") return booking;
  }
  return (
    selectRows(
      deps.db,
      "bookings",
      "business_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM messages m WHERE m.booking_id = bookings.id AND m.direction = 'outbound')",
      [business.id],
      "created_at DESC",
    )[0] ?? null
  );
}

function replyingTo(deps: TextDeps, business: Business, booking: Booking | null): ReplyingTo {
  const last = latestEvents(deps, "message.sent", { business_id: business.id }, 1)[0];
  if (last?.payload.kind === "clarify") return "clarify";
  return booking ? "new_request" : "none";
}

interface ReplyOptions {
  booking_id?: string | null;
  kind: MessageKind;
  /** Keyword confirmations (STOP, HELP, PAUSE, JOIN, UNDO) answer the owner even when texting is off. */
  requireOptIn: boolean;
  reason: string;
}

/** Answers the owner on the number they wrote from. Never throws: a failed reply is an event, not a crash. */
async function reply(deps: TextDeps, business: Business, input: InboundInput, to: string, body: string, options: ReplyOptions): Promise<Message | null> {
  const fresh = getRow(deps.db, "businesses", business.id) ?? business;
  const refs = { business_id: business.id, ...(options.booking_id ? { booking_id: options.booking_id } : {}) };
  if (options.requireOptIn) {
    const blocked = textingBlockedReason(deps, fresh);
    if (blocked) {
      record(deps, { type: "message.not_sent", actor: "system", refs, payload: { kind: options.kind, reason: blocked }, reason: blocked });
      return null;
    }
  }
  try {
    const route = await routeNumber(deps, fresh, to, { inboundChannel: input.dial_channel ?? input.channel });
    if (!route.ok) {
      record(deps, { type: "message.not_sent", actor: "system", refs, payload: { kind: options.kind, reason: route.reason, rail: railFor(deps, fresh) }, reason: route.reason });
      return null;
    }
    return await deliver(deps, { business: fresh, to: route.to, rail: route.rail, channel: route.channel, body, kind: options.kind, booking_id: options.booking_id ?? null, reason: options.reason });
  } catch (error) {
    record(deps, { type: "message.not_sent", actor: "system", refs, payload: { kind: options.kind, reason: (error as Error).message }, reason: "the reply could not be sent" });
    return null;
  }
}

/** Handles one inbound owner message end to end. Safe to call twice with the same message: the second is a no-op. */
export async function handleInbound(deps: TextDeps, input: InboundInput): Promise<InboundOutcome> {
  if (getMessageByProviderId(deps.db, input.provider_message_id)) return { status: "duplicate" };
  const from = toE164(input.from) ?? input.from;
  const business = getBusinessByNumber(deps.db, from) ?? null;
  const booking = business ? resolveBooking(deps, business, input) : null;
  const at = now(deps);

  let message: Message;
  try {
    message = insertRow(deps.db, "messages", {
      id: newId("message", at.getTime()),
      business_id: business?.id ?? null,
      booking_id: booking?.id ?? null,
      direction: "inbound",
      channel: input.channel,
      from_e164: from,
      to_e164: input.to,
      body: sanitizeUntrustedText(input.body, 4000),
      provider_message_id: input.provider_message_id,
      status: "received",
      reply_class: null,
      classification: null,
      created_at: at.toISOString(),
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "duplicate" };
    throw error;
  }

  record(deps, {
    type: "message.received",
    actor: "owner",
    refs: { message_id: message.id, ...(business ? { business_id: business.id } : {}), ...(booking ? { booking_id: booking.id } : {}) },
    payload: { channel: input.channel, body: message.body, ...(input.reaction ? { reaction: input.reaction } : {}) },
    reason: business ? "owner replied" : "a number we do not know texted us",
  });
  if (!business) return { status: "unknown_sender", message_id: message.id };

  const result = await classifyReply(
    input.body,
    {
      now: at,
      timeZone: business.timezone,
      replying_to: replyingTo(deps, business, booking),
      offer: booking ? { service: booking.service, slot_start: booking.slot_start, window_start: booking.window_start, price_cents: booking.price_cents } : null,
      reaction: input.reaction ?? null,
    },
    { model: deps.model ?? null },
  );

  updateRow(deps.db, "messages", message.id, {
    reply_class: result.classification.class,
    classification: {
      ...result.classification,
      method: result.method,
      action: result.action,
      ...(result.keyword ? { keyword: result.keyword } : {}),
      ...(result.time?.iso ? { time_iso: result.time.iso } : {}),
    },
  });
  record(deps, {
    type: "reply.classified",
    actor: "system",
    refs: { message_id: message.id, business_id: business.id, ...(booking ? { booking_id: booking.id } : {}) },
    payload: {
      class: result.classification.class,
      method: result.method,
      action: result.action,
      ...(result.keyword ? { keyword: result.keyword } : {}),
      ...(result.reaction ? { reaction: result.reaction } : {}),
      ...(result.classification.extracted ? { extracted: result.classification.extracted } : {}),
      ...(result.time?.iso ? { time_iso: result.time.iso } : {}),
    },
    reason: result.reason,
    confidence: result.classification.confidence,
  });

  const done = (action: string): InboundOutcome => ({ status: "processed", message_id: message.id, business_id: business.id, booking_id: booking?.id ?? null, result, action });
  const say = (body: string, options: ReplyOptions) => reply(deps, business, input, from, body, options);

  if (result.action === "keyword" && result.keyword) {
    return done(await handleKeyword(deps, business, message, result, say));
  }
  if (!booking) {
    if (["confirm", "decline", "counter"].includes(result.action)) await say(NO_OPEN_JOB_COPY, { kind: "ack", requireOptIn: true, reason: "reply with no open request" });
    else if (result.action === "note") noteFor(deps, business, message, result, null);
    return done("no_open_booking");
  }

  const ctx = bookingCtx(deps);
  const tz = business.timezone;
  switch (result.action) {
    case "confirm": {
      try {
        const confirmed = confirm(ctx, booking.id, { kind: "text", messageId: message.id });
        await say(composeReceipt(confirmed, tz), { kind: "receipt", booking_id: booking.id, requireOptIn: true, reason: "receipt for a confirmed booking" });
        return done("confirmed");
      } catch (error) {
        if (!(error instanceof BookingError)) throw error;
        record(deps, { type: "reply.unactionable", actor: "system", refs: { message_id: message.id, booking_id: booking.id, business_id: business.id }, payload: { error: error.code }, reason: error.message });
        return done("confirm_failed");
      }
    }
    case "decline": {
      try {
        transition(ctx, booking.id, "declined", {
          actor: "owner",
          reason: result.reaction ? "owner reacted with a thumbs down" : "owner declined by text",
          confidence: result.classification.confidence,
          payload: { message_id: message.id },
        });
      } catch (error) {
        if (!(error instanceof BookingError)) throw error;
        return done("decline_failed");
      }
      await say(DECLINE_ACK_COPY, { kind: "ack", booking_id: booking.id, requireOptIn: true, reason: "acknowledged a decline" });
      return done("declined");
    }
    case "counter": {
      const time = result.time;
      const price = result.classification.extracted?.price_cents ?? null;
      const proposal = [time?.iso ?? time?.date, price !== null ? `${price} cents` : null].filter(Boolean).join(", ");
      try {
        transition(ctx, booking.id, "countered", {
          actor: "owner",
          reason: `owner proposed ${proposal || "something else"}`,
          confidence: result.classification.confidence,
          payload: {
            message_id: message.id,
            proposed_time: time?.text ?? null,
            proposed_time_iso: time?.iso ?? null,
            proposed_date: time?.date ?? null,
            proposed_price_cents: price,
          },
          patch: { notes: [booking.notes, `Owner proposed ${proposal}.`].filter(Boolean).join(" ") },
        });
      } catch (error) {
        if (!(error instanceof BookingError)) throw error;
        return done("counter_failed");
      }
      await say(composeCounterAck(time, price, tz), { kind: "ack", booking_id: booking.id, requireOptIn: true, reason: "acknowledged a counter" });
      return done("countered");
    }
    case "note":
      noteFor(deps, business, message, result, booking);
      return done(await clarify(deps, business, booking, result, say, composeNoted(booking, tz)));
    case "clarify":
    default:
      return done(await clarify(deps, business, booking, result, say));
  }
}

function noteFor(deps: TextDeps, business: Business, message: Message, result: ClassifyResult, booking: Booking | null): void {
  record(deps, {
    type: "owner.note",
    actor: "owner",
    refs: { message_id: message.id, business_id: business.id, ...(booking ? { booking_id: booking.id } : {}) },
    payload: { class: result.classification.class, body: message.body },
    reason: "owner shared a standing rule or their availability; kept for review, not applied automatically",
    confidence: result.classification.confidence,
  });
}

type Say = (body: string, options: ReplyOptions) => Promise<Message | null>;

/** One short question, at most MAX_CLARIFICATIONS times per booking; then a person takes over. */
async function clarify(deps: TextDeps, business: Business, booking: Booking, result: ClassifyResult, say: Say, body?: string): Promise<string> {
  const asked = latestEvents(deps, "message.sent", { booking_id: booking.id }).filter((e) => e.payload.kind === "clarify").length;
  if (asked >= MAX_CLARIFICATIONS) {
    record(deps, {
      type: "reply.needs_human",
      actor: "system",
      refs: { booking_id: booking.id, business_id: business.id },
      payload: { clarifications: asked, last_class: result.classification.class },
      reason: `still unclear after ${asked} clarifying questions; a person should follow up`,
    });
    return "needs_human";
  }
  const text = body ?? (result.reaction ? composeReactionPrompt(booking, business.timezone, result.reaction) : composeConfirmPrompt(booking, business.timezone));
  await say(text, { kind: "clarify", booking_id: booking.id, requireOptIn: true, reason: result.reason });
  return "clarified";
}

/** STOP, HELP, PAUSE, UNDO and JOIN/START/RESUME. Exact behavior, exact copy, no model. */
async function handleKeyword(deps: TextDeps, business: Business, message: Message, result: ClassifyResult, say: Say): Promise<string> {
  const iso = now(deps).toISOString();
  const refs = { business_id: business.id, message_id: message.id };
  switch (result.keyword) {
    case "stop": {
      const before = business.channel_state;
      const consents = selectRows(deps.db, "consents", "business_id = ? AND revoked_at IS NULL", [business.id]);
      const wrongNumber = result.keyword_match?.wrong_number === true;
      deps.db.transaction(() => {
        for (const c of consents) updateRow(deps.db, "consents", c.id, { revoked_at: iso, revoked_reason: wrongNumber ? "owner texted: wrong number" : "owner texted STOP" });
        if (before !== "unlisted") updateRow(deps.db, "businesses", business.id, { channel_state: "unlisted", updated_at: iso });
      })();
      for (const c of consents) {
        record(deps, {
          type: "consent.revoked",
          actor: "owner",
          refs: { ...refs, consent_id: c.id },
          payload: { channel: c.channel, source: c.source, ...(wrongNumber ? { wrong_number: true } : {}) },
          reason: result.reason,
        });
      }
      if (before !== "unlisted") {
        record(deps, { type: "business.channel_changed", actor: "owner", refs, payload: { from: before, to: "unlisted" }, reason: "owner opted out by text" });
        // One confirmation, no marketing (47 CFR 64.1200(a)(12)). A repeat STOP gets no second one.
        await say(STOP_COPY, { kind: "stop_confirmation", requireOptIn: false, reason: "confirming the opt-out" });
      }
      return "stopped";
    }
    case "help":
      await say(HELP_COPY, { kind: "help", requireOptIn: false, reason: "owner asked for help" });
      return "helped";
    case "pause": {
      if (business.channel_state !== "text_enabled" && business.channel_state !== "paused") return "pause_ignored";
      const days = result.keyword_match?.pause_days ?? null;
      const resumeAt = days ? new Date(now(deps).getTime() + days * 86_400_000).toISOString() : null;
      updateRow(deps.db, "businesses", business.id, { channel_state: "paused", updated_at: iso });
      record(deps, { type: "business.channel_changed", actor: "owner", refs, payload: { from: business.channel_state, to: "paused", pause_days: days, resume_at: resumeAt }, reason: "owner paused texts" });
      await say(pauseCopy(days), { kind: "pause", requireOptIn: false, reason: "confirming the pause" });
      return "paused";
    }
    case "resume": {
      if (business.channel_state === "text_enabled" && getActiveConsent(deps.db, business.id)) return "already_enabled";
      let consent = getActiveConsent(deps.db, business.id);
      if (!consent) {
        // The JOIN text is itself the consent; the schema requires it to reference this message.
        consent = insertRow(deps.db, "consents", {
          id: newId("consent", now(deps).getTime()),
          business_id: business.id,
          channel: railFor(deps, business),
          source: "join_text",
          quoted_sentence: message.body,
          call_id: null,
          transcript_turn_ref: null,
          message_id: message.id,
          created_at: iso,
          revoked_at: null,
          revoked_reason: null,
        });
        record(deps, { type: "consent.recorded", actor: "owner", refs: { ...refs, consent_id: consent.id }, payload: { channel: consent.channel, source: "join_text" }, reason: "owner texted JOIN" });
      }
      updateRow(deps.db, "businesses", business.id, { channel_state: "text_enabled", channel_pref: business.channel_pref ?? deps.textChannel, updated_at: iso });
      record(deps, { type: "business.channel_changed", actor: "owner", refs: { ...refs, consent_id: consent.id }, payload: { from: business.channel_state, to: "text_enabled", rail: railFor(deps, business) }, reason: "owner opted back in" });
      await say(RESUME_COPY, { kind: "resume", requireOptIn: false, reason: "confirming the opt-in" });
      return "resumed";
    }
    case "undo": {
      const since = new Date(now(deps).getTime() - UNDO_WINDOW_MS).toISOString();
      const target = selectRows(deps.db, "bookings", "business_id = ? AND status = 'confirmed' AND confirmed_at >= ?", [business.id, since], "confirmed_at DESC").find(
        (b) => b.confirmation_evidence?.kind === "rule" || b.confirmation_evidence?.kind === "text",
      );
      if (!target) {
        await say(NOTHING_TO_UNDO_COPY, { kind: "undo", requireOptIn: false, reason: "nothing to undo" });
        return "nothing_to_undo";
      }
      const cancelled = transition(bookingCtx(deps), target.id, "cancelled", { actor: "owner", reason: "owner texted UNDO", payload: { message_id: message.id } });
      updateRow(deps.db, "messages", message.id, { booking_id: target.id });
      await say(composeUndone(cancelled, business.timezone), { kind: "undo", booking_id: target.id, requireOptIn: false, reason: "confirming the undo" });
      return "undone";
    }
    default:
      return "ignored";
  }
}
