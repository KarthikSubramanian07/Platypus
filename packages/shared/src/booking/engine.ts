import { systemClock, type Clock } from "../clock";
import { getRow, insertRow, selectRows, updateRow, type Db } from "../db/repo";
import type { Booking, BookingRoute, BookingStatus, ConfirmationEvidence, Hold } from "../db/types";
import { defaultBus, type EventBus } from "../events/bus";
import { emit } from "../events/log";
import type { EmitInput, EventActor, PlatypusEvent } from "../events/types";
import { newId } from "../ids";
import { BookingError, InvalidTransitionError } from "./errors";
import { canTransition, CONFIRMABLE_STATUSES, OCCUPYING_STATUSES } from "./machine";
import { generateShortCode } from "./short-code";

export const HOLD_TTL_MS = 10 * 60 * 1000;

export interface BookingContext {
  db: Db;
  bus?: Pick<EventBus, "publish">;
  clock?: Clock;
}

/**
 * Runs fn in one transaction and publishes the events it emitted only after
 * commit, so a live listener never sees an event for a change that rolled back.
 */
function inTx<T>(ctx: BookingContext, fn: (record: (input: EmitInput) => PlatypusEvent, now: Date) => T): T {
  const clock = ctx.clock ?? systemClock;
  const bus = ctx.bus ?? defaultBus;
  const held: PlatypusEvent[] = [];
  const collector = { publish: (e: PlatypusEvent) => held.push(e) };
  const result = ctx.db.transaction(() => fn((input) => emit(ctx.db, input, { bus: collector, clock }), clock.now()))();
  for (const e of held) bus.publish(e);
  return result;
}

export function getBooking(ctx: BookingContext, id: string): Booking {
  const booking = getRow(ctx.db, "bookings", id);
  if (!booking) throw new BookingError("not_found", `Booking not found: ${id}`);
  return booking;
}

export function getBookingByShortCode(ctx: BookingContext, shortCode: string): Booking | undefined {
  return selectRows(ctx.db, "bookings", "short_code = ?", [shortCode.toUpperCase()])[0];
}

export interface CreateBookingInput {
  business_id: string;
  agent_id: string;
  service: string;
  status?: Extract<BookingStatus, "pending" | "quote_pending">;
  route?: BookingRoute | null;
  window_start?: string | null;
  window_end?: string | null;
  details?: string | null;
  platform_id?: string | null;
  requested_by?: string | null;
  notes?: string | null;
  quote_id?: string | null;
  reason?: string;
  routing_reasons?: string[];
}

/** Opens a booking request. Emits booking.pending (or booking.quote_pending) with the route and why. */
export function createBooking(ctx: BookingContext, input: CreateBookingInput): Booking {
  return inTx(ctx, (record, now) => {
    const business = getRow(ctx.db, "businesses", input.business_id);
    if (!business) throw new BookingError("not_found", `Business not found: ${input.business_id}`);
    let shortCode = generateShortCode(business.short_code_prefix);
    for (let i = 0; i < 20 && selectRows(ctx.db, "bookings", "short_code = ?", [shortCode]).length; i++) {
      shortCode = generateShortCode(business.short_code_prefix);
    }
    const iso = now.toISOString();
    const booking: Booking = {
      id: newId("booking", now.getTime()),
      business_id: business.id,
      agent_id: input.agent_id,
      platform_id: input.platform_id ?? null,
      service: input.service,
      details: input.details ?? null,
      window_start: input.window_start ?? null,
      window_end: input.window_end ?? null,
      slot_start: null,
      slot_end: null,
      price_cents: null,
      status: input.status ?? "pending",
      route: input.route ?? null,
      short_code: shortCode,
      quote_id: input.quote_id ?? null,
      requested_by: input.requested_by ?? null,
      notes: input.notes ?? null,
      confirmation_evidence: null,
      confirmed_at: null,
      created_at: iso,
      updated_at: iso,
    };
    insertRow(ctx.db, "bookings", booking);
    record({
      type: `booking.${booking.status}`,
      actor: "agent",
      refs: { booking_id: booking.id, business_id: business.id },
      payload: {
        service: booking.service,
        route: booking.route,
        window_start: booking.window_start,
        window_end: booking.window_end,
        short_code: booking.short_code,
        agent_id: booking.agent_id,
        routing_reasons: input.routing_reasons ?? [],
      },
      reason: input.reason ?? "agent requested a booking",
    });
    return booking;
  });
}

