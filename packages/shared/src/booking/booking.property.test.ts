import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { auditEventLog, formatAuditReport } from "../audit/index";
import { manualClock, type ManualClock } from "../clock";
import { openDb } from "../db/index";
import { getRow, insertRow, selectRows, updateRow, type Db } from "../db/repo";
import { seed } from "../db/seed";
import { BOOKING_STATUSES, type Booking, type BookingStatus, type Business, type Call, type ConfirmationEvidence, type Hold, type Message, type Rule } from "../db/types";
import { emit, listEvents } from "../events/log";
import type { PlatypusEvent } from "../events/types";
import { newId } from "../ids";
import { attachHold, confirm, createBooking, expireHolds, placeHold, releaseHold, transition, type BookingContext } from "./engine";
import { BookingError } from "./errors";
import { OCCUPYING_STATUSES } from "./machine";

/**
 * Model-free property tests of the booking engine. fast-check drives random
 * sequences of everything that can touch a booking: creating it, every
 * transition() target (including the forbidden ones), confirm() with valid and
 * forged evidence, holds placed, attached, released and expired, calls going
 * live and ending, owner texts with every classification, autopilot rules.
 * After each step and at the end, it checks the invariants against the
 * database and replays the log through the auditor.
 */

// Deterministic in CI. To explore: FC_SEED=$RANDOM FC_RUNS=5000 pnpm vitest run booking.property
fc.configureGlobal({ seed: Number(process.env.FC_SEED ?? 0x9a7f), numRuns: Number(process.env.FC_RUNS ?? 200) });

const T0 = Date.parse("2026-10-13T16:00:00.000Z");
const HALF_HOUR = 30 * 60_000;

// ---- The generated program -----------------------------------------------------------------

/** An index into what exists so far, or the newest ("last") or the one before it ("prev"). */
type Ref = number | "last" | "prev";
type EvidenceSpec =
  | { kind: "call"; c: number; quote: string }
  | { kind: "text"; m: Ref }
  | { kind: "rule"; r: number }
  | { kind: "ghost"; as: "call" | "text" | "rule" };

type Op =
  | { kind: "create"; biz: number; quote: boolean }
  | { kind: "transition"; b: Ref; to: BookingStatus }
  | { kind: "confirm"; b: Ref; ev: EvidenceSpec }
  | { kind: "hold"; biz: number; b: Ref | null; start: number; len: number }
  | { kind: "attach"; h: Ref; b: Ref; price: number }
  | { kind: "release"; h: number }
  | { kind: "tick"; minutes: number }
  | { kind: "call"; biz: number; b: Ref | null }
  | { kind: "hangup"; c: number }
  | { kind: "text"; biz: number; b: Ref | null; cls: string | null; inbound: boolean }
  | { kind: "rule"; biz: number; confirmedBy: number | null };

const ref: fc.Arbitrary<Ref> = fc.oneof(fc.nat(9), fc.constant<"last">("last"));
const quote = fc.oneof(fc.constant("Yep, booked."), fc.string({ maxLength: 4 }));
const evidence: fc.Arbitrary<EvidenceSpec> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("call" as const), c: fc.nat(9), quote }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("text" as const), m: ref }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("rule" as const), r: fc.nat(9) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("ghost" as const), as: fc.constantFrom("call" as const, "text" as const, "rule" as const) }), weight: 1 },
);
const biz = fc.nat(1);
const slotStart = fc.nat(11);

const primitive: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("create" as const), biz, quote: fc.boolean() }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("transition" as const), b: ref, to: fc.constantFrom(...BOOKING_STATUSES) }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("confirm" as const), b: ref, ev: evidence }), weight: 4 },
  { arbitrary: fc.record({ kind: fc.constant("hold" as const), biz, b: fc.option(ref), start: slotStart, len: fc.integer({ min: -1, max: 3 }) }), weight: 4 },
  { arbitrary: fc.record({ kind: fc.constant("attach" as const), h: ref, b: ref, price: fc.integer({ min: -50, max: 50_000 }) }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("release" as const), h: fc.nat(9) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("tick" as const), minutes: fc.nat(12) }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("call" as const), biz, b: fc.option(ref) }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("hangup" as const), c: fc.nat(9) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("text" as const), biz, b: fc.option(ref), cls: fc.constantFrom("accept", "accept", "decline", "counter", null), inbound: fc.boolean() }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("rule" as const), biz, confirmedBy: fc.option(fc.nat(9)) }), weight: 1 },
);

