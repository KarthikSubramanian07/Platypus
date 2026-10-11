import { describe, expect, it } from "vitest";
import { cuesAt, GOLDEN_PATH, planRecording, recordedAt } from "./fixture";
import type { StreamEvent } from "./format";
import { initialState, readDarwin, reduceAll, type DarwinView, type TranscriptTurn } from "./state";
import { askFacts, bookingForAsk, callElapsedMs, captionsAt, darwinSummary, formatWindow, MAX_CAPTIONS, mergeTurns, phoneLabel, phoneScreen, railOf } from "./story";

let n = 0;
function ev(type: string, payload: Record<string, unknown> = {}, refs: Record<string, string> = {}): StreamEvent {
  n += 1;
  return { id: `evt_s${n}`, type, actor: "system", refs, payload, reason: null, confidence: 1, created_at: new Date(Date.UTC(2026, 9, 12, 2, 0, n)).toISOString() };
}
const upTo = (predicate: (e: StreamEvent) => boolean) => reduceAll(GOLDEN_PATH.slice(0, GOLDEN_PATH.findIndex(predicate) + 1));
const darwin = (payload: Record<string, unknown>): DarwinView => readDarwin(ev("darwin.searched", payload));

describe("phoneScreen", () => {
  it("walks the owner's phone through the golden path: lock, incoming, call, messages", () => {
    expect(phoneScreen(initialState())).toBe("lock");
    expect(phoneScreen(upTo((e) => e.type === "darwin.searched"))).toBe("lock");
    expect(phoneScreen(upTo((e) => e.type === "call.placed"))).toBe("incoming");
    expect(phoneScreen(upTo((e) => e.type === "call.status_changed" && e.payload.to === "Ringing"))).toBe("incoming");
    expect(phoneScreen(upTo((e) => e.type === "voice.tool_called"))).toBe("call");
    expect(phoneScreen(upTo((e) => e.type === "call.ended"))).toBe("ended");
    expect(phoneScreen(reduceAll(GOLDEN_PATH))).toBe("messages");
  });

  it("opens the thread early when a text is known to be coming, and lets a live call win over it", () => {
    expect(phoneScreen(upTo((e) => e.type === "call.ended"), { textComing: true })).toBe("messages");
    const again = reduceAll([...GOLDEN_PATH, ev("call.placed", {}, { call_id: "c2" })]);
    expect(phoneScreen(again)).toBe("incoming");
  });
});

describe("the phone's rail", () => {
  it("reads the rail from the events: the text's channel, else the rail consent switched the shop to", () => {
    expect(railOf(initialState())).toBeUndefined();
    expect(railOf(upTo((e) => e.type === "call.placed"))).toBeUndefined();
    expect(railOf(upTo((e) => e.type === "business.channel_changed"))).toBe("imessage");
    expect(railOf(reduceAll(GOLDEN_PATH))).toBe("imessage");
    expect(railOf(reduceAll([ev("business.listed", { display_name: "Sal's Auto" }, { business_id: "b1" }), ev("business.channel_changed", { to: "text_enabled", rail: "dial" }, { business_id: "b1" })]))).toBe("dial");
  });

  it("calls it a Dial-to-Dial line only on the dial rail", () => {
    expect(phoneLabel("dial")).toBe("Sal's Auto line · Dial-to-Dial");
    for (const rail of ["imessage", "whatsapp", "sms", undefined]) expect(phoneLabel(rail)).toBe("Sal's Auto · the owner's phone");
  });
});