export interface TransitionOptions {
  actor: EventActor;
  reason: string;
  confidence?: number;
  patch?: Partial<Pick<Booking, "slot_start" | "slot_end" | "price_cents" | "notes" | "route">>;
  payload?: Record<string, unknown>;
}

/**
 * Moves a booking along the state machine. Refuses `confirmed` outright: the
 * only door into confirmed is confirm(), which demands evidence.
 */
export function transition(ctx: BookingContext, bookingId: string, to: BookingStatus, options: TransitionOptions): Booking {
  if (to === "confirmed") {
    throw new BookingError("confirm_requires_evidence", "Use confirm(bookingId, evidence): a booking is confirmed only when the owner says yes");
  }
  return inTx(ctx, (record, now) => applyTransition(ctx, record, now, bookingId, to, options));
}

function applyTransition(
  ctx: BookingContext,
  record: (input: EmitInput) => PlatypusEvent,
  now: Date,
  bookingId: string,
  to: BookingStatus,
  options: TransitionOptions & { evidence?: ConfirmationEvidence },
): Booking {
  const booking = getBooking(ctx, bookingId);
  if (!canTransition(booking.status, to)) throw new InvalidTransitionError(booking.status, to);
  const iso = now.toISOString();
  const updated = updateRow(ctx.db, "bookings", booking.id, {
    ...options.patch,
    status: to,
    ...(options.evidence ? { confirmation_evidence: options.evidence, confirmed_at: iso } : {}),
    updated_at: iso,
  });
  // A booking leaving the live states releases whatever hold it still has.
  if (["declined", "expired", "cancelled"].includes(to)) {
    for (const hold of selectRows(ctx.db, "holds", "booking_id = ? AND status = 'active'", [booking.id])) {
      updateRow(ctx.db, "holds", hold.id, { status: "released", updated_at: iso });
      record({ type: "hold.released", actor: options.actor, refs: { hold_id: hold.id, booking_id: booking.id, business_id: booking.business_id }, reason: `booking ${to}` });
    }
  }
  record({
    type: `booking.${to}`,
    actor: options.actor,
    refs: { booking_id: booking.id, business_id: booking.business_id },
    payload: {
      from: booking.status,
      to,
      short_code: booking.short_code,
      slot_start: updated.slot_start,
      price_cents: updated.price_cents,
      ...(options.evidence ? { evidence: options.evidence } : {}),
      ...options.payload,
    },
    reason: options.reason,
    confidence: options.confidence ?? 1,
  });
  return updated;
}

/**
 * Non-negotiable 1, as code. The ONLY function that sets status = confirmed.
 *
 *  call: the owner said yes on a call that belongs to this business, the booking
 *        was made through the mid-call tools (it holds a slot and a price), and
 *        the owner's sentence is quoted.
 *  text: an inbound message from this business, classified as accept, landed.
 *  rule: an autopilot rule for this business that the owner confirmed by text.
 *
 * A transcript alone or a model's say-so is not evidence and cannot be expressed here.
 */
export function confirm(ctx: BookingContext, bookingId: string, evidence: ConfirmationEvidence): Booking {
  return inTx(ctx, (record, now) => {
    const booking = getBooking(ctx, bookingId);
    if (!CONFIRMABLE_STATUSES.includes(booking.status)) throw new InvalidTransitionError(booking.status, "confirmed");
    expireHoldsInTx(ctx, record, now);
    const actor = verifyEvidence(ctx, booking, evidence);
    const iso = now.toISOString();
    // A yes that arrived before it was matched to a booking is bound to this one, so it cannot confirm a second.
    if (evidence.kind === "text") {
      const message = getRow(ctx.db, "messages", evidence.messageId);
      if (message && !message.booking_id) updateRow(ctx.db, "messages", message.id, { booking_id: booking.id });
    }
    for (const hold of selectRows(ctx.db, "holds", "booking_id = ? AND status = 'active'", [booking.id])) {
      updateRow(ctx.db, "holds", hold.id, { status: "converted", updated_at: iso });
      record({ type: "hold.converted", actor, refs: { hold_id: hold.id, booking_id: booking.id, business_id: booking.business_id }, reason: "booking confirmed" });
    }
    return applyTransition(ctx, record, now, booking.id, "confirmed", {
      actor,
      reason: `owner said yes (${evidence.kind})`,
      evidence,
    });
  });
}

