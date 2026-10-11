import { beforeEach, describe, expect, it } from "vitest";
import { manualClock, type ManualClock } from "../clock";
import { getBusinessBySlug, insertRow, openDb, seed, type Db } from "../db/index";
import { BOOKING_STATUSES, type Booking, type BookingStatus, type Business } from "../db/types";
import { EventBus } from "../events/bus";
import { listEvents } from "../events/log";
import { newId } from "../ids";
import {
  attachHold,
  BookingError,
  canTransition,
  confirm,
  createBooking,
  expireHolds,
  generateShortCode,
  getBooking,
  getBookingByShortCode,
  HOLD_TTL_MS,
  InvalidTransitionError,
  placeHold,
  SHORT_CODE_PATTERN,
  TERMINAL_STATUSES,
  transition,
  TRANSITIONS,
  type BookingContext,
} from "./index";

let db: Db;
let clock: ManualClock;
let ctx: BookingContext;
let sal: Business;
let mira: Business;

const SLOT = { slot_start: "2026-10-12T21:00:00.000Z", slot_end: "2026-10-12T21:45:00.000Z" };

beforeEach(() => {
  db = openDb(":memory:");
  clock = manualClock("2026-10-11T19:00:00.000Z");
  ctx = { db, clock, bus: new EventBus() };
  seed(db, { allowedNumbers: ["+15550100001"], clock });
  sal = getBusinessBySlug(db, "sals-auto")!;
  mira = getBusinessBySlug(db, "mira-hair-studio")!;
});

const request = (business = sal, status: "pending" | "quote_pending" = "pending") =>
  createBooking(ctx, { business_id: business.id, agent_id: "claude-desktop", service: "oil change", status, route: "call" });

function insertCall(business: Business, overrides: Partial<{ id: string; status: string }> = {}) {
  const now = clock.now().toISOString();
  return insertRow(db, "calls", {
    id: overrides.id ?? newId("call"),
    business_id: business.id,
    booking_id: null,
    dial_call_id: `dial_${Math.random().toString(36).slice(2)}`,
    direction: "outbound",
    to_e164: business.phone_e164,
    status: overrides.status ?? "In-Progress",
    script_version: "v1",
    started_at: now,
    ended_at: null,
    duration_seconds: null,
    end_reason: null,
    transcript: null,
    transcript_turns: null,
    mined: null,
    friction_score: null,
    created_at: now,
    updated_at: now,
  });
}

function insertInbound(business: Business, replyClass: string | null, direction: "inbound" | "outbound" = "inbound") {
  return insertRow(db, "messages", {
    id: newId("message"),
    business_id: business.id,
    booking_id: null,
    direction,
    channel: "imessage",
    from_e164: business.phone_e164,
    to_e164: "+15550100099",
    body: "Y",
    provider_message_id: `pm_${Math.random()}`,
    status: "received",
    reply_class: replyClass,
    classification: null,
    created_at: clock.now().toISOString(),
  });
}

/** Books through the tools the way the voice agent does: hold, then attach with price. */
function bookThroughTools(booking: Booking): Booking {
  const hold = placeHold(ctx, { business_id: booking.business_id, ...SLOT, booking_id: booking.id, created_by: "voice" });
  return attachHold(ctx, hold.id, booking.id, 8900, "voice");
}

/** Puts a booking into any status by walking legal edges (confirm uses text evidence). */
function bookingIn(status: BookingStatus): Booking {
  const b = request(sal, status === "quote_pending" || status === "quoted" ? "quote_pending" : "pending");
  const confirmByText = () => confirm(ctx, b.id, { kind: "text", messageId: insertInbound(sal, "accept").id });
  const t = (to: BookingStatus) => transition(ctx, b.id, to, { actor: "system", reason: "test" });
  switch (status) {
    case "quote_pending":
    case "pending":
      return b;
    case "quoted":
      return t("quoted");
    case "countered":
      return t("countered");
    case "confirmed":
      return confirmByText();
    case "rescheduled":
      confirmByText();
      return t("rescheduled");
    case "completed":
    case "no_show":
    case "disputed":
      confirmByText();
      return t(status);
    case "declined":
    case "expired":
    case "cancelled":
      return t(status);
  }
}