/** Whole journeys, so valid confirmations are common and not a lucky accident. */
const journey: fc.Arbitrary<Op[]> = fc.oneof(
  fc.record({ biz, start: slotStart, price: fc.nat(30_000), q: quote }).map(({ biz, start, price, q }): Op[] => [
    { kind: "create", biz, quote: false },
    { kind: "call", biz, b: "last" },
    { kind: "hold", biz, b: "last", start, len: 2 },
    { kind: "attach", h: "last", b: "last", price },
    { kind: "confirm", b: "last", ev: { kind: "call", c: -1, quote: q } },
  ]),
  fc.record({ biz, start: slotStart, cls: fc.constantFrom("accept", "decline") }).map(({ biz, start, cls }): Op[] => [
    { kind: "create", biz, quote: false },
    { kind: "hold", biz, b: "last", start, len: 1 },
    { kind: "text", biz, b: "last", cls, inbound: true },
    { kind: "confirm", b: "last", ev: { kind: "text", m: -1 } },
  ]),
  // The owner answers late: the hold lapsed and someone else may have taken the time meanwhile.
  fc.record({ biz, start: slotStart, wait: fc.integer({ min: 5, max: 15 }), other: fc.integer({ min: -1, max: 1 }) }).map(({ biz, start, wait, other }): Op[] => [
    { kind: "create", biz, quote: false },
    { kind: "hold", biz, b: "last", start, len: 2 },
    { kind: "text", biz, b: "last", cls: "accept", inbound: true },
    { kind: "tick", minutes: wait },
    { kind: "create", biz, quote: false },
    { kind: "hold", biz, b: "last", start: start + other, len: 2 },
    { kind: "text", biz, b: "last", cls: "accept", inbound: true },
    { kind: "confirm", b: "last", ev: { kind: "text", m: "last" } },
    { kind: "confirm", b: "prev", ev: { kind: "text", m: "prev" } },
  ]),
);

const program = fc.array(fc.oneof({ arbitrary: primitive.map((o) => [o]), weight: 3 }, { arbitrary: journey, weight: 1 }), { minLength: 1, maxLength: 14 }).map((chunks) => chunks.flat());

// ---- The world the program runs in ------------------------------------------------------------

interface World {
  db: Db;
  clock: ManualClock;
  ctx: BookingContext;
  businesses: Business[];
  bookings: string[];
  holds: string[];
  calls: string[];
  messages: string[];
  rules: string[];
}

function newWorld(): World {
  const db = openDb(":memory:");
  const clock = manualClock("2026-10-12T17:00:00.000Z");
  const businesses = seed(db, { clock }).slice(0, 2);
  return { db, clock, ctx: { db, clock, bus: { publish: () => undefined } }, businesses, bookings: [], holds: [], calls: [], messages: [], rules: [] };
}

const pick = <T,>(list: T[], r: Ref): T | undefined =>
  list.length === 0 ? undefined : r === "last" || (typeof r === "number" && r < 0) ? list.at(-1) : r === "prev" ? list.at(-2) : list[r % list.length];
const emitOpts = (w: World) => ({ clock: w.clock, bus: { publish: () => undefined } });

/** Counts what the generated programs actually exercised, so the properties cannot pass vacuously. */
const seen = { steps: 0, refused: 0, confirmed: { call: 0, text: 0, rule: 0 } as Record<string, number> };

