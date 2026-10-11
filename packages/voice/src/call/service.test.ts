import { createBooking, getBooking } from "@platypus/shared/booking";
import { DEMO_SHOP_SLUG, getBusinessBySlug, getRow, openDb, seed, selectRows, updateRow, type Db } from "@platypus/shared/db";
import { listEvents, type PlatypusEvent } from "@platypus/shared/events";
import { createFakeGateway, FakeDial, goldenCallScript, type CallScriptStep } from "@platypus/shared/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialInsufficientCreditError, DialNetworkError, type DialCalls } from "../dial/client";
import { createFakeDialCalls } from "../dial/fake-adapter";
import type { WireCall } from "../dial/wire";
import { DISCLOSURE } from "./instruction";
import { CallPlacementError, CallRefusedError, createCallService, MAX_CALLS_PER_NUMBER_PER_HOUR, type CallService } from "./service";

const NOW = "2026-10-11T19:00:00.000Z";

function manualClock(start = NOW) {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}
const wallClock = { now: () => new Date() };

interface Setup {
  db: Db;
  fake: FakeDial;
  calls: DialCalls;
  service: CallService;
  bookingId: string;
  businessId: string;
  phone: string;
}

const services: CallService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
  vi.useRealTimers();
});

function setup(options: {
  tools?: boolean;
  demoMode?: boolean;
  timeScale?: number;
  clock?: { now(): Date; advance?: (ms: number) => void };
  script?: (steps: CallScriptStep[]) => CallScriptStep[];
  calls?: (fake: FakeDial) => DialCalls;
} = {}): Setup {
  const clock = options.clock ?? manualClock();
  const db = openDb(":memory:");
  seed(db, { clock });
  const sal = getBusinessBySlug(db, DEMO_SHOP_SLUG)!;
  const booking = createBooking({ db, clock }, {
    business_id: sal.id,
    agent_id: "claude-desktop",
    service: "oil change",
    route: "call",
    window_start: "2026-10-12T19:00:00.000Z",
    window_end: "2026-10-13T00:00:00.000Z",
    details: "2019 Civic",
    requested_by: "Alex's assistant",
  });
  // FakeDial without `db`: the call service owns the calls table and the call.* events.
  const fake = new FakeDial({
    allowedNumbers: [sal.phone_e164],
    clock,
    timeScale: options.timeScale ?? 0.001,
    ...(options.tools === false ? {} : { voiceTools: createFakeGateway({ db, clock, textChannel: "imessage" }) }),
    ...(options.script ? { script: (_s, now) => options.script!(goldenCallScript({ now })) } : {}),
  });
  const calls = options.calls ? options.calls(fake) : createFakeDialCalls(fake);
  const service = createCallService({ db, clock, calls, fromNumberId: "num_fake", demoMode: options.demoMode ?? false, textChannel: "imessage", anthropic: null });
  services.push(service);
  return { db, fake, calls, service, bookingId: booking.id, businessId: sal.id, phone: sal.phone_e164 };
}

async function runCall(s: Setup) {
  const { call_id } = await s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId });
  await s.fake.settle();
  await s.service.idle();
  return call_id;
}

const callEvents = (db: Db, callId: string) => listEvents(db).filter((e) => e.refs.call_id === callId && !e.payload.replayed);
const ofType = (events: PlatypusEvent[], type: string) => events.filter((e) => e.type === type);

/** A stub Dial for the cases FakeDial cannot produce (ambiguous POSTs, calls placed elsewhere). */
function stubCalls(over: Partial<DialCalls>): DialCalls {
  const wire = (state = "Queued"): WireCall => ({ id: "call_remote", to: "+14155550101", status: { state }, createdAt: NOW });
  return {
    placeCall: vi.fn(async () => wire()),
    listCalls: vi.fn(async () => []),
    getCall: vi.fn(async () => wire()),
    stopCall: vi.fn(async () => ({ cancelPending: false, call: null })),
    ...over,
  };
}

