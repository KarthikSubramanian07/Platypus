import { BookingError, getBooking, HOLD_TTL_MS, placeHold } from "@platypus/shared/booking";
import { VoiceAuthorizationError } from "@platypus/shared/contracts";
import { getRow, selectRows } from "@platypus/shared/db";
import { beforeEach, describe, expect, it } from "vitest";
import { callFixture, TOMORROW_AFTERNOON, type CallFixture } from "./call-fixture";
import { VoiceToolInputError } from "./errors";
import { createVoiceTools } from "./voice-tools";

let f: CallFixture;
let tools: ReturnType<typeof createVoiceTools>;
const TWO_PM = { start: "2026-10-12T21:00:00.000Z", end: "2026-10-12T21:45:00.000Z" };

beforeEach(() => {
  f = callFixture();
  tools = createVoiceTools({ db: f.db, bus: f.bus, clock: f.clock, textChannel: "imessage" });
});

const lastToolEvent = () => f.events("voice.tool_called").at(-1)!;

describe("check_slot", () => {
  it("offers the booked service's duration inside business hours", async () => {
    const { slots } = await tools.check_slot({ business_id: f.sal.id, window: TOMORROW_AFTERNOON }, f.ctx);
    expect(slots).toHaveLength(5);
    expect(slots[0]).toEqual({ start: "2026-10-12T19:00:00.000Z", end: "2026-10-12T19:45:00.000Z" }); // oil change: 45 min
    expect(lastToolEvent().payload).toMatchObject({ tool: "check_slot", ok: true });
  });

  it("leaves out times another booking holds, but keeps this call's own hold", async () => {
    placeHold({ db: f.db, clock: f.clock, bus: f.bus }, { business_id: f.sal.id, slot_start: "2026-10-12T20:00:00.000Z", slot_end: "2026-10-12T20:45:00.000Z", created_by: "system" });
    await tools.hold_slot({ business_id: f.sal.id, slot: TWO_PM }, f.ctx);
    const { slots } = await tools.check_slot({ business_id: f.sal.id, window: TOMORROW_AFTERNOON }, f.ctx);
    const starts = slots.map((s) => s.start);
    expect(starts).not.toContain("2026-10-12T20:00:00.000Z");
    expect(starts).toContain(TWO_PM.start);
  });
});