function evidenceFor(w: World, spec: EvidenceSpec): ConfirmationEvidence {
  switch (spec.kind) {
    case "call":
      return { kind: "call", callId: pick(w.calls, spec.c) ?? "call_ghost", quotedSentence: spec.quote };
    case "text":
      return { kind: "text", messageId: pick(w.messages, spec.m) ?? "msg_ghost" };
    case "rule":
      return { kind: "rule", ruleId: pick(w.rules, spec.r) ?? "rul_ghost" };
    default:
      return spec.as === "call"
        ? { kind: "call", callId: newId("call"), quotedSentence: "Yes" }
        : spec.as === "text"
          ? { kind: "text", messageId: newId("message") }
          : { kind: "rule", ruleId: newId("rule") };
  }
}

/** Runs one primitive. Returns false when the engine refused it (a BookingError), which is always allowed. */
function run(w: World, op: Op): boolean {
  const now = () => w.clock.now().toISOString();
  const business = (i: number) => w.businesses[i % w.businesses.length]!;
  try {
    switch (op.kind) {
      case "create": {
        const b = createBooking(w.ctx, { business_id: business(op.biz).id, agent_id: "prop", service: "oil change", status: op.quote ? "quote_pending" : "pending", route: "call" });
        w.bookings.push(b.id);
        return true;
      }
      case "transition": {
        const id = pick(w.bookings, op.b);
        if (!id) return true;
        transition(w.ctx, id, op.to, { actor: "system", reason: "property test" });
        return true;
      }
      case "confirm": {
        const id = pick(w.bookings, op.b);
        if (!id) return true;
        const ev = evidenceFor(w, op.ev);
        confirm(w.ctx, id, ev);
        seen.confirmed[ev.kind]!++;
        return true;
      }
      case "hold": {
        const bookingId = op.b === null ? null : (pick(w.bookings, op.b) ?? null);
        const bizId = bookingId ? getRow(w.db, "bookings", bookingId)!.business_id : business(op.biz).id;
        const start = T0 + op.start * HALF_HOUR;
        const h = placeHold(w.ctx, { business_id: bizId, booking_id: bookingId, slot_start: new Date(start).toISOString(), slot_end: new Date(start + op.len * HALF_HOUR).toISOString(), created_by: "voice" });
        w.holds.push(h.id);
        return true;
      }
      case "attach": {
        const h = pick(w.holds, op.h);
        const b = pick(w.bookings, op.b);
        if (!h || !b) return true;
        attachHold(w.ctx, h, b, op.price, "voice");
        return true;
      }
      case "release": {
        const h = pick(w.holds, op.h);
        if (!h) return true;
        releaseHold(w.ctx, h, "system", "property test");
        return true;
      }
      case "tick":
        w.clock.advance(op.minutes * 60_000);
        expireHolds(w.ctx);
        return true;
      case "call": {
        const bookingId = op.b === null ? null : (pick(w.bookings, op.b) ?? null);
        const bizId = bookingId ? getRow(w.db, "bookings", bookingId)!.business_id : business(op.biz).id;
        // One live call per business is the call service's rule, not the engine's; the world respects it.
        if (selectRows(w.db, "calls", "business_id = ? AND ended_at IS NULL", [bizId]).length) return true;
        const call: Call = {
          id: newId("call", w.clock.now().getTime()),
          business_id: bizId,
          booking_id: bookingId,
          dial_call_id: null,
          direction: "outbound",
          to_e164: getRow(w.db, "businesses", bizId)!.phone_e164,
          status: "In-Progress",
          script_version: "prop",
          started_at: now(),
          ended_at: null,
          duration_seconds: null,
          end_reason: null,
          transcript: null,
          transcript_turns: null,
          mined: null,
          friction_score: null,
          created_at: now(),
          updated_at: now(),
        };
        insertRow(w.db, "calls", call);
        emit(w.db, { type: "call.placed", actor: "system", refs: { call_id: call.id, business_id: bizId, ...(bookingId ? { booking_id: bookingId } : {}) }, reason: "outbound call queued" }, emitOpts(w));
        w.calls.push(call.id);
        return true;
      }
      case "hangup": {
        const id = pick(w.calls, op.c);
        const call = id ? getRow(w.db, "calls", id) : undefined;
        if (!call || call.ended_at) return true;
        updateRow(w.db, "calls", call.id, { status: "Terminated", ended_at: now(), updated_at: now() });
        emit(w.db, { type: "call.ended", actor: "system", refs: { call_id: call.id, business_id: call.business_id }, reason: "Dial reported the call ended" }, emitOpts(w));
        return true;
      }
      case "text": {
        const bookingId = op.b === null ? null : (pick(w.bookings, op.b) ?? null);
        const bizId = bookingId ? getRow(w.db, "bookings", bookingId)!.business_id : business(op.biz).id;
        const message: Message = {
          id: newId("message", w.clock.now().getTime()),
          business_id: bizId,
          booking_id: bookingId,
          direction: op.inbound ? "inbound" : "outbound",
          channel: "imessage",
          from_e164: "+14155550100",
          to_e164: "+14155550199",
          body: op.cls === "accept" ? "Y" : "N",
          provider_message_id: newId("message"),
          status: op.inbound ? "received" : "sent",
          reply_class: op.cls,
          classification: null,
          created_at: now(),
        };
        insertRow(w.db, "messages", message);
        // An outbound row is written without its message.sent event: it only exists to be offered as forged evidence.
        if (op.inbound) {
          const refs = { message_id: message.id, business_id: bizId, ...(bookingId ? { booking_id: bookingId } : {}) };
          emit(w.db, { type: "message.received", actor: "owner", refs, payload: { channel: "imessage", body: message.body }, reason: "owner replied" }, emitOpts(w));
          if (op.cls) emit(w.db, { type: "reply.classified", actor: "system", refs, payload: { class: op.cls }, reason: "classified" }, emitOpts(w));
        }
        w.messages.push(message.id);
        return true;
      }
      case "rule": {
        const confirmedBy = op.confirmedBy === null ? null : (pick(w.messages, op.confirmedBy) ?? null);
        const rule: Rule = {
          id: newId("rule", w.clock.now().getTime()),
          business_id: business(op.biz).id,
          source_text: "auto-accept oil changes",
          compiled_policy: {},
          status: confirmedBy ? "active" : "draft",
          version: 1,
          confirmed_message_id: confirmedBy,
          created_at: now(),
          updated_at: now(),
        };
        insertRow(w.db, "rules", rule);
        w.rules.push(rule.id);
        return true;
      }
    }
  } catch (error) {
    if (error instanceof BookingError) return false;
    throw error;
  }
}

