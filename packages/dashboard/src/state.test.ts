import { describe, expect, it } from "vitest";
import { GOLDEN_PATH } from "./fixture";
import type { StreamEvent } from "./format";
import { bookingForCall, currentCall, evidenceMessage, initialState, MAX_EVENTS, readDarwin, reduce, reduceAll, replySeconds, supplyRows, VOICE_TOOLS, type DashboardState } from "./state";

const SAL = "biz_01M4PXD580DHZN65A76SE0V0ZE";
const CALL = "call_01M4PXD580DHZN65A76SE0V0ZZ";

let n = 0;
function ev(type: string, payload: Record<string, unknown> = {}, refs: Record<string, string> = {}, extra: Partial<StreamEvent> = {}): StreamEvent {
  n += 1;
  return { id: `evt_t${String(n).padStart(4, "0")}`, type, actor: "system", refs, payload, reason: null, confidence: 1, created_at: new Date(Date.UTC(2026, 9, 12, 2, 0, n)).toISOString(), ...extra };
}

/** The golden path re-emitted with fresh ids, as POST /demo/replay does. */
function rerun(events: StreamEvent[], tag: string): StreamEvent[] {
  return events.map((e) => ({ ...e, id: `${e.id}-${tag}`, payload: { ...e.payload, replayed: true } }));
}

function upTo(predicate: (e: StreamEvent) => boolean): DashboardState {
  const end = GOLDEN_PATH.findIndex(predicate);
  expect(end).toBeGreaterThanOrEqual(0);
  return reduceAll(GOLDEN_PATH.slice(0, end + 1));
}

describe("reduce over the golden path", () => {
  const state = reduceAll(GOLDEN_PATH);

  it("lists the six seeded businesses in order", () => {
    expect(state.businessOrder).toHaveLength(6);
    expect(state.businessOrder.map((id) => state.businesses[id]!.name)).toEqual([
      "Sal's Auto",
      "Mira Hair Studio",
      "Little Acorns Daycare",
      "Two Hills Moving",
      "Fresh Start Cleaning",
      "Dogpatch Groomers",
    ]);
  });

  it("flips only Sal's to text-enabled, with rail, masked cell and the consent quote", () => {
    const sal = state.businesses[SAL]!;
    expect(sal).toMatchObject({ channel: "text_enabled", rail: "imessage", numberMasked: "+1415•••0101", consentQuote: "Yeah, text me.", consentSource: "call" });
    const others = state.businessOrder.filter((id) => id !== SAL).map((id) => state.businesses[id]!);
    expect(others.every((b) => b.channel === "phone_only" && b.rail === undefined && b.consentQuote === undefined)).toBe(true);
  });

  it("shows Darwin exactly as recorded: an HTTP 500 error, no agents, no invented reason", () => {
    expect(state.darwin).toMatchObject({ status: "error", httpStatus: 500, provenance: "recorded", recordedAt: "2026-10-11T18:11:07Z", latencyMs: 1050, cached: false, agents: [] });
    expect(state.darwin?.noMatchReason).toBeUndefined();
    expect(state.darwin?.question).toBeUndefined();
  });

  it("keeps the customer's ask and the routing reasons", () => {
    expect(state.ask).toMatchObject({ tool: "search_providers", service: "oil change", budgetCents: 12000, utterance: "Get me an oil change tomorrow afternoon, under $120, near 1025 Sansome." });
    // The last booking.pending is the text-routed second request.
    expect(state.routing).toMatchObject({ route: "text", shortCode: "SAL-9S2", reasons: ["consent recorded on the call (imessage)"] });
  });

  it("ends the call with all five mid-call tools lit and the transcript in order", () => {
    const call = currentCall(state)!;
    expect(call.id).toBe(CALL);
    expect(call).toMatchObject({ state: "Terminated", durationSeconds: 51, endStatus: "completed", maxSeconds: 120, scriptVersion: "v1" });
    expect(VOICE_TOOLS.map((t) => call.tools[t].state)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(call.transcript).toHaveLength(11);
    expect(call.transcript![0]).toMatchObject({ speaker: "agent", startMs: 1200 });
    expect(call.transcript![0]!.text.startsWith("Hi, this is an AI assistant")).toBe(true);
    expect(call.transcript![1]).toMatchObject({ speaker: "owner", text: "It is." });
  });

  it("confirms the first booking by call and the second by text, with their evidence", () => {
    expect(state.bookingOrder).toHaveLength(2);
    const [first, second] = state.bookingOrder.map((id) => state.bookings[id]!);
    expect(first).toMatchObject({ shortCode: "SAL-WGD", status: "confirmed", route: "call", service: "oil change", priceCents: 8900, slotStart: "2026-10-12T21:00:00.000Z", evidence: { kind: "call", quote: "Yep, booked." }, fromTranscript: false });
    expect(second).toMatchObject({ shortCode: "SAL-9S2", status: "confirmed", route: "text", service: "brake inspection", slotStart: "2026-10-13T17:00:00.000Z", evidence: { kind: "text" } });
    expect(second!.priceCents).toBeUndefined();
    expect(evidenceMessage(state, second!)?.body).toBe("Y");
    expect(bookingForCall(state, currentCall(state))?.shortCode).toBe("SAL-WGD");
  });

  it("renders the owner conversation: one text out, one Y back, classified", () => {
    expect(state.messages.map((m) => [m.direction, m.body.slice(0, 12)])).toEqual([
      ["out", "New job via "],
      ["in", "Y"],
    ]);
    expect(state.messages[1]!.classification).toMatchObject({ class: "accept", method: "deterministic" });
  });

  it("computes the supply table: Sal's replies in 4 s at $89 with a 1/1 opt-in, the rest blank", () => {
    const rows = supplyRows(state);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ name: "Sal's Auto", channel: "text_enabled", medianReplySeconds: 4, lastPriceCents: 8900, optIn: [{ version: "v1", consents: 1, calls: 1, rate: 1 }] });
    for (const row of rows.slice(1)) {
      expect(row.medianReplySeconds).toBeUndefined();
      expect(row.lastPriceCents).toBeUndefined();
      expect(row.optIn).toEqual([]);
    }
  });

  it("reaches every golden-path step, ending on the Y", () => {
    expect(state.reached).toEqual(["ask", "darwin", "call", "tools", "consent", "text", "confirmed"]);
    expect(state.currentStep).toBe("confirmed");
    expect(state.eventCount).toBe(GOLDEN_PATH.length);
  });
});

