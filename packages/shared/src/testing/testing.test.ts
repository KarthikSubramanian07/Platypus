import { describe, expect, it } from "vitest";
import { manualClock } from "../clock";
import { DarwinSearchResponse, DialEvent, VoiceAuthorizationError } from "../contracts/index";
import { getBusinessBySlug, getActiveConsent, openDb, seed, selectRows } from "../db/index";
import { EventBus } from "../events/bus";
import { listEvents } from "../events/log";
import { NumberNotAllowedError } from "../safety";
import { createBooking } from "../booking/index";
import { createFakeDarwinFetch, FakeDial, createFakeGateway, loadGoldenPath, replayEvents, runGoldenPath, DISCLOSURE } from "./index";

const SAL_FICTIONAL = "+14155550101";

function world() {
  const db = openDb(":memory:");
  const clock = manualClock("2026-10-12T02:00:00.000Z");
  const bus = new EventBus();
  return { db, clock, bus };
}

describe("golden path against the fakes", () => {
  it("books by call, records consent, then books by text with a Y", async () => {
    const { db, clock, bus } = world();
    const { first, second, dial } = await runGoldenPath({ db, clock, bus, timeScale: 0 });
    expect(dial.toolErrors).toEqual([]);

    expect(first).toMatchObject({ status: "confirmed", route: "call", price_cents: 8900 });
    expect(first.confirmation_evidence).toMatchObject({ kind: "call", quotedSentence: "Yep, booked." });
    expect(second).toMatchObject({ status: "confirmed", route: "text" });
    expect(second.confirmation_evidence?.kind).toBe("text");

    const sal = getBusinessBySlug(db, "sals-auto")!;
    expect(sal.channel_state).toBe("text_enabled");
    expect(sal.text_number_e164).toBe(SAL_FICTIONAL);
    expect(getActiveConsent(db, sal.id)).toMatchObject({ source: "call", quoted_sentence: "Yeah, text me." });

    // Exactly one call: the second request never rang the phone.
    expect(dial.listCalls().calls).toHaveLength(1);
    expect(dial.messages.filter((m) => m.direction === "outbound")).toHaveLength(1);
  });

  it("fires the mid-call tools in the demo order", async () => {
    const { db, clock, bus } = world();
    await runGoldenPath({ db, clock, bus, timeScale: 0 });
    const tools = listEvents(db, { type: "voice.tool_called" }).map((e) => [e.payload.tool, e.payload.ok]);
    expect(tools).toEqual([
      ["check_slot", true],
      ["hold_slot", true],
      ["create_booking", true],
      ["record_consent", true],
      ["set_text_number", true],
    ]);
  });

  it("opens the call with the AI disclosure and stores realistic transcript turns", async () => {
    const { db, clock, bus } = world();
    const { dial } = await runGoldenPath({ db, clock, bus, timeScale: 0 });
    const call = dial.getCall(dial.listCalls().calls[0]!.id).call;
    expect(call.transcriptTurns![0]).toMatchObject({ speaker: "agent" });
    expect(call.transcriptTurns![0]!.text.startsWith(DISCLOSURE)).toBe(true);
    for (const [a, b] of call.transcriptTurns!.slice(1).map((t, i) => [call.transcriptTurns![i]!, t] as const)) {
      expect(b.startMs).toBeGreaterThanOrEqual(a.endMs);
    }
    const row = selectRows(db, "calls")[0]!;
    expect(row.status).toBe("Terminated");
    expect(row.transcript_turns).toHaveLength(call.transcriptTurns!.length);
  });
});

describe("FakeDial", () => {
  it("emits Dial-shaped events: status changes, exactly one call.ended, then call.transcribed", async () => {
    const { clock } = world();
    const dial = new FakeDial({ allowedNumbers: [SAL_FICTIONAL], clock, timeScale: 0 });
    const events: DialEvent[] = [];
    dial.on((e) => events.push(DialEvent.parse(e)));
    await dial.placeCall({ to: SAL_FICTIONAL, fromNumberId: "num_1", outboundInstruction: "x" });
    await dial.settle();
    const types = events.map((e) => (e.type === "call.status_changed" ? `${e.type}:${e.data.status.state}` : e.type));
    expect(types).toEqual([
      "call.status_changed:Ringing",
      "call.status_changed:In-Progress",
      "call.status_changed:Terminated",
      "call.ended",
      "call.transcribed",
    ]);
  });

  it("refuses numbers outside ALLOWED_NUMBERS", async () => {
    const dial = new FakeDial({ allowedNumbers: [SAL_FICTIONAL], timeScale: 0 });
    await expect(dial.placeCall({ to: "+14155550199", fromNumberId: "n", outboundInstruction: "x" })).rejects.toThrow(NumberNotAllowedError);
    await expect(dial.sendMessage({ to: "+14155550199", body: "hi", channel: "imessage" })).rejects.toThrow(NumberNotAllowedError);
  });

  it("refuses a second live call to the same number", async () => {
    const dial = new FakeDial({ allowedNumbers: [SAL_FICTIONAL], timeScale: 1 });
    const { call } = await dial.placeCall({ to: SAL_FICTIONAL, fromNumberId: "n", outboundInstruction: "x" });
    await expect(dial.placeCall({ to: SAL_FICTIONAL, fromNumberId: "n", outboundInstruction: "x" })).rejects.toThrow(/already live/);
    dial.stopCall(call.id);
    expect(dial.getCall(call.id).call.status).toMatchObject({ state: "Terminated", terminationType: "canceled" });
  });

  it("refuses sms to a non-Dial number", async () => {
    const dial = new FakeDial({ allowedNumbers: [SAL_FICTIONAL], timeScale: 0 });
    await expect(dial.sendMessage({ to: SAL_FICTIONAL, body: "hi", channel: "sms" })).rejects.toThrow(/10DLC/);
    const dialToDial = new FakeDial({ allowedNumbers: [SAL_FICTIONAL], dialNumbers: [SAL_FICTIONAL], timeScale: 0 });
    await expect(dialToDial.sendMessage({ to: SAL_FICTIONAL, body: "hi", channel: "sms" })).resolves.toBeDefined();
  });
});