// ---- The invariants -----------------------------------------------------------------------------

const overlap = (a: { slot_start: string | null; slot_end: string | null }, b: { slot_start: string | null; slot_end: string | null }) =>
  a.slot_start !== null && a.slot_end !== null && b.slot_start !== null && b.slot_end !== null && a.slot_start < b.slot_end && b.slot_start < a.slot_end;

/** Non-negotiable 1 restated independently of the engine: the evidence on a confirmed booking must check out. */
function evidenceProblem(db: Db, b: Booking): string | null {
  const ev = b.confirmation_evidence;
  if (!ev) return "no evidence";
  switch (ev.kind) {
    case "call": {
      const call = getRow(db, "calls", ev.callId) ?? selectRows(db, "calls", "dial_call_id = ?", [ev.callId])[0];
      if (!call) return "unknown call";
      if (call.business_id !== b.business_id) return "call with another business";
      if (!ev.quotedSentence.trim()) return "unquoted yes";
      if (b.slot_start === null || b.price_cents === null) return "not booked through the tools";
      if (!selectRows(db, "holds", "booking_id = ? AND status IN ('active', 'converted')", [b.id]).length) return "no hold";
      return null;
    }
    case "text": {
      const m = getRow(db, "messages", ev.messageId);
      if (!m) return "unknown message";
      if (m.direction !== "inbound") return "not from the owner";
      if (m.business_id !== b.business_id) return "message from another business";
      if (m.reply_class !== "accept") return `reply was ${m.reply_class}`;
      return null;
    }
    case "rule": {
      const r = getRow(db, "rules", ev.ruleId);
      if (!r) return "unknown rule";
      if (r.business_id !== b.business_id) return "rule of another business";
      if (r.status !== "active" || !r.confirmed_message_id) return "rule not confirmed by the owner";
      return null;
    }
    default:
      return "unknown evidence kind";
  }
}