describe("reduce, moment by moment", () => {
  it("shows Not searched yet until darwin.searched arrives", () => {
    expect(reduceAll(GOLDEN_PATH.slice(0, 6)).darwin).toBeUndefined();
  });

  it("lights the tool slots in order while the call is in progress", () => {
    const afterHold = upTo((e) => e.type === "voice.tool_called" && e.payload.tool === "hold_slot");
    const call = currentCall(afterHold)!;
    expect(call.state).toBe("In-Progress");
    expect(call.inProgressAt).toBeDefined();
    expect(VOICE_TOOLS.map((t) => call.tools[t].state)).toEqual(["ok", "ok", "idle", "idle", "idle"]);
    expect(call.transcript).toBeUndefined();
  });

  it("walks the call through Queued, Ringing and In-Progress", () => {
    expect(currentCall(upTo((e) => e.type === "call.placed"))!.state).toBe("Queued");
    expect(currentCall(upTo((e) => e.type === "call.status_changed" && e.payload.to === "Ringing"))!.state).toBe("Ringing");
  });

  it("keeps Sal's phone-only until the consent flips it", () => {
    expect(upTo((e) => e.type === "consent.recorded").businesses[SAL]!.channel).toBe("phone_only");
    expect(upTo((e) => e.type === "business.channel_changed").businesses[SAL]!.channel).toBe("text_enabled");
  });

  it("shows the held slot for the text booking before it is confirmed", () => {
    const state = upTo((e) => e.type === "message.sent");
    const booking = Object.values(state.bookings).find((b) => b.shortCode === "SAL-9S2")!;
    expect(booking).toMatchObject({ status: "pending", slotStart: "2026-10-13T17:00:00.000Z" });
  });
});