describe("hold_slot", () => {
  it("accepts a free time the owner names even if check_slot never offered it, outside listed hours too", async () => {
    const evening = { start: "2026-10-13T02:00:00.000Z", end: "2026-10-13T02:45:00.000Z" }; // Monday 7pm, after closing
    const hold = await tools.hold_slot({ business_id: f.sal.id, slot: evening }, f.ctx);
    expect(getRow(f.db, "holds", hold.hold_id)).toMatchObject({ status: "active", slot_start: evening.start, booking_id: f.booking.id });
  });

  it("is idempotent within the call: the same slot twice returns the same hold", async () => {
    const a = await tools.hold_slot({ business_id: f.sal.id, slot: TWO_PM }, f.ctx);
    const b = await tools.hold_slot({ business_id: f.sal.id, slot: { start: "2026-10-12T14:00:00-07:00", end: "2026-10-12T14:45:00-07:00" } }, f.ctx);
    expect(b).toEqual(a);
    expect(selectRows(f.db, "holds")).toHaveLength(1);
    expect(lastToolEvent().payload).toMatchObject({ ok: true, replayed: true });
  });

  it("releases the call's earlier hold when the owner switches to an overlapping time", async () => {
    const first = await tools.hold_slot({ business_id: f.sal.id, slot: TWO_PM }, f.ctx);
    const later = { start: "2026-10-12T21:30:00.000Z", end: "2026-10-12T22:15:00.000Z" };
    const second = await tools.hold_slot({ business_id: f.sal.id, slot: later }, f.ctx);
    expect(second.hold_id).not.toBe(first.hold_id);
    expect(getRow(f.db, "holds", first.hold_id)!.status).toBe("released");
    expect(getBooking({ db: f.db }, f.booking.id).slot_start).toBe(later.start);
    expect(f.events("hold.released")).toHaveLength(1);
  });

  it("refuses a time someone else holds, keeps the earlier hold, and logs slot_unavailable", async () => {
    const mine = await tools.hold_slot({ business_id: f.sal.id, slot: TWO_PM }, f.ctx);
    placeHold({ db: f.db, clock: f.clock, bus: f.bus }, { business_id: f.sal.id, slot_start: "2026-10-12T23:00:00.000Z", slot_end: "2026-10-12T23:45:00.000Z", created_by: "system" });
    await expect(tools.hold_slot({ business_id: f.sal.id, slot: { start: "2026-10-12T23:00:00.000Z", end: "2026-10-12T23:45:00.000Z" } }, f.ctx)).rejects.toMatchObject({ code: "slot_unavailable" });
    expect(getRow(f.db, "holds", mine.hold_id)!.status).toBe("active");
    expect(lastToolEvent()).toMatchObject({ payload: { tool: "hold_slot", ok: false, code: "slot_unavailable" }, reason: "hold_slot failed: slot_unavailable" });
  });

  it("refuses a time that has passed", async () => {
    await expect(tools.hold_slot({ business_id: f.sal.id, slot: { start: "2026-10-10T19:00:00.000Z", end: "2026-10-10T19:45:00.000Z" } }, f.ctx)).rejects.toBeInstanceOf(BookingError);
  });

  it("places a fresh hold after the first one expired", async () => {
    const a = await tools.hold_slot({ business_id: f.sal.id, slot: TWO_PM }, f.ctx);
    f.clock.advance(HOLD_TTL_MS + 1);
    const b = await tools.hold_slot({ business_id: f.sal.id, slot: TWO_PM }, f.ctx);
    expect(b.hold_id).not.toBe(a.hold_id);
  });
});

describe("create_booking", () => {
  it("sets the price and confirms only through confirm() with call evidence", async () => {
    const hold = await tools.hold_slot({ business_id: f.sal.id, slot: TWO_PM }, f.ctx);
    const out = await tools.create_booking({ hold_id: hold.hold_id, price_cents: 8900, verbal_confirmation: "Yep, booked." }, f.ctx);
    const b = getBooking({ db: f.db }, out.booking_id);
    expect(b).toMatchObject({ id: f.booking.id, status: "confirmed", price_cents: 8900, slot_start: TWO_PM.start, short_code: out.short_code });
    expect(b.confirmation_evidence).toEqual({ kind: "call", callId: f.call.id, quotedSentence: "Yep, booked." });
  });

  it("returns the same booking when the voice model retries", async () => {
    const hold = await tools.hold_slot({ business_id: f.sal.id, slot: TWO_PM }, f.ctx);
    const input = { hold_id: hold.hold_id, price_cents: 8900, verbal_confirmation: "Yep, booked." };
    const a = await tools.create_booking(input, f.ctx);
    const b = await tools.create_booking(input, f.ctx);
    expect(b).toEqual(a);
    expect(f.events("booking.confirmed")).toHaveLength(1);
  });

  it("strips links from the quoted sentence", async () => {
    const hold = await tools.hold_slot({ business_id: f.sal.id, slot: TWO_PM }, f.ctx);
    await tools.create_booking({ hold_id: hold.hold_id, price_cents: 8900, verbal_confirmation: "Yes see https://evil.example now" }, f.ctx);
    expect(getBooking({ db: f.db }, f.booking.id).confirmation_evidence).toMatchObject({ quotedSentence: "Yes see [link removed] now" });
  });

  it("refuses an unknown hold and an expired hold", async () => {
    await expect(tools.create_booking({ hold_id: "hld_nope", price_cents: 8900, verbal_confirmation: "Yes" }, f.ctx)).rejects.toMatchObject({ code: "not_found" });
    const hold = await tools.hold_slot({ business_id: f.sal.id, slot: TWO_PM }, f.ctx);
    f.clock.advance(HOLD_TTL_MS + 1);
    await expect(tools.create_booking({ hold_id: hold.hold_id, price_cents: 8900, verbal_confirmation: "Yes" }, f.ctx)).rejects.toMatchObject({ code: "hold_not_active" });
    expect(getBooking({ db: f.db }, f.booking.id).status).toBe("pending");
  });

  it("refuses a hold that belongs to another business", async () => {
    const other = placeHold({ db: f.db, clock: f.clock, bus: f.bus }, { business_id: f.mira.id, slot_start: TWO_PM.start, slot_end: TWO_PM.end, created_by: "system" });
    await expect(tools.create_booking({ hold_id: other.id, price_cents: 1, verbal_confirmation: "Yes" }, f.ctx)).rejects.toBeInstanceOf(VoiceAuthorizationError);
    expect(getBooking({ db: f.db }, f.booking.id).status).toBe("pending");
  });
});