function checkWorld(w: World): void {
  const bookings = selectRows(w.db, "bookings");
  for (const b of bookings) {
    if (b.status === "confirmed") expect(evidenceProblem(w.db, b), `confirmed ${b.short_code}`).toBeNull();
  }
  const active = selectRows(w.db, "holds", "status = 'active'");
  const occupying = bookings.filter((b) => (OCCUPYING_STATUSES as readonly string[]).includes(b.status));
  for (const [i, a] of active.entries()) {
    for (const h of active.slice(i + 1)) if (a.business_id === h.business_id) expect(overlap(a, h), `holds ${a.id} and ${h.id} overlap`).toBe(false);
    for (const b of occupying) if (b.business_id === a.business_id && b.id !== a.booking_id) expect(overlap(a, b), `hold ${a.id} overlaps booking ${b.short_code}`).toBe(false);
  }
  for (const [i, a] of occupying.entries()) {
    for (const b of occupying.slice(i + 1)) if (a.business_id === b.business_id) expect(overlap(a, b), `bookings ${a.short_code} and ${b.short_code} overlap`).toBe(false);
  }
}

const statusEvent = (e: PlatypusEvent) => e.type.startsWith("booking.") && (BOOKING_STATUSES as readonly string[]).includes(e.type.slice(8));
const holdEvent = (e: PlatypusEvent) => /^hold\.(placed|converted|released|expired)$/.test(e.type);

/** Every state change is exactly one event, and a refused operation leaves no trace. */
function stepAndAccount(w: World, op: Op): void {
  const before = new Map(selectRows(w.db, "bookings").map((b) => [b.id, b.status]));
  const holdsBefore = new Map(selectRows(w.db, "holds").map((h) => [h.id, h.status]));
  const lastId = listEvents(w.db, { limit: 10_000 }).at(-1)?.id;
  const ok = run(w, op);
  seen.steps++;
  const fresh = listEvents(w.db, { ...(lastId ? { afterId: lastId } : {}), limit: 10_000 });
  if (!ok) {
    seen.refused++;
    expect(fresh, `a refused ${op.kind} must not append events`).toEqual([]);
    expect(new Map(selectRows(w.db, "bookings").map((b) => [b.id, b.status]))).toEqual(before);
    return;
  }
  for (const b of selectRows(w.db, "bookings")) {
    const mine = fresh.filter((e) => statusEvent(e) && e.refs.booking_id === b.id);
    const was = before.get(b.id);
    if (was === b.status) expect(mine, `${b.short_code} did not change but has status events`).toEqual([]);
    else {
      expect(mine.map((e) => e.type), `${b.short_code} ${was ?? "(new)"} -> ${b.status}`).toEqual([`booking.${b.status}`]);
      if (was) expect(mine[0]!.payload).toMatchObject({ from: was, to: b.status });
    }
  }
  for (const h of selectRows(w.db, "holds") as Hold[]) {
    const mine = fresh.filter((e) => holdEvent(e) && e.refs.hold_id === h.id);
    if (holdsBefore.get(h.id) === h.status) expect(mine).toEqual([]);
    else expect(mine.map((e) => e.type)).toEqual([`hold.${h.status === "active" ? "placed" : h.status}`]);
  }
}