describe("FakeGateway", () => {
  it("rejects tool calls from a number with no live call", async () => {
    const { db, clock, bus } = world();
    seed(db, {});
    const sal = getBusinessBySlug(db, "sals-auto")!;
    const gateway = createFakeGateway({ db, clock, bus });
    await expect(
      gateway.check_slot({ business_id: sal.id, window: { start: "2026-10-12T19:00:00Z", end: "2026-10-13T00:00:00Z" } }, { caller_number: sal.phone_e164, direction: "outbound" }),
    ).rejects.toThrow(VoiceAuthorizationError);
  });

  it("rejects tool calls that name a different business than the live call", async () => {
    const { db, clock, bus } = world();
    seed(db, {});
    const sal = getBusinessBySlug(db, "sals-auto")!;
    const mira = getBusinessBySlug(db, "mira-hair-studio")!;
    const booking = createBooking({ db, clock, bus }, { business_id: sal.id, agent_id: "a", service: "oil change", route: "call" });
    const gateway = createFakeGateway({ db, clock, bus });
    const errors: unknown[] = [];
    const dial = new FakeDial({
      allowedNumbers: [sal.phone_e164],
      db,
      clock,
      bus,
      timeScale: 0,
      voiceTools: gateway,
      script: () => [{ kind: "tool", atMs: 1000, tool: "record_consent", input: () => ({ business_id: mira.id, channel: "sms", quote: "yes" }) }],
    });
    await dial.placeCall({ to: sal.phone_e164, fromNumberId: "n", outboundInstruction: "x" }, { business_id: sal.id, booking_id: booking.id });
    await dial.settle();
    errors.push(...dial.toolErrors);
    expect(errors).toEqual([{ tool: "record_consent", message: "The live call is with a different business" }]);
    expect(getActiveConsent(db, mira.id)).toBeUndefined();
  });
});

describe("FakeDarwin", () => {
  it("serves the real recorded match", async () => {
    const fetch = createFakeDarwinFetch("match", {});
    const res = await fetch("https://api.darwin.so/api/v3/search", { method: "POST", body: "{}" });
    const parsed = DarwinSearchResponse.parse(await res.json());
    expect(parsed.status).toBe("completed");
    expect(parsed.searchId).toMatch(/^srch_/);
    expect(parsed.response.agents.length).toBeGreaterThan(0);
  });

  it("serves the real recorded HTTP 500", async () => {
    const res = await createFakeDarwinFetch("error_500", {})("https://api.darwin.so/api/v3/search", { method: "POST" });
    expect(res.status).toBe(500);
  });

  it("serves the real recorded no_match, with its search token redacted", async () => {
    const body = await (await createFakeDarwinFetch("no_match", {})("https://api.darwin.so/api/v3/search", { method: "POST" })).json();
    const parsed = DarwinSearchResponse.parse(body);
    expect(parsed.status).toBe("no_match");
    expect(parsed.searchId).toMatch(/^srch_[0-9a-f-]{36}$/);
    expect((body as { searchToken: string }).searchToken).toBe("redacted");
  });

  it("refuses to run in live mode", () => {
    expect(() => createFakeDarwinFetch("match", { DEMO_MODE: "live" })).toThrow(/test-only/);
  });
});

describe("golden-path.jsonl", () => {
  const events = loadGoldenPath();

  it("contains the demo's beats in order", () => {
    const types = events.map((e) => e.type);
    const order = ["agent.tool_called", "darwin.searched", "booking.pending", "call.placed", "voice.tool_called", "booking.confirmed", "consent.recorded", "business.channel_changed", "call.transcribed", "message.sent", "message.received", "booking.confirmed"];
    let cursor = -1;
    for (const t of order) {
      const next = types.indexOf(t, cursor + 1);
      expect(next, t).toBeGreaterThan(cursor);
      cursor = next;
    }
  });

  it("never carries a simulated Darwin result or a real phone number", () => {
    const darwin = events.find((e) => e.type === "darwin.searched")!;
    expect(darwin.payload.provenance).toBe("recorded");
    const text = JSON.stringify(events);
    expect(text).not.toMatch(/SYNTHETIC/);
    for (const match of text.match(/\+1\d{10}/g) ?? []) expect(match).toMatch(/^\+1\d{3}55501\d{2}$|^\+15550100000$/);
  });

  it("replays into a fresh log in order, marked as replayed", async () => {
    const { db, bus } = world();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));
    const count = await replayEvents(events, { db, bus, speed: Infinity });
    expect(count).toBe(events.length);
    expect(seen).toEqual(events.map((e) => e.type));
    expect(listEvents(db).every((e) => e.payload.replayed === true)).toBe(true);
  });
});