describe("startOnboardingCall on the golden call", () => {
  it("places one call with the disclosure-first script, en-US, a female voice, a 120s cap and a stable Idempotency-Key", async () => {
    const s = setup();
    const place = vi.spyOn(s.calls, "placeCall");
    const callId = await runCall(s);
    expect(place).toHaveBeenCalledTimes(1);
    const [input, opts] = place.mock.calls[0]!;
    expect(input).toMatchObject({ to: s.phone, fromNumberId: "num_fake", language: "en-US", voiceGender: "female", maxCallDurationSeconds: 120 });
    expect(input.outboundInstruction).toContain(`"${DISCLOSURE} Is this Eddy's Auto?"`);
    expect(input.outboundInstruction).toContain(`business_id "${s.businessId}"`);
    expect(opts.idempotencyKey).toBe(`onboard-${s.bookingId}`);
    expect(getRow(s.db, "calls", callId)?.script_version).toMatch(/^onboard-v3@[0-9a-f]{16}$/);
  });

  it("persists the transcript and emits the call events in order", async () => {
    const s = setup();
    const callId = await runCall(s);
    const row = getRow(s.db, "calls", callId)!;
    expect(row.status).toBe("Terminated");
    expect(row.end_reason).toBe("completed");
    expect(row.transcript).toContain("Yeah, text me.");
    expect(row.transcript_turns?.[0]?.text).toBe(`${DISCLOSURE} Is this Eddy's Auto?`);
    expect(row.friction_score).toEqual(expect.any(Number));

    const types = callEvents(s.db, callId).map((e) => e.type);
    const lifecycle = types.filter((t) => t.startsWith("call."));
    expect(lifecycle).toEqual([
      "call.placing",
      "call.placed",
      "call.status_changed",
      "call.status_changed",
      "call.status_changed",
      "call.ended",
      "call.transcribed",
      "call.disclosure_verified",
      "call.friction_scored",
    ]);
    const events = callEvents(s.db, callId);
    expect(ofType(events, "call.placed")[0]?.payload).toEqual({ dial_call_id: row.dial_call_id, max_call_duration_seconds: 120, state: "Queued" });
    expect(ofType(events, "call.status_changed").map((e) => e.payload)).toEqual([
      { from: "Queued", to: "Ringing" },
      { from: "Ringing", to: "In-Progress" },
      { from: "In-Progress", to: "Terminated" },
    ]);
    expect(ofType(events, "call.ended")[0]?.payload).toMatchObject({ status: "completed", canceled: false });
    expect((ofType(events, "call.transcribed")[0]?.payload.turns as unknown[]).length).toBe(11);
    // The mid-call tools ran against the row this service wrote.
    expect(s.fake.toolErrors).toEqual([]);
    expect(ofType(events, "voice.tool_called").map((e) => e.payload.tool)).toEqual(["check_slot", "hold_slot", "create_booking", "record_consent", "set_text_number"]);
  });

  it("mines the transcript into findings with confidence, never a confirmation", async () => {
    const s = setup();
    const callId = await runCall(s);
    const mined = ofType(callEvents(s.db, callId), "transcript.mined");
    expect(mined.find((e) => e.payload.kind === "price")).toMatchObject({ payload: { value: 8900 }, confidence: 0.95 });
    expect(mined.find((e) => e.payload.kind === "slot_time")?.payload.value).toBe("14:00");
    expect(mined.find((e) => e.payload.kind === "consent_sentence")?.payload).toMatchObject({ value: "yes", quote: "Yeah, text me." });
    expect(mined.every((e) => e.confidence < 1)).toBe(true);
    // The booking was confirmed by create_booking during the call, not by mining.
    expect(getBooking({ db: s.db }, s.bookingId).confirmation_evidence).toMatchObject({ kind: "call", quotedSentence: "Yep, booked." });
    expect(ofType(callEvents(s.db, callId), "booking.transcript_candidate")).toEqual([]);
  });

  it("verifies the quotes the tools stored against the owner's words", async () => {
    const s = setup();
    const callId = await runCall(s);
    const verified = ofType(callEvents(s.db, callId), "evidence.quote_verified");
    expect(verified.map((e) => [e.payload.tool, e.payload.quote])).toEqual([
      ["create_booking", "Yep, booked."],
      ["record_consent", "Yeah, text me."],
    ]);
    expect(ofType(callEvents(s.db, callId), "evidence.quote_unverified")).toEqual([]);
    expect(ofType(callEvents(s.db, callId), "booking.price_mismatch")).toEqual([]);
  });

  it("uses the 110-second cap in demo mode", async () => {
    const s = setup({ demoMode: true });
    const place = vi.spyOn(s.calls, "placeCall");
    const callId = await runCall(s);
    expect(place.mock.calls[0]![0].maxCallDurationSeconds).toBe(110);
    expect(ofType(callEvents(s.db, callId), "call.placed")[0]?.payload.max_call_duration_seconds).toBe(110);
  });
});

