import { BookingError, confirm, getBooking, transition, type BookingContext } from "../booking/index";
import { systemClock, type Clock } from "../clock";
import type { TextChannel } from "../config";
import type { OwnerChannels } from "../contracts/index";
import { getBusiness, getBusinessByNumber, getCallByDialId, insertRow, selectRows, type Db } from "../db/repo";
import type { Booking, BookingStatus, Business } from "../db/types";
import type { EventBus } from "../events/bus";
import { emit } from "../events/log";
import type { EntityRefs } from "../events/types";
import { newId } from "../ids";
import type { FakeDial } from "./fake-dial";

export interface FakeOwnerChannelsOptions {
  /** Construct it with `voiceTools: createFakeGateway(...)` and `db` so the scripted call books mid-call. */
  dial: FakeDial;
  db: Db;
  bus?: Pick<EventBus, "publish">;
  clock?: Clock;
  /** The owner text rail; mirrors TEXT_CHANNEL. */
  textChannel?: TextChannel;
  /** The Dial number id calls are placed from. */
  fromNumberId?: string;
}

const MAX_BODY = 300;
const YES = /^(y|yes)$/i;
const NO = /^(n|no)$/i;
/** SHORT_CODE_PATTERN unanchored, so "Y SAL-4K2" names the booking it answers. */
const SHORT_CODE_IN_TEXT = /\b[A-Z]{2,4}-[2-9A-HJKMNP-Z]{3}\b/i;
/** A text request awaits the owner's reply only while its booking is in one of these. */
const AWAITING_STATUSES: readonly BookingStatus[] = ["pending", "countered"];

/**
 * FAKE OwnerChannels over FakeDial, for DIAL_IMPL=fake. It stands in for the phone
 * side's call script and text package so the gateway runs end to end without them;
 * the real version lives in @platypus/voice and replaces this at integration.
 *
 * Calls play FakeDial's golden-path script (the mid-call VoiceTools do the booking).
 * Texts use the spec B.7 copy. Replies are matched exactly: Y/yes confirms through
 * confirm() with text evidence, N/no declines, anything else leaves the booking pending.
 * A reply answers the oldest booking still awaiting one, or the booking whose short code
 * it carries ("Y SAL-4K2"). A reply that cannot be applied becomes a reply.ignored event.
 */