describe("state machine table", () => {
  it("covers every status", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...BOOKING_STATUSES].sort());
  });

  it("has terminal outcome states", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["cancelled", "completed", "declined", "disputed", "expired", "no_show"]);
  });

  const edges = BOOKING_STATUSES.flatMap((from) => BOOKING_STATUSES.map((to) => [from, to] as const));

  it.each(edges.filter(([from, to]) => canTransition(from, to) && to !== "confirmed"))("allows %s to %s", (from, to) => {
    const b = bookingIn(from);
    const moved = transition(ctx, b.id, to, { actor: "owner", reason: "test", confidence: 0.8 });
    expect(moved.status).toBe(to);
    const last = listEvents(db, { bookingId: b.id }).at(-1)!;
    expect(last).toMatchObject({ type: `booking.${to}`, actor: "owner", reason: "test", confidence: 0.8, payload: { from, to } });
  });

  it.each(edges.filter(([from, to]) => !canTransition(from, to) && to !== "confirmed"))("rejects %s to %s", (from, to) => {
    const b = bookingIn(from);
    const before = listEvents(db).length;
    expect(() => transition(ctx, b.id, to, { actor: "owner", reason: "test" })).toThrow(InvalidTransitionError);
    expect(getBooking(ctx, b.id).status).toBe(from);
    expect(listEvents(db)).toHaveLength(before);
  });
});

describe("confirm is the only way into confirmed", () => {
  it.each(BOOKING_STATUSES)("transition() refuses confirmed from %s", (from) => {
    const b = bookingIn(from);
    expect(() => transition(ctx, b.id, "confirmed", { actor: "voice", reason: "the model said so" })).toThrow(/evidence/);
  });

  it.each(BOOKING_STATUSES.filter((s) => !canTransition(s, "confirmed")))("confirm() refuses from %s", (from) => {
    const b = bookingIn(from);
    expect(() => confirm(ctx, b.id, { kind: "text", messageId: insertInbound(sal, "accept").id })).toThrow(InvalidTransitionError);
  });

  it.each(["pending", "countered", "rescheduled"] as const)("confirm() succeeds from %s with valid text evidence", (from) => {
    const b = bookingIn(from);
    const message = insertInbound(sal, "accept");
    const confirmed = confirm(ctx, b.id, { kind: "text", messageId: message.id });
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmation_evidence).toEqual({ kind: "text", messageId: message.id });
    expect(listEvents(db, { bookingId: b.id }).at(-1)).toMatchObject({ type: "booking.confirmed", actor: "owner" });
  });
});