function verifyEvidence(ctx: BookingContext, booking: Booking, evidence: ConfirmationEvidence): EventActor {
  const fail = (why: string): never => {
    throw new BookingError("invalid_evidence", `Cannot confirm ${booking.short_code}: ${why}`);
  };
  switch (evidence.kind) {
    case "call": {
      const call =
        getRow(ctx.db, "calls", evidence.callId) ?? selectRows(ctx.db, "calls", "dial_call_id = ?", [evidence.callId])[0];
      if (!call) return fail("the call does not exist");
      if (call.business_id !== booking.business_id) return fail("the call was with a different business");
      if (call.ended_at) return fail("the call has ended; a yes on a call is taken mid-call, through the booking tools");
      if (!evidence.quotedSentence?.trim()) return fail("the owner's yes must be quoted");
      if (booking.slot_start === null || booking.price_cents === null) return fail("it was not booked through hold_slot and create_booking");
      const holds = selectRows(ctx.db, "holds", "booking_id = ? AND status IN ('active', 'converted')", [booking.id]);
      if (holds.length === 0) return fail("it has no hold placed during the call");
      return "voice";
    }
    case "text": {
      const message = getRow(ctx.db, "messages", evidence.messageId);
      if (!message) return fail("the message does not exist");
      if (message.direction !== "inbound") return fail("the message was not from the owner");
      if (message.business_id !== booking.business_id) return fail("the message came from a different business");
      if (message.reply_class !== "accept") return fail("the reply was not classified as a yes");
      // One yes confirms one booking: the reply the owner sent about another job is not a yes to this one.
      if (message.booking_id && message.booking_id !== booking.id) return fail("the owner's reply was about a different booking");
      return "owner";
    }
    case "rule": {
      const rule = getRow(ctx.db, "rules", evidence.ruleId);
      if (!rule) return fail("the rule does not exist");
      if (rule.business_id !== booking.business_id) return fail("the rule belongs to a different business");
      if (rule.status !== "active" || !rule.confirmed_message_id) return fail("the owner has not confirmed the rule by text");
      return "autopilot";
    }
    default:
      return fail("unknown evidence kind");
  }
}

// ---- Holds -------------------------------------------------------------------

export interface PlaceHoldInput {
  business_id: string;
  slot_start: string;
  slot_end: string;
  booking_id?: string | null;
  created_by: EventActor;
}

const overlaps = "slot_start < ? AND slot_end > ?";

/**
 * A hold or an agreed slot rewrites a booking's time (and price). That is only
 * open while the owner has not said yes yet, or after a reschedule. Once a
 * booking is confirmed or closed, its terms are what the owner agreed to.
 */
const SLOT_OPEN_STATUSES: readonly BookingStatus[] = ["quote_pending", "quoted", "pending", "countered", "rescheduled"];

function assertSlotOpen(booking: Booking): void {
  if (!SLOT_OPEN_STATUSES.includes(booking.status)) {
    throw new BookingError("invalid_transition", `Booking ${booking.short_code} is ${booking.status}: its time and price change only through a reschedule`);
  }
}