export function createFakeOwnerChannels(options: FakeOwnerChannelsOptions): OwnerChannels {
  const { dial, db } = options;
  const clock = options.clock ?? systemClock;
  const busOpt = options.bus ? { bus: options.bus } : {};
  const ctx: BookingContext = { db, clock, ...busOpt };
  const emitOpts = { clock, ...busOpt };
  const textChannel = options.textChannel ?? "imessage";
  /** business_id -> bookings whose text request awaits the owner's reply, oldest first. */
  const awaiting = new Map<string, readonly string[]>();

  function load(bookingId: string, businessId: string): { booking: Booking; business: Business } {
    const booking = getBooking(ctx, bookingId);
    const business = getBusiness(db, businessId);
    if (!business || booking.business_id !== businessId) {
      throw new BookingError("not_found", `Booking ${booking.short_code} is not for business ${businessId}`);
    }
    return { booking, business };
  }

  /** The business's bookings still awaiting a reply, oldest first; drops any that moved on. */
  function stillAwaiting(businessId: string): Booking[] {
    const open = (awaiting.get(businessId) ?? []).map((id) => getBooking(ctx, id)).filter((b) => AWAITING_STATUSES.includes(b.status));
    awaiting.set(businessId, open.map((b) => b.id));
    return open;
  }

  /** Never confirm without a live hold: the slot may have been refused, or lapsed while the owner read the text. */
  function holdsSlot(bookingId: string): boolean {
    return selectRows(db, "holds", "booking_id = ? AND status = 'active' AND expires_at > ?", [bookingId, clock.now().toISOString()]).length > 0;
  }

  function ignore(refs: EntityRefs, reason: string): void {
    emit(db, { type: "reply.ignored", actor: "system", refs, payload: { reason }, reason }, emitOpts);
  }

  // This runs inside FakeDial's detached reply promise: a throw here is an unhandled
  // rejection that kills `pnpm dev`, so every failure becomes a reply.ignored event.
  dial.on((event) => {
    if (event.type !== "message.received") return;
    let refs: EntityRefs = {};
    try {
      const business = getBusinessByNumber(db, event.data.from);
      if (!business) return;
      refs = { business_id: business.id };
      const open = stillAwaiting(business.id);
      if (open.length === 0) {
        ignore(refs, "no booking from this business awaits a reply");
        return;
      }

      const body = event.data.body.trim();
      const code = SHORT_CODE_IN_TEXT.exec(body)?.[0].toUpperCase();
      const booking = code ? open.find((b) => b.short_code === code) : open[0];
      const word = code ? body.replace(SHORT_CODE_IN_TEXT, "").trim() : body;
      const replyClass = YES.test(word) ? "accept" : NO.test(word) ? "decline" : null;
      const message = insertRow(db, "messages", {
        id: newId("message", clock.now().getTime()),
        business_id: business.id,
        booking_id: booking?.id ?? null,
        direction: "inbound",
        channel: textChannel,
        from_e164: event.data.from,
        to_e164: event.data.to ?? "",
        body: event.data.body,
        provider_message_id: event.data.messageId,
        status: "received",
        reply_class: replyClass,
        classification: replyClass ? { class: replyClass, confidence: 1 } : null,
        created_at: clock.now().toISOString(),
      });
      refs = { ...refs, message_id: message.id, ...(booking ? { booking_id: booking.id } : {}) };
      emit(db, { type: "message.received", actor: "owner", refs, payload: { channel: textChannel, body: event.data.body }, reason: "owner replied" }, emitOpts);
      if (!booking) {
        ignore(refs, `no booking awaiting a reply has code ${code}`);
        return;
      }
      // ponytail: exact Y/N only; the phone side's text package classifies everything else with Claude.
      if (!replyClass) return;
      emit(db, { type: "reply.classified", actor: "system", refs: { message_id: message.id, booking_id: booking.id }, payload: { class: replyClass, method: "deterministic" }, reason: `exact match: ${body}`, confidence: 1 }, emitOpts);
      if (replyClass === "accept" && !holdsSlot(booking.id)) {
        ignore(refs, `${booking.short_code} has no held slot; it stays pending`);
        return;
      }
      if (replyClass === "accept") confirm(ctx, booking.id, { kind: "text", messageId: message.id });
      else transition(ctx, booking.id, "declined", { actor: "owner", reason: `owner replied ${body}`, payload: { message_id: message.id } });
      stillAwaiting(business.id);
    } catch (error) {
      try {
        ignore(refs, error instanceof Error ? error.message : String(error));
      } catch (logError) {
        console.error("FakeOwnerChannels: could not record an ignored reply", logError);
      }
    }
  });

  return {
    async startOnboardingCall({ booking_id, business_id }) {
      const { booking, business } = load(booking_id, business_id);
      const { call } = await dial.placeCall(
        {
          to: business.phone_e164,
          fromNumberId: options.fromNumberId ?? "num_fake",
          outboundInstruction: `Book ${offeredService(business, booking.service)} with ${business.display_name} for a customer's agent, then ask if we may text next time.`,
          maxCallDurationSeconds: 120,
        },
        { business_id, booking_id },
      );
      return { call_id: getCallByDialId(db, call.id)?.id ?? call.id };
    },

    async sendBookingRequest({ booking_id, business_id }) {
      const { booking, business } = load(booking_id, business_id);
      if (business.channel_state !== "text_enabled") {
        return { needs_call: true, reason: `business is ${business.channel_state}; no text consent on record` };
      }
      const to = business.text_number_e164;
      if (!to) return { needs_call: true, reason: "no text number on record" };

      const body = requestCopy(booking, business.timezone);
      const { message: sent } = await dial.sendMessage({ to, body, channel: textChannel === "dial" ? "sms" : textChannel });
      const outbound = insertRow(db, "messages", {
        id: newId("message", clock.now().getTime()),
        business_id,
        booking_id,
        direction: "outbound",
        channel: textChannel,
        from_e164: sent.from,
        to_e164: to,
        body,
        provider_message_id: sent.id,
        status: "sent",
        reply_class: null,
        classification: null,
        created_at: clock.now().toISOString(),
      });
      awaiting.set(business_id, [...(awaiting.get(business_id) ?? []), booking_id]);
      emit(db, { type: "message.sent", actor: "system", refs: { message_id: outbound.id, business_id, booking_id }, payload: { channel: textChannel, body }, reason: "owner opted in to texts" }, emitOpts);
      return { message_id: outbound.id };
    },
  };
}

/**
 * The call instruction names the business's own service, never the agent's text, which is
 * untrusted (non-negotiable 5). The real call script in @platypus/voice must follow the same rule.
 */
function offeredService(business: Business, asked: string): string {
  const wanted = asked.trim().toLowerCase();
  const match = business.services.find((s) => wanted.includes(s.name.toLowerCase()) || (wanted !== "" && s.name.toLowerCase().includes(wanted)));
  return match ? `the ${match.name}` : "a service request";
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Spec B.7: "New job via Platypus (AI-assisted): {service}, {window}, {notes}. From {requested_by}. Reply Y, N, or a time." */
function requestCopy(booking: Booking, timeZone: string): string {
  const when = booking.slot_start ?? booking.window_start;
  const notes = booking.details ?? booking.notes;
  const parts = [clip(booking.service, 60), when ? shortWhen(when, timeZone) : "flexible timing", ...(notes ? [clip(notes, 100)] : [])];
  const body = `New job via Platypus (AI-assisted): ${parts.join(", ")}. From ${clip(booking.requested_by ?? "a customer's agent", 40)}. Reply Y, N, or a time.`;
  return clip(body, MAX_BODY);
}

/** "Tue 10am" or "Tue 2:30pm" in the business's time zone. */
function shortWhen(iso: string, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", minute: "2-digit", hour12: true });
  const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${p.weekday} ${p.hour}${p.minute === "00" ? "" : `:${p.minute}`}${(p.dayPeriod ?? "").toLowerCase()}`;
}