describe("never two calls (non-negotiable 4)", () => {
  it("refuses a second call while one is live", async () => {
    const s = setup({ timeScale: 1, clock: wallClock });
    vi.useFakeTimers();
    await s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId });
    const place = vi.spyOn(s.calls, "placeCall");
    const err = await s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallRefusedError);
    expect((err as CallRefusedError).code).toBe("live_call");
    expect(place).not.toHaveBeenCalled();
    expect(listEvents(s.db, { type: "call.refused" })).toHaveLength(1);
  });

  it("refuses two concurrent requests for the same number", async () => {
    const s = setup();
    const results = await Promise.allSettled([
      s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId }),
      s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    await s.fake.settle();
    await s.service.idle();
  });

  it("checks Dial's list before placing, and refuses if Dial shows a live call", async () => {
    const calls = stubCalls({ listCalls: vi.fn(async () => [{ id: "call_elsewhere", to: "+14155550101", status: { state: "Ringing" } } as WireCall]) });
    const s = setup({ calls: () => calls });
    const err = await s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId }).catch((e: unknown) => e);
    expect((err as CallRefusedError).code).toBe("live_call");
    expect(calls.listCalls).toHaveBeenCalledWith({ contact: s.phone });
    expect(calls.placeCall).not.toHaveBeenCalled();
  });

  it("refuses when Dial's list cannot be checked", async () => {
    const calls = stubCalls({ listCalls: vi.fn(async () => Promise.reject(new DialNetworkError("down"))) });
    const s = setup({ calls: () => calls });
    await expect(s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId })).rejects.toMatchObject({ code: "cannot_verify" });
    expect(calls.placeCall).not.toHaveBeenCalled();
  });

  it("after an ambiguous POST, lists calls and adopts the call instead of re-posting", async () => {
    const listed = [[], [{ id: "call_remote", to: "+14155550101", status: { state: "Queued" }, createdAt: NOW } as WireCall]];
    const calls = stubCalls({
      placeCall: vi.fn(async () => Promise.reject(new DialNetworkError("socket hang up"))),
      listCalls: vi.fn(async () => listed.shift() ?? []),
    });
    const s = setup({ calls: () => calls });
    const { call_id } = await s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId });
    expect(calls.placeCall).toHaveBeenCalledTimes(1);
    expect(calls.listCalls).toHaveBeenCalledTimes(2);
    expect(getRow(s.db, "calls", call_id)?.dial_call_id).toBe("call_remote");
    expect(callEvents(s.db, call_id).map((e) => e.type)).toEqual(["call.placing", "call.placement_reconciled", "call.placed"]);
  });

  it("after an ambiguous POST that the list cannot explain, stops and says so", async () => {
    const calls = stubCalls({ placeCall: vi.fn(async () => Promise.reject(new DialNetworkError("timeout"))) });
    const s = setup({ calls: () => calls });
    const err = await s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallPlacementError);
    expect((err as CallPlacementError).ambiguous).toBe(true);
    expect(calls.placeCall).toHaveBeenCalledTimes(1);
    expect(listEvents(s.db, { type: "call.placement_unknown" })).toHaveLength(1);
  });

  it("records a definite refusal from Dial without retrying", async () => {
    const calls = stubCalls({ placeCall: vi.fn(async () => Promise.reject(new DialInsufficientCreditError(402, "insufficient_credit", "Dial 402"))) });
    const s = setup({ calls: () => calls });
    await expect(s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId })).rejects.toMatchObject({ code: "insufficient_credit", ambiguous: false });
    expect(calls.placeCall).toHaveBeenCalledTimes(1);
    expect(selectRows(s.db, "calls")[0]).toMatchObject({ status: "Failed", end_reason: "insufficient_credit" });
  });

  it("the FakeDial adapter replays the original call for a repeated Idempotency-Key", async () => {
    const s = setup();
    const req = { to: s.phone, outboundInstruction: "x", maxCallDurationSeconds: 120 };
    const a = await s.calls.placeCall(req, { idempotencyKey: "onboard-same" });
    const b = await s.calls.placeCall(req, { idempotencyKey: "onboard-same" });
    expect(b.id).toBe(a.id);
    await s.fake.settle();
  });
});