describe("reduce is safe to replay", () => {
  it("ignores a duplicate event id (a reconnect that re-sends)", () => {
    const once = reduceAll(GOLDEN_PATH);
    const twice = reduceAll(GOLDEN_PATH, once);
    expect(twice).toBe(once);
  });

  it("never mutates the state it is given", () => {
    const before = reduceAll(GOLDEN_PATH.slice(0, 20));
    const snapshot = JSON.stringify({ ...before, seen: [...before.seen] });
    reduceAll(GOLDEN_PATH.slice(20), before);
    expect(JSON.stringify({ ...before, seen: [...before.seen] })).toBe(snapshot);
  });

  it("converges when the same run is replayed with new ids, as a refresh after /demo/replay sees it", () => {
    const one = reduceAll(GOLDEN_PATH);
    const two = reduceAll([...GOLDEN_PATH, ...rerun(GOLDEN_PATH, "r2")]);
    expect(two.businessOrder).toEqual(one.businessOrder);
    expect(two.bookingOrder).toEqual(one.bookingOrder);
    expect(two.messages).toHaveLength(2);
    expect(two.businesses[SAL]).toMatchObject({ channel: "text_enabled", consents: one.businesses[SAL]!.consents });
    expect(supplyRows(two)[0]).toMatchObject({ medianReplySeconds: 4, optIn: [{ version: "v1", consents: 1, calls: 1, rate: 1 }] });
    expect(two.replayed).toBe(true);
    expect(one.replayed).toBe(false);
  });

  it("starts a replayed run's cards and bookings over instead of inheriting the last run", () => {
    const midSecondRun = reduceAll([...GOLDEN_PATH, ...rerun(GOLDEN_PATH, "r2").slice(0, 12)]);
    expect(midSecondRun.businesses[SAL]!.channel).toBe("phone_only");
    const first = Object.values(midSecondRun.bookings).find((b) => b.shortCode === "SAL-WGD")!;
    expect(first.status).toBe("pending");
    expect(first.evidence).toBeUndefined();
  });

  it("keeps only the most recent events for the compact stream", () => {
    let state = initialState();
    for (let i = 0; i < MAX_EVENTS + 25; i++) state = reduce(state, ev("noise.tick"));
    expect(state.events).toHaveLength(MAX_EVENTS);
    expect(state.eventCount).toBe(MAX_EVENTS + 25);
  });

  it("carries unknown event types into the stream without touching anything else", () => {
    const state = reduce(initialState(), ev("something.new", { anything: [1, 2, 3] }));
    expect(state.events).toHaveLength(1);
    expect(state.businessOrder).toEqual([]);
  });
});

