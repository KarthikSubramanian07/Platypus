import { describe, expect, it } from "vitest";
import { createBooking, getBooking, placeHold, type BookingContext } from "../booking/index";
import { manualClock } from "../clock";
import { getActiveConsent, getBusinessBySlug, openDb, seed, selectRows, updateRow } from "../db/index";
import { EventBus } from "../events/bus";
import { listEvents } from "../events/log";
import { createFakeGateway, createFakeOwnerChannels, FakeDial } from "./index";

// Sunday 7pm in San Francisco, as in the golden-path fixture.
const NOW = "2026-10-12T02:00:00.000Z";
const TUE_10AM = "2026-10-13T17:00:00.000Z";
const TUE_1030AM = "2026-10-13T17:30:00.000Z";

function world(autoReply?: { body: string; afterMs: number }) {
  const db = openDb(":memory:");
  const clock = manualClock(NOW);
  const bus = new EventBus();
  const ctx: BookingContext = { db, clock, bus };
  seed(db, { clock });
  const sal = getBusinessBySlug(db, "sals-auto")!;
  const dial = new FakeDial({
    allowedNumbers: [sal.phone_e164],
    voiceTools: createFakeGateway({ ...ctx, textChannel: "imessage" }),
    db,
    clock,
    bus,
    timeScale: 0,
    ...(autoReply ? { autoReply } : {}),
  });
  const owner = createFakeOwnerChannels({ dial, db, bus, clock, textChannel: "imessage" });
  return { db, ctx, sal, dial, owner };
}

/** A text-route request with its hold, as request_booking leaves it before calling OwnerChannels. */
function textRequest(ctx: BookingContext, businessId: string) {
  const booking = createBooking(ctx, {
    business_id: businessId,
    agent_id: "claude-desktop",
    service: "brake inspection",
    route: "text",
    window_start: TUE_10AM,
    details: "2019 Civic",
    requested_by: "Alex's assistant",
  });
  placeHold(ctx, { business_id: businessId, slot_start: TUE_10AM, slot_end: TUE_1030AM, booking_id: booking.id, created_by: "system" });
  return booking;
}

describe("FakeOwnerChannels", () => {
  it("runs the golden path: onboarding call books and opts in, then a Y by text confirms", async () => {
    const { db, ctx, sal, dial, owner } = world({ body: "Y", afterMs: 4_000 });

    const first = createBooking(ctx, { business_id: sal.id, agent_id: "claude-desktop", service: "oil change", route: "call", requested_by: "Alex's assistant" });
    const { call_id } = await owner.startOnboardingCall({ booking_id: first.id, business_id: sal.id });
    await dial.settle();
    expect(dial.toolErrors).toEqual([]);

    expect(getBooking(ctx, first.id)).toMatchObject({ status: "confirmed", price_cents: 8900 });
    expect(getBooking(ctx, first.id).confirmation_evidence).toEqual({ kind: "call", callId: call_id, quotedSentence: "Yep, booked." });
    expect(getActiveConsent(db, sal.id)).toMatchObject({ source: "call", quoted_sentence: "Yeah, text me." });
    expect(getBusinessBySlug(db, "sals-auto")).toMatchObject({ channel_state: "text_enabled", text_number_e164: sal.phone_e164 });

    const second = textRequest(ctx, sal.id);
    const sent = await owner.sendBookingRequest({ booking_id: second.id, business_id: sal.id });
    await dial.settle();

    expect(sent).toHaveProperty("message_id");
    const confirmed = getBooking(ctx, second.id);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmation_evidence?.kind).toBe("text");

    const outbound = dial.messages.filter((m) => m.direction === "outbound");
    expect(outbound.map((m) => m.body)).toEqual(["New job via Platypus (AI-assisted): brake inspection, Tue 10am, 2019 Civic. From Alex's assistant. Reply Y, N, or a time."]);
    expect(dial.listCalls().calls).toHaveLength(1);

    const tail = listEvents(db, { bookingId: second.id })
      .map((e) => [e.type, e.actor])
      .slice(-5);
    expect(tail).toEqual([
      ["message.sent", "system"],
      ["message.received", "owner"],
      ["reply.classified", "system"],
      ["hold.converted", "owner"],
      ["booking.confirmed", "owner"],
    ]);
  });

  it("says a call is needed for a phone-only business and sends nothing", async () => {
    const { db, ctx, dial, owner } = world();
    const mira = getBusinessBySlug(db, "mira-hair-studio")!;
    const booking = createBooking(ctx, { business_id: mira.id, agent_id: "a", service: "haircut", route: "text" });

    const result = await owner.sendBookingRequest({ booking_id: booking.id, business_id: mira.id });

    expect(result).toMatchObject({ needs_call: true });
    expect(dial.messages).toEqual([]);
    expect(selectRows(db, "messages")).toEqual([]);
  });

  it("leaves the booking pending on an unclear reply and declines on N", async () => {
    const { db, ctx, sal, dial, owner } = world();
    updateRow(db, "businesses", sal.id, { channel_state: "text_enabled", text_number_e164: sal.phone_e164 });
    const booking = textRequest(ctx, sal.id);
    await owner.sendBookingRequest({ booking_id: booking.id, business_id: sal.id });

    dial.receive({ from: sal.phone_e164, body: "can you do 3?" });
    expect(getBooking(ctx, booking.id).status).toBe("pending");

    dial.receive({ from: sal.phone_e164, body: "N" });
    expect(getBooking(ctx, booking.id).status).toBe("declined");
    expect(selectRows(db, "holds", "booking_id = ?", [booking.id])[0]?.status).toBe("released");
    expect(listEvents(db, { type: "reply.classified" }).map((e) => e.payload.class)).toEqual(["decline"]);
  });
});