describe("refusals before dialing", () => {
  it("refuses a business marked do-not-call", async () => {
    const s = setup();
    updateRow(s.db, "businesses", s.businessId, { do_not_call: true });
    await expect(s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId })).rejects.toMatchObject({ code: "do_not_call" });
  });

  it("refuses a seventh call to one phone within an hour, however many agents and bookings ask", async () => {
    const s = setup();
    const now = manualClock().now().getTime();
    const pastCall = (i: number, minutesAgo: number) =>
      s.db
        .prepare("INSERT INTO calls (id, business_id, direction, to_e164, status, created_at, updated_at) VALUES (?, ?, 'outbound', ?, 'Terminated', ?, ?)")
        .run(`call_past_${i}`, s.businessId, s.phone, new Date(now - minutesAgo * 60_000).toISOString(), new Date(now).toISOString());
    pastCall(0, 61); // outside the window: does not count
    for (let i = 1; i < MAX_CALLS_PER_NUMBER_PER_HOUR; i++) pastCall(i, 5 * i);
    const place = vi.spyOn(s.calls, "placeCall");
    await runCall(s); // the sixth in the hour is still allowed
    expect(place).toHaveBeenCalledTimes(1);
    await expect(s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId })).rejects.toMatchObject({ code: "rate_limited" });
    expect(place).toHaveBeenCalledTimes(1);
    expect(listEvents(s.db, { type: "call.refused" }).at(-1)?.payload).toEqual({ code: "rate_limited" });
  });

  it("refuses after an owner asked not to be called again on a call", async () => {
    const s = setup({
      tools: false,
      script: (steps) => [
        ...steps.slice(0, 1),
        { kind: "turn", atMs: 7_000, speaker: "user", text: "No thanks. Please don't call here again.", durationMs: 1_500 },
        { kind: "turn", atMs: 9_000, speaker: "agent", text: "Understood, we won't call again.", durationMs: 2_000 },
      ],
    });
    const callId = await runCall(s);
    expect(ofType(callEvents(s.db, callId), "call.do_not_call")[0]?.confidence).toBeGreaterThanOrEqual(0.9);
    await expect(s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId })).rejects.toMatchObject({ code: "do_not_call" });
  });
});

describe("Dial events", () => {
  it("dedupes by envelope id and ignores calls it does not know", async () => {
    const s = setup();
    await runCall(s);
    const unknown = { id: "evt_x", object: "event", type: "call.ended", version: 1, createdAt: NOW, relatedObject: null, data: { callId: "call_other", status: "completed", canceled: false, durationSeconds: 5 } };
    expect(await s.service.handleDialEvent(unknown)).toEqual({ handled: false, reason: "unknown call" });
    expect(await s.service.handleDialEvent(unknown)).toEqual({ handled: false, reason: "duplicate" });
    expect(await s.service.handleDialEvent({ nope: true })).toMatchObject({ handled: false });
    expect(await s.service.handleDialEvent({ ...unknown, id: "evt_y", type: "message.received" })).toEqual({ handled: false, reason: "ignored message.received" });
  });

  it("re-delivered events change nothing", async () => {
    const s = setup();
    const seen: unknown[] = [];
    s.fake.on((e) => seen.push(e));
    const callId = await runCall(s);
    const before = callEvents(s.db, callId).length;
    for (const e of seen) await s.service.handleDialEvent({ ...(e as object), id: `${(e as { id: string }).id}_retry` });
    await s.service.idle();
    expect(callEvents(s.db, callId).length).toBe(before);
  });

  it("holds events that arrive before POST /calls returns, so call.placed comes first", async () => {
    const s = setup({ tools: false, timeScale: 0 });
    const callId = await runCall(s);
    const lifecycle = callEvents(s.db, callId).map((e) => e.type).filter((t) => t.startsWith("call."));
    expect(lifecycle.slice(0, 4)).toEqual(["call.placing", "call.placed", "call.status_changed", "call.status_changed"]);
  });
});