describe("call panel edge cases", () => {
  const placed = ev("call.placed", { dial_call_id: "call_x", state: "Queued", script_version: "v2" }, { call_id: "c1", business_id: "b1", booking_id: "k1" });

  it("shows a failed tool with its error, and a later success replaces it", () => {
    let state = reduce(initialState(), placed);
    state = reduce(state, ev("voice.tool_called", { tool: "hold_slot", ok: false, error: "hold_not_active" }, { call_id: "c1" }));
    expect(currentCall(state)!.tools.hold_slot).toMatchObject({ state: "failed", error: "hold_not_active" });
    state = reduce(state, ev("voice.tool_called", { tool: "hold_slot", ok: true }, { call_id: "c1" }));
    expect(currentCall(state)!.tools.hold_slot.state).toBe("ok");
    expect(currentCall(state)!.tools.hold_slot.error).toBeUndefined();
  });

  it("reads a failure reason from the tool output when there is no top-level error", () => {
    const state = reduceAll([placed, ev("voice.tool_called", { tool: "create_booking", ok: false, output: { error: "slot_taken" } }, { call_id: "c1" })]);
    expect(currentCall(state)!.tools.create_booking).toMatchObject({ state: "failed", error: "slot_taken" });
  });

  it("keeps tools outside the five slots separately", () => {
    const state = reduceAll([placed, ev("voice.tool_called", { tool: "lookup_vehicle", ok: true }, { call_id: "c1" })]);
    expect(currentCall(state)!.otherTools).toMatchObject([{ tool: "lookup_vehicle", ok: true }]);
    expect(VOICE_TOOLS.every((t) => currentCall(state)!.tools[t].state === "idle")).toBe(true);
  });

  it("takes the script version from call.placed and defaults to v1", () => {
    expect(currentCall(reduce(initialState(), placed))!.scriptVersion).toBe("v2");
    expect(currentCall(reduce(initialState(), ev("call.placed", {}, { call_id: "c2" })))!.scriptVersion).toBe("v1");
  });

  it("marks a call canceled by the kill switch", () => {
    const state = reduceAll([placed, ev("call.ended", { duration_seconds: 12, status: "canceled", canceled: true }, { call_id: "c1" })]);
    expect(currentCall(state)).toMatchObject({ state: "Terminated", durationSeconds: 12, canceled: true, endStatus: "canceled" });
  });

  it("drops empty or malformed transcript turns", () => {
    const state = reduceAll([placed, ev("call.transcribed", { turns: [{ speaker: "agent", text: "  " }, null, "x", { speaker: "user", text: "Yes.", startMs: 900 }, { speaker: "agent", text: "Hi.", startMs: 100 }] }, { call_id: "c1" })]);
    expect(currentCall(state)!.transcript).toEqual([
      { speaker: "agent", text: "Hi.", startMs: 100 },
      { speaker: "owner", text: "Yes.", startMs: 900 },
    ]);
  });

  it("labels a booking agreed from the transcript", () => {
    const state = reduceAll([
      ev("booking.pending", { route: "call", short_code: "SAL-1AB" }, { booking_id: "k1", business_id: "b1" }),
      ev("booking.slot_agreed", { slot_start: "2026-10-12T21:00:00.000Z", price_cents: 8900, source: "transcript" }, { booking_id: "k1", business_id: "b1" }),
    ]);
    expect(state.bookings.k1).toMatchObject({ fromTranscript: true, priceCents: 8900 });
  });
});

describe("Darwin panel payloads", () => {
  it("reads a no_match with either spelling of the reason", () => {
    expect(readDarwin(ev("darwin.searched", { status: "no_match", no_match_reason: "No agent books auto repair." }))).toMatchObject({ status: "no_match", noMatchReason: "No agent books auto repair." });
    expect(readDarwin(ev("darwin.searched", { status: "no_match", noMatchReason: "None." })).noMatchReason).toBe("None.");
  });

  it("reads needs_input with Darwin's question", () => {
    expect(readDarwin(ev("darwin.searched", { status: "needs_input", question: "Which city?" }))).toMatchObject({ status: "needs_input", question: "Which city?" });
  });

  it("ranks agents by Darwin's rank and keeps readiness and reasons", () => {
    const view = readDarwin(
      ev("darwin.searched", {
        status: "completed",
        cached: true,
        agents: [
          { agent_id: "b", name: "Second", readiness: "unavailable", can_start_thread: false, rank: 2, reasons: ["r2"] },
          { agentId: "a", name: "First", readiness: "ready", canStartThread: true, rank: 1, reasons: ["r1", "r1b", "r1c", "r1d"], uncertainties: ["u1"] },
        ],
      }),
    );
    expect(view.cached).toBe(true);
    expect(view.agents.map((a) => [a.id, a.readiness, a.canStartThread])).toEqual([
      ["a", "ready", true],
      ["b", "unavailable", false],
    ]);
    expect(view.agents[0]!.reasons).toEqual(["r1", "r1b", "r1c"]);
  });

  it("reads the agent side's live payload with the search ladder", () => {
    const view = readDarwin(
      ev("darwin.searched", {
        status: "completed",
        http_status: 200,
        provenance: "live",
        latency_ms: 9120,
        search_id: "srch_1",
        outcome: "listed_only",
        candidate_agent_id: null,
        agents: [{ agent_id: "x", name: "Shop finder", readiness: "unavailable", can_start_thread: false }],
        attempts: [
          { query: "auto repair shop: oil change", withContext: true, ok: false, status: 500, errorKind: "server", requestId: "r1", latencyMs: 8000 },
          { query: "auto repair shop", withContext: false, ok: true, status: 200, errorKind: null, requestId: "r2", latencyMs: 1120 },
        ],
        config_error: null,
      }),
    );
    expect(view).toMatchObject({ status: "completed", provenance: "live", outcome: "listed_only", searchId: "srch_1", latencyMs: 9120 });
    expect(view.candidateAgentId).toBeUndefined();
    expect(view.attempts).toEqual([
      { query: "auto repair shop: oil change", ok: false, status: 500, errorKind: "server", latencyMs: 8000, withContext: true },
      { query: "auto repair shop", ok: true, status: 200, latencyMs: 1120, withContext: false },
    ]);
    expect(view.agents[0]!.reasons).toEqual([]);
  });

  it("survives garbage without inventing content", () => {
    const view = readDarwin(ev("darwin.searched", { status: "weird", agents: "nope", attempts: { a: 1 }, latency_ms: "fast" }));
    expect(view).toMatchObject({ status: "unknown", rawStatus: "weird", agents: [], attempts: [] });
    expect(view.latencyMs).toBeUndefined();
    expect(readDarwin(ev("darwin.searched", { status: "disabled" })).status).toBe("disabled");
  });
});