describe("captions", () => {
  const turns: TranscriptTurn[] = [
    { speaker: "agent", text: "Hi, this is an AI assistant", startMs: 1000 },
    { speaker: "owner", text: "Hello?", startMs: 1500 },
    { speaker: "agent", text: "calling for a customer's agent.", startMs: 2500 },
    { speaker: "owner", text: "Yeah", startMs: 6000 },
    { speaker: "owner", text: "go ahead.", startMs: 6400, endMs: 7000 },
  ];

  it("reveals only what has been said by the elapsed time", () => {
    expect(captionsAt(turns, 0)).toEqual([]);
    expect(captionsAt(turns, 1600).map((t) => t.text)).toEqual(["Hi, this is an AI assistant", "Hello?"]);
  });

  it("orders talked-over turns by start and joins a speaker's fragments into one line", () => {
    const shuffled = [turns[4]!, turns[2]!, turns[0]!, turns[3]!, turns[1]!, { speaker: "owner" as const, text: "   ", startMs: 9000 }];
    expect(mergeTurns(shuffled)).toEqual([
      { speaker: "agent", text: "Hi, this is an AI assistant", startMs: 1000 },
      { speaker: "owner", text: "Hello?", startMs: 1500 },
      { speaker: "agent", text: "calling for a customer's agent.", startMs: 2500 },
      { speaker: "owner", text: "Yeah go ahead.", startMs: 6000, endMs: 7000 },
    ]);
  });

  it("keeps only the latest lines of a long call", () => {
    const long = Array.from({ length: 30 }, (_, i): TranscriptTurn => ({ speaker: i % 2 ? "owner" : "agent", text: `line ${i}`, startMs: i * 1000 }));
    const shown = mergeTurns(long);
    expect(shown).toHaveLength(MAX_CAPTIONS);
    expect(shown.at(-1)!.text).toBe("line 29");
  });

  it("times the call from pickup, and stops at the end", () => {
    expect(callElapsedMs(undefined, 5)).toBe(0);
    const call = { inProgressAt: "2026-10-12T02:00:05.000Z" } as never;
    expect(callElapsedMs(call, Date.parse("2026-10-12T02:00:15.000Z"))).toBe(10_000);
    expect(callElapsedMs({ inProgressAt: "2026-10-12T02:00:05.000Z", endedAt: "2026-10-12T02:00:56.000Z" } as never, Date.now())).toBe(51_000);
  });
});

describe("darwinSummary", () => {
  it("says what Darwin said, in one line, and never more", () => {
    expect(darwinSummary(reduceAll(GOLDEN_PATH).darwin)).toBe("Darwin: no agent covers this, recorded");
    expect(darwinSummary(darwin({ status: "no_match" }))).toBe("Darwin: no agent covers this");
    expect(darwinSummary(darwin({ status: "needs_input", question: "Which city?" }))).toBe("Darwin asked: “Which city?”");
    expect(darwinSummary(darwin({ status: "needs_input" }))).toBe("Darwin needs more detail");
    expect(darwinSummary(darwin({ status: "disabled" }))).toBe("Darwin not consulted");
    expect(darwinSummary(darwin({ status: "completed", cached: true }))).toBe("Darwin: no agent covers this, cached");
    expect(darwinSummary(darwin({ status: "completed", agents: [{ agent_id: "a", readiness: "unavailable" }, { agent_id: "b", readiness: "unavailable" }] }))).toBe("Darwin: 2 agents listed, none can book");
    expect(darwinSummary(darwin({ status: "completed", agents: [{ agent_id: "a", name: "Shop bot", readiness: "ready", can_start_thread: true }] }))).toBe("Darwin: Shop bot can take it");
    expect(darwinSummary(darwin({ status: "teapot" }))).toBe("Darwin answered “teapot”");
  });

  it("reads 'not consulted' from the routing reasons when no search ran", () => {
    expect(darwinSummary(undefined, ["Darwin not consulted (DARWIN_ENABLED=false)"])).toBe("Darwin not consulted");
    expect(darwinSummary(undefined, [])).toBeUndefined();
  });
});

