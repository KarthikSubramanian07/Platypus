import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createBooking, getBooking, placeHold } from "@platypus/shared/booking";
import { getActiveConsent, getBusinessBySlug, openDb } from "@platypus/shared/db";
import { EventBus, listEvents } from "@platypus/shared/events";
import { generateContextMcpSecret, generateContextMcpToken } from "./context-mcp/secret";
import { createPhoneSide, MAX_DEMO_BODY_BYTES, replayTimeScale } from "./phone-side";

const ENV = { DEMO_MODE: "fakes", TEXT_CHANNEL: "imessage", CONTEXT_MCP_SECRET: generateContextMcpSecret(), CONTEXT_MCP_TOKEN: generateContextMcpToken() } as NodeJS.ProcessEnv;

async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = read();
    if (ok(v)) return v;
    if (Date.now() - start > ms) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.each(["imessage", "dial"] as const)("phone side on the %s rail, end to end against FakeDial", (rail) => {
  it("books on the call, records consent, then books the next job by text Y", async () => {
    const db = openDb(":memory:");
    const bus = new EventBus();
    const side = createPhoneSide({ db, bus }, { env: { ...ENV, TEXT_CHANNEL: rail }, fakeTimeScale: 0 });
    side.mount(new Hono());
    expect(side.mode).toBe("fake");
    const sal = getBusinessBySlug(db, "sals-auto")!;
    const ctx = { db, bus };

    // 1. The gateway opens a pending booking with route "call" and hands it to the phone side.
    const window = { window_start: new Date(Date.now() + 86_400_000).toISOString(), window_end: new Date(Date.now() + 2 * 86_400_000).toISOString() };
    const first = createBooking(ctx, { business_id: sal.id, agent_id: "claude-desktop", service: "oil change", route: "call", details: "2019 Civic", requested_by: "Alex's assistant", ...window });
    const { call_id } = await side.owner.startOnboardingCall({ booking_id: first.id, business_id: sal.id });
    expect(call_id).toBeTruthy();

    // 2. FakeDial's scripted owner books through the real VoiceTools mid-call and says yes to texts.
    const booked = await until(() => getBooking(ctx, first.id), (b) => b.status === "confirmed");
    expect(booked.confirmation_evidence).toMatchObject({ kind: "call", quotedSentence: "Yep, booked." });
    await until(() => getActiveConsent(db, sal.id), (c) => Boolean(c));
    expect(getActiveConsent(db, sal.id)).toMatchObject({ source: "call", quoted_sentence: "Yeah, text me.", channel: rail });
    expect(getBusinessBySlug(db, "sals-auto")!.channel_state).toBe("text_enabled");
    await side.calls.idle();
    await until(() => listEvents(db, { type: "call.transcribed" }), (e) => e.length === 1);

    // 3. Second request: route "text". One message, the owner's Y confirms it, no second call.
    const second = createBooking(ctx, { business_id: sal.id, agent_id: "claude-desktop", service: "brake inspection", route: "text", details: "2019 Civic", requested_by: "Alex's assistant", ...window });
    const slot = new Date(Date.now() + 3 * 86_400_000);
    slot.setUTCHours(17, 0, 0, 0);
    placeHold(ctx, { business_id: sal.id, booking_id: second.id, slot_start: slot.toISOString(), slot_end: new Date(slot.getTime() + 30 * 60_000).toISOString(), created_by: "system" });
    const sent = await side.owner.sendBookingRequest({ booking_id: second.id, business_id: sal.id });
    expect(sent).toHaveProperty("message_id");
    const confirmed = await until(() => getBooking(ctx, second.id), (b) => b.status === "confirmed");
    expect(confirmed.confirmation_evidence?.kind).toBe("text");
    expect(side.fake!.listCalls().calls).toHaveLength(1);
    // Dial-to-Dial sends "sms" (only to a Dial line); the other rails send on themselves.
    expect(side.fake!.messages.filter((m) => m.direction === "outbound").map((m) => m.channel)).toContain(rail === "dial" ? "sms" : rail);

    const tools = listEvents(db, { type: "voice.tool_called" }).map((e) => e.payload.tool);
    expect(tools).toEqual(["check_slot", "hold_slot", "create_booking", "record_consent", "set_text_number"]);
    side.calls.dispose();
  });

});

describe("phone side controls", () => {
  it("lets the dashboard's owner phone reply in fake mode", async () => {
    const db = openDb(":memory:");
    const side = createPhoneSide({ db, bus: new EventBus() }, { env: ENV, fakeTimeScale: 0 });
    const app = new Hono();
    side.mount(app);
    const res = await app.request("/demo/owner-reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "HELP" }) });
    expect(await res.json()).toMatchObject({ ok: true });
    await side.text.drain();
    expect(listEvents(db, { type: "message.received" })).toHaveLength(1);
    side.calls.dispose();
  });

  it("refuses an oversized demo body and clamps the replay pacing", async () => {
    const db = openDb(":memory:");
    const side = createPhoneSide({ db, bus: new EventBus() }, { env: ENV, fakeTimeScale: 0 });
    const app = new Hono();
    side.mount(app);
    const huge = JSON.stringify({ body: "Y".repeat(MAX_DEMO_BODY_BYTES) });
    const res = await app.request("/demo/owner-reply", { method: "POST", headers: { "content-type": "application/json", "content-length": String(huge.length) }, body: huge });
    expect(res.status).toBe(413);
    await side.text.drain();
    expect(listEvents(db, { type: "message.received" })).toHaveLength(0);
    expect([replayTimeScale(undefined), replayTimeScale("1e9"), replayTimeScale("-3"), replayTimeScale("abc"), replayTimeScale("0.5")]).toEqual([0, 4, 0, 0, 0.5]);
    side.calls.dispose();
  });

  it("refuses to place a second onboarding call while one is live", async () => {
    const db = openDb(":memory:");
    const side = createPhoneSide({ db, bus: new EventBus() }, { env: ENV, fakeTimeScale: 1 });
    const sal = getBusinessBySlug(db, "sals-auto")!;
    const a = createBooking({ db }, { business_id: sal.id, agent_id: "a", service: "oil change", route: "call" });
    const b = createBooking({ db }, { business_id: sal.id, agent_id: "a", service: "oil change", route: "call" });
    await side.owner.startOnboardingCall({ booking_id: a.id, business_id: sal.id });
    await expect(side.owner.startOnboardingCall({ booking_id: b.id, business_id: sal.id })).rejects.toThrow();
    await side.calls.stopCall(undefined, "kill_switch");
    side.calls.dispose();
  });
});