describe("record_consent and set_text_number", () => {
  it("records consent once per call and flips the business to text on TEXT_CHANNEL", async () => {
    const a = await tools.record_consent({ business_id: f.sal.id, channel: "imessage", quote: "Yeah, text me." }, f.ctx);
    const b = await tools.record_consent({ business_id: f.sal.id, channel: "imessage", quote: "Yeah, text me." }, f.ctx);
    expect(b).toEqual(a);
    expect(selectRows(f.db, "consents")).toHaveLength(1);
    expect(getRow(f.db, "consents", a.consent_id)).toMatchObject({ source: "call", call_id: f.call.id, quoted_sentence: "Yeah, text me." });
    expect(getRow(f.db, "businesses", f.sal.id)).toMatchObject({ channel_state: "text_enabled", channel_pref: "imessage" });
    expect(f.events("consent.recorded")).toHaveLength(1);
    expect(f.events("business.channel_changed")[0]!.payload).toEqual({ from: "phone_only", to: "text_enabled", rail: "imessage" });
  });

  it("stores the number but never puts it in an event", async () => {
    await tools.set_text_number({ business_id: f.sal.id, e164: "+14155550177" }, f.ctx);
    expect(getRow(f.db, "businesses", f.sal.id)!.text_number_e164).toBe("+14155550177");
    const event = f.events("business.text_number_set")[0]!;
    expect(event.payload).toEqual({ number_masked: "+1415•••0177", same_as_called: false });
    expect(JSON.stringify(f.events())).not.toContain("+14155550177");
  });

  it("marks 'this one' as the called number", async () => {
    await tools.set_text_number({ business_id: f.sal.id, e164: f.sal.phone_e164 }, f.ctx);
    expect(f.events("business.text_number_set")[0]!.payload).toMatchObject({ same_as_called: true });
  });
});

describe("authorization and logging", () => {
  it("refuses inbound calls, unknown callers, template headers and ended calls, and logs each refusal", async () => {
    const input = { business_id: f.sal.id, window: TOMORROW_AFTERNOON };
    await expect(tools.check_slot(input, { ...f.ctx, direction: "inbound" })).rejects.toBeInstanceOf(VoiceAuthorizationError);
    await expect(tools.check_slot(input, { ...f.ctx, caller_number: "+14155550999" })).rejects.toBeInstanceOf(VoiceAuthorizationError);
    await expect(tools.check_slot(input, { ...f.ctx, caller_number: "{{user_number}}" })).rejects.toBeInstanceOf(VoiceAuthorizationError);
    f.endCall();
    await expect(tools.check_slot(input, f.ctx)).rejects.toThrow(/No live call/);
    const failures = f.events("voice.tool_called").map((e) => e.payload.code);
    expect(failures).toEqual(["not_outbound", "unauthorized", "unauthorized", "unauthorized"]);
    expect(JSON.stringify(f.events("voice.tool_called"))).not.toContain("+14155550999");
  });

  it("logs invalid input with the field names only", async () => {
    await expect(tools.set_text_number({ business_id: f.sal.id, e164: "555" }, f.ctx)).rejects.toBeInstanceOf(VoiceToolInputError);
    expect(lastToolEvent().payload).toMatchObject({ tool: "set_text_number", ok: false, code: "invalid_input", error: "Invalid input: e164" });
  });
});