/** Places a 10-minute hold. Never double-books: refuses overlap with live holds and confirmed bookings. */
export function placeHold(ctx: BookingContext, input: PlaceHoldInput): Hold {
  return inTx(ctx, (record, now) => {
    const start = new Date(input.slot_start);
    const end = new Date(input.slot_end);
    if (!(start.getTime() < end.getTime())) throw new BookingError("invalid_slot", "A slot must end after it starts");
    const iso = now.toISOString();
    expireHoldsInTx(ctx, record, now);
    if (input.booking_id) assertSlotOpen(getBooking(ctx, input.booking_id));
    const s = start.toISOString();
    const e = end.toISOString();
    const clashHold = selectRows(ctx.db, "holds", `business_id = ? AND status = 'active' AND ${overlaps}`, [input.business_id, e, s]);
    const clashBooking = selectRows(
      ctx.db,
      "bookings",
      `business_id = ? AND status IN (${OCCUPYING_STATUSES.map(() => "?").join(", ")}) AND ${overlaps}`,
      [input.business_id, ...OCCUPYING_STATUSES, e, s],
    );
    if (clashHold.length || clashBooking.length) {
      throw new BookingError("slot_unavailable", "That slot is already held or booked");
    }
    const hold: Hold = {
      id: newId("hold", now.getTime()),
      business_id: input.business_id,
      booking_id: input.booking_id ?? null,
      slot_start: s,
      slot_end: e,
      status: "active",
      expires_at: new Date(now.getTime() + HOLD_TTL_MS).toISOString(),
      created_by: input.created_by,
      created_at: iso,
      updated_at: iso,
    };
    insertRow(ctx.db, "holds", hold);
    if (hold.booking_id) {
      updateRow(ctx.db, "bookings", hold.booking_id, { slot_start: s, slot_end: e, updated_at: iso });
    }
    record({
      type: "hold.placed",
      actor: input.created_by,
      refs: { hold_id: hold.id, business_id: hold.business_id, ...(hold.booking_id ? { booking_id: hold.booking_id } : {}) },
      payload: { slot_start: s, slot_end: e, expires_at: hold.expires_at },
      reason: "slot held for 10 minutes",
    });
    return hold;
  });
}

/** Ties a hold to a booking and records the agreed price (create_booking on the call). */
export function attachHold(ctx: BookingContext, holdId: string, bookingId: string, priceCents: number, actor: EventActor): Booking {
  return inTx(ctx, (record, now) => {
    expireHoldsInTx(ctx, record, now);
    const hold = getRow(ctx.db, "holds", holdId);
    if (!hold || hold.status !== "active") throw new BookingError("hold_not_active", "The hold has expired or does not exist");
    const booking = getBooking(ctx, bookingId);
    if (hold.business_id !== booking.business_id) throw new BookingError("hold_not_active", "The hold belongs to a different business");
    if (hold.booking_id && hold.booking_id !== booking.id) throw new BookingError("hold_not_active", "The hold belongs to a different booking");
    assertSlotOpen(booking);
    if (!Number.isInteger(priceCents) || priceCents < 0) throw new BookingError("invalid_slot", "Price must be a non-negative integer of cents");
    const iso = now.toISOString();
    updateRow(ctx.db, "holds", hold.id, { booking_id: booking.id, updated_at: iso });
    const updated = updateRow(ctx.db, "bookings", booking.id, {
      slot_start: hold.slot_start,
      slot_end: hold.slot_end,
      price_cents: priceCents,
      updated_at: iso,
    });
    record({
      type: "booking.slot_agreed",
      actor,
      refs: { booking_id: booking.id, business_id: booking.business_id, hold_id: hold.id },
      payload: { slot_start: hold.slot_start, slot_end: hold.slot_end, price_cents: priceCents, short_code: booking.short_code },
      reason: "slot and price agreed through the booking tools",
    });
    return updated;
  });
}

export function releaseHold(ctx: BookingContext, holdId: string, actor: EventActor, reason: string): Hold {
  return inTx(ctx, (record, now) => {
    const hold = getRow(ctx.db, "holds", holdId);
    if (!hold || hold.status !== "active") throw new BookingError("hold_not_active", "The hold is not active");
    const updated = updateRow(ctx.db, "holds", hold.id, { status: "released", updated_at: now.toISOString() });
    record({ type: "hold.released", actor, refs: { hold_id: hold.id, business_id: hold.business_id }, reason });
    return updated;
  });
}

function expireHoldsInTx(ctx: BookingContext, record: (input: EmitInput) => PlatypusEvent, now: Date): Hold[] {
  const iso = now.toISOString();
  const due = selectRows(ctx.db, "holds", "status = 'active' AND expires_at <= ?", [iso]);
  for (const hold of due) {
    updateRow(ctx.db, "holds", hold.id, { status: "expired", updated_at: iso });
    record({
      type: "hold.expired",
      actor: "system",
      refs: { hold_id: hold.id, business_id: hold.business_id, ...(hold.booking_id ? { booking_id: hold.booking_id } : {}) },
      reason: "unconfirmed for 10 minutes",
    });
  }
  return due;
}

/** Sweeper: expires every active hold past its deadline. Safe to call on a timer. */
export function expireHolds(ctx: BookingContext): Hold[] {
  return inTx(ctx, (record, now) => expireHoldsInTx(ctx, record, now));
}