describe("booking engine, property-based", () => {
  it("never confirms without valid evidence, never double-books, logs every change once, and always audits clean", () => {
    fc.assert(
      fc.property(program, (ops) => {
        const w = newWorld();
        for (const op of ops) {
          stepAndAccount(w, op);
          checkWorld(w);
        }
        const audit = auditEventLog(listEvents(w.db, { limit: 10_000 }));
        if (!audit.ok) throw new Error(formatAuditReport(audit));
        w.db.close();
      }),
    );
    // The generator must actually reach the interesting states.
    expect(seen.confirmed.call).toBeGreaterThan(20);
    expect(seen.confirmed.text).toBeGreaterThan(20);
    expect(seen.refused).toBeGreaterThan(100);
  }, 120_000);

  // The shrunk counterexamples fast-check found before the engine fixes, kept as fixed regressions.
  const regressions: Record<string, Op[]> = {
    "a hold moved a confirmed booking's slot": [
      { kind: "create", biz: 0, quote: false },
      { kind: "call", biz: 0, b: "last" },
      { kind: "hold", biz: 0, b: "last", start: 0, len: 2 },
      { kind: "attach", h: "last", b: "last", price: 0 },
      { kind: "confirm", b: "last", ev: { kind: "call", c: -1, quote: "Yep, booked." } },
      { kind: "hold", biz: 0, b: 0, start: 2, len: 1 },
    ],
    "one yes confirmed a second booking": [
      { kind: "create", biz: 0, quote: false },
      { kind: "hold", biz: 0, b: "last", start: 0, len: 1 },
      { kind: "text", biz: 0, b: "last", cls: "accept", inbound: true },
      { kind: "confirm", b: "last", ev: { kind: "text", m: -1 } },
      { kind: "create", biz: 0, quote: false },
      { kind: "confirm", b: "last", ev: { kind: "text", m: 0 } },
    ],
    "call evidence after the call ended": [
      { kind: "create", biz: 0, quote: false },
      { kind: "call", biz: 0, b: "last" },
      { kind: "hold", biz: 0, b: "last", start: 0, len: 2 },
      { kind: "attach", h: "last", b: "last", price: 0 },
      { kind: "hangup", c: 0 },
      { kind: "confirm", b: 0, ev: { kind: "call", c: 0, quote: "Yep, booked." } },
    ],
    "a hold reassigned from another booking": [
      { kind: "create", biz: 0, quote: false },
      { kind: "call", biz: 0, b: "last" },
      { kind: "hold", biz: 0, b: "last", start: 1, len: 2 },
      { kind: "attach", h: "last", b: "last", price: 0 },
      { kind: "hold", biz: 0, b: 0, start: 0, len: 1 },
      { kind: "create", biz: 0, quote: false },
      { kind: "attach", h: "last", b: "last", price: 0 },
      { kind: "confirm", b: 0, ev: { kind: "call", c: 0, quote: "Yep, booked." } },
    ],
    "a late yes double-booked": [
      { kind: "create", biz: 0, quote: false },
      { kind: "hold", biz: 0, b: "last", start: 0, len: 2 },
      { kind: "text", biz: 0, b: "last", cls: "accept", inbound: true },
      { kind: "tick", minutes: 10 },
      { kind: "create", biz: 0, quote: false },
      { kind: "hold", biz: 0, b: "last", start: 0, len: 2 },
      { kind: "text", biz: 0, b: "last", cls: "accept", inbound: true },
      { kind: "confirm", b: "last", ev: { kind: "text", m: "last" } },
      { kind: "confirm", b: "prev", ev: { kind: "text", m: "prev" } },
    ],
  };
  it.each(Object.entries(regressions))("regression: %s", (_name, ops) => {
    const w = newWorld();
    for (const op of ops) {
      stepAndAccount(w, op);
      checkWorld(w);
    }
    const audit = auditEventLog(listEvents(w.db, { limit: 10_000 }));
    expect(audit.violations).toEqual([]);
    w.db.close();
  });

  it("transition() can never reach confirmed, from any state", () => {
    fc.assert(
      fc.property(fc.constantFrom(...BOOKING_STATUSES), (from) => {
        const w = newWorld();
        const b = createBooking(w.ctx, { business_id: w.businesses[0]!.id, agent_id: "prop", service: "oil change" });
        updateRow(w.db, "bookings", b.id, { status: from });
        expect(() => transition(w.ctx, b.id, "confirmed", { actor: "owner", reason: "trust me" })).toThrow(/evidence/);
        expect(getRow(w.db, "bookings", b.id)!.status).toBe(from);
        w.db.close();
      }),
      { numRuns: 24 },
    );
  });
});