describe("owner phone and supply table", () => {
  const b = { business_id: "b1" };
  const at = (s: number) => ({ created_at: new Date(Date.UTC(2026, 9, 12, 3, 0, s)).toISOString() });

  it("pairs each owner reply with the latest unanswered text, and takes the median", () => {
    const state = reduceAll([
      ev("business.listed", { display_name: "Mira", channel_state: "phone_only", change: "created" }, b),
      ev("message.sent", { body: "One?" }, { ...b, message_id: "m1" }, at(0)),
      ev("message.received", { body: "Y" }, { ...b, message_id: "m2" }, at(4)),
      ev("message.sent", { body: "Two?" }, { ...b, message_id: "m3" }, at(10)),
      ev("message.received", { body: "N" }, { ...b, message_id: "m4" }, at(30)),
      ev("message.received", { body: "actually Y" }, { ...b, message_id: "m5" }, at(31)),
      ev("message.sent", { body: "Three?" }, { ...b, message_id: "m6" }, at(40)),
      ev("message.received", { body: "Y" }, { ...b, message_id: "m7" }, at(46)),
    ]);
    expect(replySeconds(state.messages)).toEqual([4, 20, 6]);
    expect(supplyRows(state)[0]!.medianReplySeconds).toBe(6);
  });

  it("applies delivery updates to a message already shown and ignores unknown ones", () => {
    const state = reduceAll([ev("message.sent", { body: "Hi" }, { ...b, message_id: "m1" }), ev("message.delivered", {}, { ...b, message_id: "m1" }), ev("message.delivered", {}, { ...b, message_id: "zz" })]);
    expect(state.messages).toEqual([expect.objectContaining({ id: "m1", status: "delivered" })]);
  });

  it("computes opt-in per script version from calls and consents", () => {
    const state = reduceAll([
      ev("business.listed", { display_name: "Mira", change: "created" }, b),
      ev("call.placed", { script_version: "v1" }, { ...b, call_id: "c1" }),
      ev("call.placed", { script_version: "v2" }, { ...b, call_id: "c2" }),
      ev("call.placed", { script_version: "v2" }, { ...b, call_id: "c3" }),
      ev("consent.recorded", { quoted_sentence: "Sure." }, { ...b, call_id: "c3", consent_id: "k1" }),
    ]);
    expect(supplyRows(state)[0]!.optIn).toEqual([
      { version: "v1", consents: 0, calls: 1, rate: 0 },
      { version: "v2", consents: 1, calls: 2, rate: 0.5 },
    ]);
  });

  it("tracks the last quoted price per business from slot_agreed or confirmed", () => {
    const state = reduceAll([
      ev("business.listed", { display_name: "Mira", change: "created" }, b),
      ev("booking.pending", { route: "call" }, { ...b, booking_id: "k1" }),
      ev("booking.slot_agreed", { price_cents: 6500 }, { ...b, booking_id: "k1" }),
      ev("booking.confirmed", { from: "pending", to: "confirmed", price_cents: null }, { ...b, booking_id: "k1" }),
    ]);
    expect(supplyRows(state)[0]!.lastPriceCents).toBe(6500);
    expect(state.bookings.k1!.status).toBe("confirmed");
  });
});