describe("call evidence", () => {
  it("confirms a booking made through the tools with the quoted yes", () => {
    const call = insertCall(sal);
    const b = bookThroughTools(request());
    const confirmed = confirm(ctx, b.id, { kind: "call", callId: call.id, quotedSentence: "Yep, booked." });
    expect(confirmed).toMatchObject({ status: "confirmed", price_cents: 8900, slot_start: SLOT.slot_start });
    const types = listEvents(db, { bookingId: b.id }).map((e) => e.type);
    expect(types).toEqual(["booking.pending", "hold.placed", "booking.slot_agreed", "hold.converted", "booking.confirmed"]);
    expect(listEvents(db, { type: "booking.confirmed" })[0]!.actor).toBe("voice");
  });

  it("accepts the Dial call id as well as ours", () => {
    const call = insertCall(sal);
    const b = bookThroughTools(request());
    expect(confirm(ctx, b.id, { kind: "call", callId: call.dial_call_id!, quotedSentence: "Yep" }).status).toBe("confirmed");
  });

  it("refuses a booking that was not made through hold_slot and create_booking (transcript-only)", () => {
    const call = insertCall(sal);
    const b = request();
    expect(() => confirm(ctx, b.id, { kind: "call", callId: call.id, quotedSentence: "Yep, booked." })).toThrow(/hold_slot/);
  });

  it("refuses without a quoted sentence", () => {
    const call = insertCall(sal);
    const b = bookThroughTools(request());
    expect(() => confirm(ctx, b.id, { kind: "call", callId: call.id, quotedSentence: "  " })).toThrow(/quoted/);
  });

  it("refuses a call with a different business", () => {
    const call = insertCall(mira);
    const b = bookThroughTools(request());
    expect(() => confirm(ctx, b.id, { kind: "call", callId: call.id, quotedSentence: "Yes" })).toThrow(/different business/);
  });

  it("refuses an unknown call", () => {
    const b = bookThroughTools(request());
    expect(() => confirm(ctx, b.id, { kind: "call", callId: "call_missing", quotedSentence: "Yes" })).toThrow(BookingError);
  });

  it("refuses once the hold has expired", () => {
    const call = insertCall(sal);
    const b = bookThroughTools(request());
    clock.advance(HOLD_TTL_MS + 1);
    expect(() => confirm(ctx, b.id, { kind: "call", callId: call.id, quotedSentence: "Yes" })).toThrow(/hold/);
  });
});

describe("text evidence", () => {
  it.each([
    ["a reply not classified as a yes", () => insertInbound(sal, "decline"), /classified/],
    ["an unclassified reply", () => insertInbound(sal, null), /classified/],
    ["our own outbound message", () => insertInbound(sal, "accept", "outbound"), /not from the owner/],
    ["a yes from another business", () => insertInbound(mira, "accept"), /different business/],
  ])("refuses %s", (_label, makeMessage, pattern) => {
    const b = request();
    expect(() => confirm(ctx, b.id, { kind: "text", messageId: makeMessage().id })).toThrow(pattern);
    expect(getBooking(ctx, b.id).status).toBe("pending");
  });
});

describe("rule evidence", () => {
  function insertRule(business: Business, status: "draft" | "active", confirmedBy: string | null) {
    const now = clock.now().toISOString();
    return insertRow(db, "rules", {
      id: newId("rule"),
      business_id: business.id,
      source_text: "Weekday oil changes before 3pm are fine",
      compiled_policy: {},
      status,
      version: 1,
      confirmed_message_id: confirmedBy,
      created_at: now,
      updated_at: now,
    });
  }

  it("confirms with an active rule the owner confirmed by text", () => {
    const rule = insertRule(sal, "active", insertInbound(sal, "accept").id);
    const b = request();
    const confirmed = confirm(ctx, b.id, { kind: "rule", ruleId: rule.id });
    expect(confirmed.status).toBe("confirmed");
    expect(listEvents(db, { bookingId: b.id }).at(-1)!.actor).toBe("autopilot");
  });

  it("refuses a draft rule", () => {
    const rule = insertRule(sal, "draft", null);
    expect(() => confirm(ctx, request().id, { kind: "rule", ruleId: rule.id })).toThrow(/not confirmed the rule/);
  });

  it("refuses another business's rule", () => {
    const rule = insertRule(mira, "active", insertInbound(mira, "accept").id);
    expect(() => confirm(ctx, request().id, { kind: "rule", ruleId: rule.id })).toThrow(/different business/);
  });
});

