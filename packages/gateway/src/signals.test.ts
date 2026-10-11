import { beforeEach, describe, expect, it } from "vitest";
import { getBusinessBySlug, openDb, seed, type Db } from "@platypus/shared/db";
import { emit, EventBus, type EmitInput } from "@platypus/shared/events";
import { computeSignals } from "./signals";

let db: Db;
let now: number;
let bizId: string;
const bus = new EventBus();
const clock = { now: () => new Date(now) };
const at = (input: Omit<EmitInput, "refs"> & { booking?: string }, offsetSeconds = 0) => {
  now += offsetSeconds * 1000;
  const { booking, ...rest } = input;
  emit(db, { ...rest, refs: { business_id: bizId, ...(booking ? { booking_id: booking } : {}) } }, { bus, clock });
};

beforeEach(() => {
  db = openDb(":memory:");
  now = Date.parse("2026-10-12T02:00:00.000Z");
  seed(db, { clock });
  bizId = getBusinessBySlug(db, "sals-auto")!.id;
});

describe("computeSignals", () => {
  it("claims nothing without history", () => {
    expect(computeSignals(db, bizId)).toEqual({ source: "local" });
  });

  it("derives price, reply time and acceptance from the event log", () => {
    // Booking A: agreed on a call at $89, then confirmed (same price, counted once).
    at({ type: "booking.slot_agreed", actor: "voice", booking: "bkg_a", payload: { price_cents: 8900 } });
    at({ type: "booking.confirmed", actor: "voice", booking: "bkg_a", payload: { price_cents: 8900 } });
    // Booking B: texted, owner replied 90 seconds later and declined.
    at({ type: "message.sent", actor: "system", booking: "bkg_b", payload: {} });
    at({ type: "message.received", actor: "owner", booking: "bkg_b", payload: {} }, 90);
    at({ type: "booking.declined", actor: "owner", booking: "bkg_b", payload: { price_cents: null } });
    // Booking C: texted, owner replied after 30 seconds with a $95 counter, then said yes.
    at({ type: "message.sent", actor: "system", booking: "bkg_c", payload: {} });
    at({ type: "message.received", actor: "owner", booking: "bkg_c", payload: {} }, 30);
    at({ type: "booking.countered", actor: "owner", booking: "bkg_c", payload: { price_cents: 9500 } });
    at({ type: "booking.confirmed", actor: "owner", booking: "bkg_c", payload: { price_cents: 9500 } });
    // An agent cannot move the typical price.
    at({ type: "agent.tool_called", actor: "agent", payload: { price_cents: 1 } });

    expect(computeSignals(db, bizId)).toEqual({ source: "local", typical_price_cents: 9200, median_reply_seconds: 60, acceptance_rate: 2 / 3 });
  });
});
