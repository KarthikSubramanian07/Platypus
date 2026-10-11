import { createBooking } from "@platypus/shared/booking";
import { getBusinessBySlug, insertRow, openDb, seed, updateRow, type Booking, type Business, type Call, type Db } from "@platypus/shared/db";
import { EventBus, listEvents, type PlatypusEvent } from "@platypus/shared/events";
import type { VoiceToolContext } from "@platypus/shared/contracts";
import type { Clock } from "./voice-tools";

/** A clock tests can move. */
export interface TestClock extends Clock {
  set(at: string): void;
  advance(ms: number): void;
}

export function testClock(start: string): TestClock {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    set: (at) => {
      t = Date.parse(at);
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

export interface CallFixture {
  db: Db;
  bus: EventBus;
  clock: TestClock;
  published: PlatypusEvent[];
  sal: Business;
  mira: Business;
  booking: Booking;
  call: Call;
  /** The Dial identity of the live call, as the X-Dial-* headers would carry it. */
  ctx: VoiceToolContext;
  /** Events in the log, oldest first. */
  events(type?: string): PlatypusEvent[];
  endCall(): void;
}

/** Sunday 2026-10-11, 11:00 in San Francisco: "tomorrow" is a Monday. */
export const FIXTURE_NOW = "2026-10-11T18:00:00.000Z";
/** Monday 12:00 to 17:00 Pacific (PDT, UTC-7). */
export const TOMORROW_AFTERNOON = { start: "2026-10-12T19:00:00.000Z", end: "2026-10-13T00:00:00.000Z" };
export const AGENT_NUMBER = "+15550100000";

/**
 * An in-memory database seeded with the six businesses, a pending oil-change
 * booking for Eddy's Auto, and a live outbound call to Sal's (fictional) number.
 */
export function callFixture(): CallFixture {
  const db = openDb(":memory:");
  const bus = new EventBus();
  const published: PlatypusEvent[] = [];
  bus.subscribe((e) => published.push(e));
  const clock = testClock(FIXTURE_NOW);
  seed(db, { clock });
  const sal = getBusinessBySlug(db, "sals-auto")!;
  const mira = getBusinessBySlug(db, "mira-hair-studio")!;
  const booking = createBooking(
    { db, bus, clock },
    { business_id: sal.id, agent_id: "claude-desktop", service: "oil change", route: "call", window_start: TOMORROW_AFTERNOON.start, window_end: TOMORROW_AFTERNOON.end },
  );
  const now = clock.now().toISOString();
  const call = insertRow(db, "calls", {
    id: "call_TESTLIVE0000000000000000001",
    business_id: sal.id,
    booking_id: booking.id,
    dial_call_id: "dial_call_1",
    direction: "outbound",
    to_e164: sal.phone_e164,
    status: "In-Progress",
    script_version: "test",
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
  return {
    db,
    bus,
    clock,
    published,
    sal,
    mira,
    booking,
    call,
    ctx: { caller_number: sal.phone_e164, direction: "outbound", agent_number: AGENT_NUMBER },
    events: (type) => listEvents(db, type ? { type } : {}),
    endCall: () => {
      updateRow(db, "calls", call.id, { status: "Terminated", ended_at: clock.now().toISOString(), updated_at: clock.now().toISOString() });
    },
  };
}