describe("post-call checks", () => {
  it("flags a call whose first words were not the disclosure", async () => {
    const s = setup({
      tools: false,
      script: (steps) => [{ kind: "turn", atMs: 1_200, speaker: "agent", text: "Hey there, I'm calling about an oil change.", durationMs: 3_000 }, ...steps.slice(1)],
    });
    const callId = await runCall(s);
    const missing = ofType(callEvents(s.db, callId), "call.disclosure_missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.payload.ok).toBe(false);
    expect(ofType(callEvents(s.db, callId), "call.disclosure_verified")).toEqual([]);
  });

  it("accepts the disclosure after the owner answers first, ignoring case and punctuation", async () => {
    const s = setup({
      tools: false,
      script: (steps) => [
        { kind: "turn", atMs: 500, speaker: "user", text: "Eddy's Auto.", durationMs: 600 },
        { kind: "turn", atMs: 1_200, speaker: "agent", text: DISCLOSURE.toLowerCase().replace(/[.,']/g, "") + " Is this Eddy's Auto?", durationMs: 5_200 },
        ...steps.slice(1),
      ],
    });
    const callId = await runCall(s);
    expect(ofType(callEvents(s.db, callId), "call.disclosure_verified")).toHaveLength(1);
  });

  it("flags a booked price the owner never said", async () => {
    const s = setup({
      script: (steps) =>
        steps.map((step) =>
          step.kind === "tool" && step.tool === "create_booking"
            ? { ...step, input: (st: { hold_id?: string }) => ({ hold_id: st.hold_id, price_cents: 9900, verbal_confirmation: "Yep, booked." }) }
            : step,
        ),
    });
    const callId = await runCall(s);
    expect(ofType(callEvents(s.db, callId), "booking.price_mismatch")[0]?.payload).toMatchObject({ tool_price_cents: 9900, mined_price_cents: 8900 });
  });

  it("flags a consent quote the owner never said", async () => {
    const s = setup({
      script: (steps) =>
        steps.map((step) =>
          step.kind === "tool" && step.tool === "record_consent"
            ? { ...step, input: (st: { business_id: string }) => ({ business_id: st.business_id, channel: "imessage", quote: "Absolutely, message me anytime." }) }
            : step,
        ),
    });
    const callId = await runCall(s);
    expect(ofType(callEvents(s.db, callId), "evidence.quote_unverified").map((e) => e.payload.tool)).toEqual(["record_consent"]);
  });
});

describe("the transcript fallback (tools missed)", () => {
  it("emits a candidate from the transcript and leaves the booking pending", async () => {
    const s = setup({ tools: false });
    const callId = await runCall(s);
    const candidate = ofType(callEvents(s.db, callId), "booking.transcript_candidate");
    expect(candidate).toHaveLength(1);
    expect(candidate[0]!.payload).toMatchObject({
      source: "transcript",
      price_cents: 8900,
      slot_time: "14:00",
      slot_start: "2026-10-12T21:00:00.000Z",
      slot_end: "2026-10-12T21:45:00.000Z",
      consent: "yes",
      quotes: { agreement: "Yep, booked." },
    });
    expect(candidate[0]!.confidence).toBeLessThan(1);
    // Non-negotiable 1: a transcript is not the owner's confirmation.
    const booking = getBooking({ db: s.db }, s.bookingId);
    expect(booking.status).toBe("pending");
    expect(booking.confirmation_evidence).toBeNull();
    expect(listEvents(s.db, { type: "booking.confirmed" })).toEqual([]);
  });

  it("emits nothing when the owner never agreed", async () => {
    const s = setup({ tools: false, script: (steps) => steps.filter((st) => !(st.kind === "turn" && st.text === "Yep, booked.")) });
    const callId = await runCall(s);
    expect(ofType(callEvents(s.db, callId), "booking.transcript_candidate")).toEqual([]);
  });
});

describe("kill switch, demo cap and replay", () => {
  const longCall = (steps: CallScriptStep[]): CallScriptStep[] => [...steps.slice(0, 2), { kind: "turn", atMs: 200_000, speaker: "user", text: "Still there?", durationMs: 1_000 }];

  it("stops the live call and records who asked", async () => {
    vi.useFakeTimers();
    const s = setup({ tools: false, timeScale: 1, clock: wallClock, script: longCall });
    const { call_id } = await s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId });
    await vi.advanceTimersByTimeAsync(6_000);
    await s.service.idle();
    expect(s.service.liveCall()?.id).toBe(call_id);

    expect(await s.service.stopCall()).toMatchObject({ stopped: true, call_id, reason: "kill_switch" });
    await s.service.idle();
    const events = callEvents(s.db, call_id);
    expect(ofType(events, "call.stop_requested")[0]?.payload).toMatchObject({ requested_by: "kill_switch" });
    expect(ofType(events, "call.ended")[0]?.payload).toMatchObject({ status: "canceled", canceled: true });
    expect(s.service.liveCall()).toBeNull();
    expect(await s.service.stopCall(call_id)).toMatchObject({ stopped: false });
  });

  it("stops a demo call at 110 seconds even if Dial does not", async () => {
    vi.useFakeTimers();
    const s = setup({ tools: false, timeScale: 1, clock: wallClock, script: longCall, demoMode: true });
    const { call_id } = await s.service.startOnboardingCall({ booking_id: s.bookingId, business_id: s.businessId });
    await vi.advanceTimersByTimeAsync(109_000);
    await s.service.idle();
    expect(ofType(callEvents(s.db, call_id), "call.stop_requested")).toEqual([]);
    expect(s.service.liveCall()?.id).toBe(call_id);

    await vi.advanceTimersByTimeAsync(1_500);
    await s.service.idle();
    expect(ofType(callEvents(s.db, call_id), "call.stop_requested")[0]?.payload).toMatchObject({ requested_by: "duration_cap" });
    expect(s.service.liveCall()).toBeNull();
  });

  it("replays the last call's events for the dashboard, marked as replayed", async () => {
    const s = setup();
    const callId = await runCall(s);
    const original = callEvents(s.db, callId);
    const result = await s.service.replayLastCall();
    expect(result).toEqual({ call_id: callId, events: original.length });
    const replayed = listEvents(s.db).filter((e) => e.payload.replayed === true);
    expect(replayed.map((e) => e.type)).toEqual(original.map((e) => e.type));
    // Replays never replay replays.
    expect((await s.service.replayLastCall()).events).toBe(original.length);
  });
});

describe("failures while handling events", () => {
  it("records the failure and lets a redelivery finish the job", async () => {
    const s = setup();
    let failGetCall = true;
    const getCall = s.calls.getCall.bind(s.calls);
    s.calls.getCall = async (id) => {
      if (failGetCall) throw new Error("Dial 502");
      return getCall(id);
    };
    const seen: { id: string; type: string }[] = [];
    s.fake.on((e) => seen.push(e));
    const callId = await runCall(s);
    expect(listEvents(s.db, { type: "call.event_failed" })).toHaveLength(1);
    expect(getRow(s.db, "calls", callId)?.transcript_turns).toBeNull();

    failGetCall = false;
    const transcribed = seen.find((e) => e.type === "call.transcribed")!;
    expect(await s.service.handleDialEvent(transcribed)).toEqual({ handled: true, reason: "transcribed and mined" });
    expect(getRow(s.db, "calls", callId)?.transcript_turns).toHaveLength(11);
  });
});