describe("holds", () => {
  it("never double-books an overlapping slot", () => {
    placeHold(ctx, { business_id: sal.id, ...SLOT, created_by: "voice" });
    expect(() =>
      placeHold(ctx, { business_id: sal.id, slot_start: "2026-10-12T21:30:00.000Z", slot_end: "2026-10-12T22:00:00.000Z", created_by: "voice" }),
    ).toThrow(/already held/);
  });

  it("allows adjacent slots and the same slot at another business", () => {
    placeHold(ctx, { business_id: sal.id, ...SLOT, created_by: "voice" });
    expect(placeHold(ctx, { business_id: sal.id, slot_start: SLOT.slot_end, slot_end: "2026-10-12T22:30:00.000Z", created_by: "voice" }).status).toBe("active");
    expect(placeHold(ctx, { business_id: mira.id, ...SLOT, created_by: "voice" }).status).toBe("active");
  });

  it("refuses a slot over a confirmed booking", () => {
    const call = insertCall(sal);
    const b = bookThroughTools(request());
    confirm(ctx, b.id, { kind: "call", callId: call.id, quotedSentence: "Yep" });
    clock.advance(HOLD_TTL_MS * 2);
    expect(() => placeHold(ctx, { business_id: sal.id, ...SLOT, created_by: "voice" })).toThrow(/already held or booked/);
  });

  it("expire after 10 minutes and free the slot", () => {
    const hold = placeHold(ctx, { business_id: sal.id, ...SLOT, created_by: "voice" });
    expect(hold.expires_at).toBe(new Date(clock.now().getTime() + HOLD_TTL_MS).toISOString());
    clock.advance(HOLD_TTL_MS - 1);
    expect(expireHolds(ctx)).toHaveLength(0);
    clock.advance(1);
    expect(expireHolds(ctx).map((h) => h.id)).toEqual([hold.id]);
    expect(listEvents(db, { type: "hold.expired" })).toHaveLength(1);
    expect(placeHold(ctx, { business_id: sal.id, ...SLOT, created_by: "voice" }).status).toBe("active");
  });

  it("refuse to attach once expired", () => {
    const hold = placeHold(ctx, { business_id: sal.id, ...SLOT, created_by: "voice" });
    clock.advance(HOLD_TTL_MS);
    expect(() => attachHold(ctx, hold.id, request().id, 8900, "voice")).toThrow(/expired/);
  });

  it("refuse an empty slot", () => {
    expect(() => placeHold(ctx, { business_id: sal.id, slot_start: SLOT.slot_end, slot_end: SLOT.slot_start, created_by: "voice" })).toThrow(/end after/);
  });

  it("are released when the booking is cancelled", () => {
    const b = bookThroughTools(request());
    transition(ctx, b.id, "cancelled", { actor: "agent", reason: "customer changed plans" });
    expect(listEvents(db, { type: "hold.released" })).toHaveLength(1);
    expect(placeHold(ctx, { business_id: sal.id, ...SLOT, created_by: "voice" }).status).toBe("active");
  });
});

describe("short codes", () => {
  it("look like SAL-4K2 and avoid ambiguous characters", () => {
    for (let i = 0; i < 200; i++) expect(generateShortCode("SAL")).toMatch(SHORT_CODE_PATTERN);
    expect(generateShortCode("sal", () => 0)).toBe("SAL-222");
  });

  it("are unique per booking and findable", () => {
    const a = request();
    const b = request();
    expect(a.short_code).not.toBe(b.short_code);
    expect(getBookingByShortCode(ctx, a.short_code.toLowerCase())!.id).toBe(a.id);
  });
});

describe("events", () => {
  it("are published only after commit", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));
    const local = { ...ctx, bus };
    const b = createBooking(local, { business_id: sal.id, agent_id: "a", service: "oil change", route: "call" });
    expect(seen).toEqual(["booking.pending"]);
    expect(() => transition(local, b.id, "completed", { actor: "owner", reason: "x" })).toThrow();
    expect(seen).toEqual(["booking.pending"]);
  });

  it("record route and routing reasons on booking.pending", () => {
    createBooking(ctx, { business_id: sal.id, agent_id: "a", service: "oil change", route: "text", routing_reasons: ["consent on imessage"] });
    expect(listEvents(db, { type: "booking.pending" })[0]!.payload).toMatchObject({ route: "text", routing_reasons: ["consent on imessage"] });
  });
});