describe("the agent's ask", () => {
  it("lists service, budget, window in shop time and the street", () => {
    expect(askFacts(reduceAll(GOLDEN_PATH).ask)).toEqual(["oil change", "under $120", "Mon 12 to 5 PM", "1025 Sansome St"]);
    expect(askFacts(undefined)).toEqual([]);
  });

  it("formats windows within a day, across days and open-ended", () => {
    expect(formatWindow("2026-10-12T16:00:00.000Z", "2026-10-12T21:00:00.000Z")).toBe("Mon 9 AM to 2 PM");
    expect(formatWindow("2026-10-13T17:00:00.000Z", "2026-10-16T00:00:00.000Z")).toBe("Tue 10 AM to Thu 5 PM");
    expect(formatWindow("2026-10-12T21:30:00.000Z", undefined)).toBe("Mon 2:30 PM");
    expect(formatWindow(undefined, undefined)).toBeUndefined();
  });

  it("pairs the ask with the booking it produced, not the later text request", () => {
    expect(bookingForAsk(reduceAll(GOLDEN_PATH))).toMatchObject({ shortCode: "SAL-WGD", route: "call", reasons: ["Darwin returned no ready agent", expect.any(String)] });
    expect(bookingForAsk(initialState())).toBeUndefined();
    const noAsk = reduceAll([ev("booking.pending", { route: "text" }, { booking_id: "k1" })]);
    expect(bookingForAsk(noAsk)?.id).toBe("k1");
  });
});

describe("planRecording", () => {
  const plan = planRecording(GOLDEN_PATH, { speed: 1.6, maxGapMs: 2_400 });
  const at = (predicate: (e: StreamEvent) => boolean) => plan.events.find((p) => predicate(p.event))!;

  it("plays every event once, in order, never going back in time", () => {
    expect(plan.events.map((p) => p.event.id)).toEqual(GOLDEN_PATH.map((e) => e.id));
    for (let i = 1; i < plan.events.length; i++) expect(plan.events[i]!.wallMs).toBeGreaterThanOrEqual(plan.events[i - 1]!.wallMs);
    expect(plan.totalMs).toBe(plan.events.at(-1)!.wallMs);
  });

  it("gives each beat time to read even when the recording has them at the same instant", () => {
    const ask = at((e) => e.type === "agent.tool_called" && e.payload.tool === "search_providers");
    const searched = at((e) => e.type === "darwin.searched");
    const placed = at((e) => e.type === "call.placed");
    expect(searched.recordedMs).toBe(ask.recordedMs);
    expect(searched.wallMs - ask.wallMs).toBeGreaterThanOrEqual(1_800);
    expect(placed.wallMs - searched.wallMs).toBeGreaterThanOrEqual(3_400);
  });

  it("plays the call at exactly the chosen speed, so captions line up with the tools", () => {
    const pickup = at((e) => e.type === "call.status_changed" && e.payload.to === "In-Progress");
    const booked = at((e) => e.type === "voice.tool_called" && e.payload.tool === "create_booking");
    expect(booked.wallMs - pickup.wallMs).toBe(Math.round((booked.recordedMs - pickup.recordedMs) / 1.6));
    const mid = Math.round((pickup.wallMs + booked.wallMs) / 2);
    expect(recordedAt(plan, mid)).toBeCloseTo((pickup.recordedMs + booked.recordedMs) / 2, -2);
  });

  it("maps wall time to the recording's clock at the edges", () => {
    expect(recordedAt(plan, -5)).toBe(0);
    expect(recordedAt(plan, plan.totalMs + 10_000)).toBe(plan.events.at(-1)!.recordedMs);
    expect(recordedAt(planRecording([], { speed: 2, maxGapMs: 1 }), 100)).toBe(0);
  });

  it("shows Platypus typing before its text, and the owner composing Y before it sends", () => {
    const sent = at((e) => e.type === "message.sent");
    const received = at((e) => e.type === "message.received");
    expect(cuesAt(plan, sent.wallMs - 200)).toEqual([expect.objectContaining({ kind: "typing" })]);
    expect(cuesAt(plan, sent.wallMs)).toEqual([]);
    expect(cuesAt(plan, received.wallMs - 200)).toEqual([expect.objectContaining({ kind: "composing", text: "Y" })]);
  });
});
