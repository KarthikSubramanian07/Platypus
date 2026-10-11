import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJsonl } from "../events/log";
import type { EntityRefs, EventActor, PlatypusEvent } from "../events/types";
import { DISCLOSURE } from "../testing/call-script";
import { auditEventLog, formatAuditReport, openingStartsWithDisclosure, type AuditResult } from "./index";

const golden = parseJsonl(readFileSync(new URL("../testing/fixtures/golden-path.jsonl", import.meta.url), "utf8"));

/** Builds a log by hand: monotonic ids, one second apart. */
function logBuilder() {
  const events: PlatypusEvent[] = [];
  let n = 0;
  const add = (type: string, actor: EventActor, refs: EntityRefs = {}, payload: Record<string, unknown> = {}, extra: Partial<PlatypusEvent> = {}) => {
    n++;
    const e: PlatypusEvent = {
      id: `evt_${String(n).padStart(6, "0")}`,
      type,
      actor,
      refs,
      payload,
      reason: `${type} happened`,
      confidence: 1,
      created_at: new Date(Date.UTC(2026, 9, 12, 2, 0, n)).toISOString(),
      ...extra,
    };
    events.push(e);
    return e;
  };
  return { events, add };
}

const BIZ = "biz_SAL";
const BIZ2 = "biz_MIRA";
const SLOT = { slot_start: "2026-10-13T21:00:00.000Z", slot_end: "2026-10-13T21:45:00.000Z" };
const LATER = { slot_start: "2026-10-13T23:00:00.000Z", slot_end: "2026-10-13T23:45:00.000Z" };
const GOOD_TURNS = [
  { speaker: "user", text: "Sal's Auto?", startMs: 0, endMs: 500 },
  { speaker: "agent", text: `${DISCLOSURE} Is this Sal's Auto?`, startMs: 900, endMs: 5000 },
  { speaker: "user", text: "Yep.", startMs: 5500, endMs: 6000 },
];

/** A booking made on a call through the tools, the owner's yes quoted. Stops before the call ends unless asked. */
function callBooking(L: ReturnType<typeof logBuilder>, o: { booking?: string; call?: string; hold?: string; biz?: string; slot?: typeof SLOT; end?: boolean } = {}) {
  const booking = o.booking ?? "bkg_1";
  const call = o.call ?? "call_1";
  const hold = o.hold ?? "hld_1";
  const biz = o.biz ?? BIZ;
  const slot = o.slot ?? SLOT;
  L.add("booking.pending", "agent", { booking_id: booking, business_id: biz }, { route: "call" });
  L.add("call.placed", "system", { booking_id: booking, business_id: biz, call_id: call }, { dial_call_id: `dial_${call}` });
  L.add("hold.placed", "voice", { booking_id: booking, business_id: biz, hold_id: hold }, slot);
  L.add("booking.slot_agreed", "voice", { booking_id: booking, business_id: biz, hold_id: hold }, { ...slot, price_cents: 8900 });
  L.add("hold.converted", "voice", { booking_id: booking, business_id: biz, hold_id: hold });
  L.add("booking.confirmed", "voice", { booking_id: booking, business_id: biz }, { from: "pending", to: "confirmed", evidence: { kind: "call", callId: call, quotedSentence: "Yep, booked." } });
  L.add("consent.recorded", "voice", { business_id: biz, call_id: call, consent_id: `cns_${call}` }, { channel: "imessage" });
  if (o.end !== false) {
    L.add("call.ended", "system", { booking_id: booking, business_id: biz, call_id: call }, { status: "completed" });
    L.add("call.transcribed", "system", { booking_id: booking, business_id: biz, call_id: call }, { turns: GOOD_TURNS });
  }
}

/** A text-route booking: held, texted, the owner's Y classified accept, confirmed. */
function textBooking(L: ReturnType<typeof logBuilder>, o: { booking?: string; msg?: string; biz?: string; cls?: string; slot?: typeof SLOT } = {}) {
  const booking = o.booking ?? "bkg_2";
  const biz = o.biz ?? BIZ;
  const msg = o.msg ?? "msg_in_1";
  L.add("booking.pending", "agent", { booking_id: booking, business_id: biz }, { route: "text" });
  L.add("hold.placed", "system", { booking_id: booking, business_id: biz, hold_id: `hld_${booking}` }, o.slot ?? LATER);
  L.add("message.sent", "system", { booking_id: booking, business_id: biz, message_id: `msg_out_${booking}` }, { channel: "imessage", kind: "booking_request" });
  L.add("message.received", "owner", { booking_id: booking, business_id: biz, message_id: msg }, { channel: "imessage", body: "Y" });
  L.add("reply.classified", "system", { booking_id: booking, business_id: biz, message_id: msg }, { class: o.cls ?? "accept" });
  L.add("hold.converted", "owner", { booking_id: booking, business_id: biz, hold_id: `hld_${booking}` });
  L.add("booking.confirmed", "owner", { booking_id: booking, business_id: biz }, { from: "pending", to: "confirmed", evidence: { kind: "text", messageId: msg } });
}

const errors = (r: AuditResult, rule?: string) => r.violations.filter((v) => v.severity === "error" && (!rule || v.rule === rule));
const warnings = (r: AuditResult, rule?: string) => r.violations.filter((v) => v.severity === "warning" && (!rule || v.rule === rule));

describe("auditEventLog on good logs", () => {
  it("passes the golden-path fixture with every rule checked", () => {
    const r = auditEventLog(golden);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.rules.map((x) => x.id)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]);
    expect(r.rules.find((x) => x.id === "R1")!.checked).toBe(2);
    expect(r.stats.bookings).toMatchObject({ total: 2, by_route: { call: 1, text: 1 }, by_status: { confirmed: 2 }, confirmed_by: { call: 1, text: 1 } });
    expect(r.stats.calls).toMatchObject({ placed: 1, ended: 1, transcribed: 1, live_at_end: 0, tool_calls: 5 });
    expect(r.stats.consents).toEqual({ recorded: 1, revoked: 0, active_at_end: 1 });
    expect(r.stats.messages).toMatchObject({ sent: 1, received: 1, by_channel: { imessage: 1 } });
    expect(r.stats.owner_reply_seconds).toEqual({ median: 4, samples: 1 });
  });

  it("passes the hand-built call-then-text journey", () => {
    const L = logBuilder();
    callBooking(L);
    textBooking(L);
    const r = auditEventLog(L.events);
    expect(r.violations).toEqual([]);
  });

  it("passes an empty log and never throws on malformed events", () => {
    expect(auditEventLog([]).ok).toBe(true);
    const junk = [null, 42, { id: "evt_1" }, { id: "evt_2", type: "booking.confirmed", actor: "owner", refs: null, payload: null, confidence: 1, created_at: "x" }] as unknown as PlatypusEvent[];
    const r = auditEventLog(junk);
    expect(r.ok).toBe(false);
    expect(errors(r, "R5").length).toBeGreaterThan(0);
  });
});

describe("stats counters", () => {
  it("count keys named after Object.prototype properties like any other key", () => {
    const log = ["toString", "constructor", "__proto__"].map(
      (channel, i) =>
        ({ id: `evt_${i}`, type: "message.sent", actor: "system", refs: { business_id: "b_A" }, payload: { channel }, confidence: 1, created_at: `2026-10-12T02:00:0${i}Z` }) as unknown as PlatypusEvent,
    );
    const byChannel = auditEventLog(log).stats.messages.by_channel;
    // Compared as JSON text: in an object literal, `__proto__: 1` would set the prototype, not a key.
    expect(JSON.stringify(byChannel)).toBe('{"toString":1,"constructor":1,"__proto__":1}');
  });
});

describe("R1: confirmed only by the owner's yes", () => {
  it("flags a confirmation with no evidence", () => {
    const L = logBuilder();
    L.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ });
    L.add("booking.confirmed", "owner", { booking_id: "b", business_id: BIZ }, { from: "pending", to: "confirmed" });
    expect(errors(auditEventLog(L.events), "R1")[0]!.message).toMatch(/no evidence/);
  });

  it("flags call evidence for a booking never held or agreed through the tools", () => {
    const L = logBuilder();
    L.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ });
    L.add("call.placed", "system", { booking_id: "b", business_id: BIZ, call_id: "c" });
    L.add("booking.confirmed", "voice", { booking_id: "b", business_id: BIZ }, { from: "pending", to: "confirmed", evidence: { kind: "call", callId: "c", quotedSentence: "yes" } });
    const msgs = errors(auditEventLog(L.events), "R1").map((v) => v.message);
    expect(msgs.some((m) => /slot_agreed/.test(m))).toBe(true);
    expect(msgs.some((m) => /hold\.placed/.test(m))).toBe(true);
  });

  it("flags call evidence without a quote, from an unknown call, after the call ended, or by the wrong actor", () => {
    const L = logBuilder();
    callBooking(L, { end: false });
    const confirmed = L.events.find((e) => e.type === "booking.confirmed")!;
    confirmed.payload = { ...confirmed.payload, evidence: { kind: "call", callId: "call_1", quotedSentence: " " } };
    expect(errors(auditEventLog(L.events), "R1")[0]!.message).toMatch(/without quoting/);

    confirmed.payload = { ...confirmed.payload, evidence: { kind: "call", callId: "call_nope", quotedSentence: "yes" } };
    expect(errors(auditEventLog(L.events), "R1")[0]!.message).toMatch(/never appears/);

    confirmed.payload = { ...confirmed.payload, evidence: { kind: "call", callId: "call_1", quotedSentence: "yes" } };
    confirmed.actor = "system";
    expect(errors(auditEventLog(L.events), "R1")[0]!.message).toMatch(/not the voice tools/);

    const M = logBuilder();
    M.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ });
    M.add("call.placed", "system", { booking_id: "b", business_id: BIZ, call_id: "c" });
    M.add("hold.placed", "voice", { booking_id: "b", business_id: BIZ, hold_id: "h" }, SLOT);
    M.add("booking.slot_agreed", "voice", { booking_id: "b", business_id: BIZ, hold_id: "h" }, SLOT);
    M.add("call.ended", "system", { booking_id: "b", business_id: BIZ, call_id: "c" });
    M.add("booking.confirmed", "voice", { booking_id: "b", business_id: BIZ }, { from: "pending", to: "confirmed", evidence: { kind: "call", callId: "c", quotedSentence: "yes" } });
    expect(errors(auditEventLog(M.events), "R1")[0]!.message).toMatch(/after call .* had ended/);
  });

  it("accepts call evidence that cites Dial's call id", () => {
    const L = logBuilder();
    callBooking(L);
    const confirmed = L.events.find((e) => e.type === "booking.confirmed")!;
    confirmed.payload = { ...confirmed.payload, evidence: { kind: "call", callId: "dial_call_1", quotedSentence: "Yep" } };
    expect(auditEventLog(L.events).ok).toBe(true);
  });

  it("flags text evidence that was not classified accept, never arrived, or came from another business", () => {
    const L = logBuilder();
    L.add("consent.recorded", "voice", { business_id: BIZ, consent_id: "cns" });
    textBooking(L, { cls: "counter" });
    expect(errors(auditEventLog(L.events), "R1")[0]!.message).toMatch(/classified "counter"/);

    const M = logBuilder();
    M.add("consent.recorded", "voice", { business_id: BIZ, consent_id: "cns" });
    textBooking(M);
    M.events.find((e) => e.type === "message.received")!.refs.business_id = BIZ2;
    expect(errors(auditEventLog(M.events), "R1")[0]!.message).toMatch(/different business/);

    const N = logBuilder();
    N.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ });
    N.add("booking.confirmed", "owner", { booking_id: "b", business_id: BIZ }, { from: "pending", to: "confirmed", evidence: { kind: "text", messageId: "msg_ghost" } });
    expect(errors(auditEventLog(N.events), "R1")[0]!.message).toMatch(/no message\.received/);
  });

  it("flags a yes about another booking, and one yes confirming two bookings", () => {
    const L = logBuilder();
    L.add("consent.recorded", "voice", { business_id: BIZ, consent_id: "cns" });
    textBooking(L, { booking: "b1", msg: "m1" });
    L.add("booking.pending", "agent", { booking_id: "b2", business_id: BIZ });
    L.add("booking.confirmed", "owner", { booking_id: "b2", business_id: BIZ }, { from: "pending", to: "confirmed", evidence: { kind: "text", messageId: "m1" } });
    const msgs = errors(auditEventLog(L.events), "R1").map((v) => v.message);
    expect(msgs).toEqual([expect.stringMatching(/reply about booking/), expect.stringMatching(/one yes confirms one booking/)]);
  });

  it("flags a classification that arrives only after the confirmation", () => {
    const L = logBuilder();
    L.add("consent.recorded", "voice", { business_id: BIZ, consent_id: "cns" });
    textBooking(L);
    const idx = L.events.findIndex((e) => e.type === "reply.classified");
    const [cls] = L.events.splice(idx, 1);
    L.events.push({ ...cls!, id: "evt_999999" });
    expect(errors(auditEventLog(L.events), "R1")[0]!.message).toMatch(/classified nothing yet/);
  });

  it("flags a booking confirmed twice, or after it was declined", () => {
    const L = logBuilder();
    L.add("consent.recorded", "voice", { business_id: BIZ, consent_id: "cns" });
    textBooking(L);
    L.add("booking.confirmed", "owner", { booking_id: "bkg_2", business_id: BIZ }, { from: "confirmed", to: "confirmed", evidence: { kind: "text", messageId: "msg_in_1" } });
    const r = auditEventLog(L.events);
    expect(errors(r, "R1").map((v) => v.message)).toEqual([expect.stringMatching(/confirmed twice/)]);
    expect(errors(r, "R5")).toEqual([]); // reported once, under R1

    const M = logBuilder();
    M.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ });
    M.add("booking.declined", "owner", { booking_id: "b", business_id: BIZ }, { from: "pending", to: "declined" });
    M.add("booking.confirmed", "autopilot", { booking_id: "b", business_id: BIZ }, { from: "declined", to: "confirmed", evidence: { kind: "rule", ruleId: "rul_1" } });
    expect(errors(auditEventLog(M.events), "R1")[0]!.message).toMatch(/after it was declined/);
  });

  it("allows a rescheduled booking to be confirmed again", () => {
    const L = logBuilder();
    L.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ });
    L.add("booking.confirmed", "autopilot", { booking_id: "b", business_id: BIZ }, { from: "pending", to: "confirmed", evidence: { kind: "rule", ruleId: "rul_1" } });
    L.add("booking.rescheduled", "owner", { booking_id: "b", business_id: BIZ }, { from: "confirmed", to: "rescheduled" });
    L.add("booking.confirmed", "autopilot", { booking_id: "b", business_id: BIZ }, { from: "rescheduled", to: "confirmed", evidence: { kind: "rule", ruleId: "rul_1" } });
    expect(auditEventLog(L.events).violations).toEqual([]);
  });

  it("flags rule evidence without a rule id and unknown evidence kinds", () => {
    const L = logBuilder();
    L.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ });
    L.add("booking.confirmed", "autopilot", { booking_id: "b", business_id: BIZ }, { from: "pending", to: "confirmed", evidence: { kind: "rule" } });
    expect(errors(auditEventLog(L.events), "R1")[0]!.message).toMatch(/without a rule id/);
    L.events[1]!.payload = { from: "pending", to: "confirmed", evidence: { kind: "model_says_yes" } };
    expect(errors(auditEventLog(L.events), "R1")[0]!.message).toMatch(/only call, text and rule/);
  });
});

describe("R2: the disclosure comes first", () => {
  const withTurns = (turns: unknown[], flags: string[] = []) => {
    const L = logBuilder();
    L.add("call.placed", "system", { business_id: BIZ, call_id: "c" });
    L.add("call.ended", "system", { business_id: BIZ, call_id: "c" });
    L.add("call.transcribed", "system", { business_id: BIZ, call_id: "c" }, { turns });
    for (const f of flags) L.add(f, "system", { business_id: BIZ, call_id: "c" });
    return auditEventLog(L.events);
  };
  const skipped = [{ speaker: "agent", text: "Hey, need an oil change tomorrow?", startMs: 0, endMs: 1 }];

  it("passes when the agent's first words are the disclosure, even after the owner answers first", () => {
    expect(withTurns(GOOD_TURNS).ok).toBe(true);
    expect(withTurns([{ speaker: "agent", text: DISCLOSURE.toUpperCase().replace(/[.,']/g, ""), startMs: 0, endMs: 1 }]).ok).toBe(true);
  });

  it("is an error when the disclosure is missing and nothing flagged it", () => {
    const r = withTurns(skipped);
    expect(r.ok).toBe(false);
    expect(errors(r, "R2")[0]!.message).toMatch(/nothing flagged it/);
  });

  it("is a warning, not a failure, when call.disclosure_missing flagged it", () => {
    const r = withTurns(skipped, ["call.disclosure_missing"]);
    expect(r.ok).toBe(true);
    expect(warnings(r, "R2")).toHaveLength(1);
  });

  it("is an error when the call was marked disclosure_verified anyway", () => {
    expect(errors(withTurns(skipped, ["call.disclosure_verified"]), "R2")[0]!.message).toMatch(/marked disclosure_verified/);
  });

  it("passes a first attempt clipped by crosstalk, then the full disclosure", () => {
    const clipped = [
      { speaker: "agent", text: "Hi, this", startMs: 0, endMs: 300 },
      { speaker: "user", text: "Sal's Auto, hello?", startMs: 100, endMs: 900 },
      { speaker: "agent", text: DISCLOSURE, startMs: 1000, endMs: 5000 },
    ];
    expect(withTurns(clipped).ok).toBe(true);
    expect(withTurns([{ speaker: "agent", text: "Hi, this", startMs: 0, endMs: 1 }, { speaker: "agent", text: "is Bob", startMs: 2, endMs: 3 }]).ok).toBe(false);
  });

  it("treats a transcript with no agent turn as missing", () => {
    expect(withTurns([{ speaker: "user", text: "hello?", startMs: 0, endMs: 1 }]).ok).toBe(false);
    expect(openingStartsWithDisclosure("not an array").ok).toBe(false);
    expect(openingStartsWithDisclosure([{ speaker: "agent", text: "Hi, this is an AI" }]).ok).toBe(false);
  });
});

describe("R3: no message without consent", () => {
  it("flags a text to a business that never consented", () => {
    const L = logBuilder();
    L.add("message.sent", "system", { business_id: BIZ, message_id: "m" }, { channel: "imessage", kind: "booking_request" });
    expect(errors(auditEventLog(L.events), "R3")[0]!.message).toMatch(/never consented/);
  });

  it("flags a text after revocation, but allows the STOP confirmation and HELP", () => {
    const L = logBuilder();
    L.add("consent.recorded", "voice", { business_id: BIZ, consent_id: "cns" });
    L.add("message.sent", "system", { business_id: BIZ, message_id: "m1" }, { channel: "imessage", kind: "booking_request" });
    L.add("consent.revoked", "owner", { business_id: BIZ, consent_id: "cns" });
    L.add("message.sent", "system", { business_id: BIZ, message_id: "m2" }, { channel: "imessage", kind: "stop_confirmation" });
    L.add("message.sent", "system", { business_id: BIZ, message_id: "m3" }, { channel: "imessage", kind: "help" });
    expect(auditEventLog(L.events).ok).toBe(true);
    L.add("message.sent", "system", { business_id: BIZ, message_id: "m4" }, { channel: "imessage", kind: "undo" });
    const r = auditEventLog(L.events);
    expect(errors(r, "R3")).toHaveLength(1);
    expect(errors(r, "R3")[0]!.message).toMatch(/after it revoked consent/);
  });

  it("allows texting again after a fresh consent (JOIN)", () => {
    const L = logBuilder();
    L.add("consent.recorded", "voice", { business_id: BIZ, consent_id: "c1" });
    L.add("consent.revoked", "owner", { business_id: BIZ, consent_id: "c1" });
    L.add("consent.recorded", "owner", { business_id: BIZ, consent_id: "c2" }, { source: "join_text" });
    L.add("message.sent", "system", { business_id: BIZ, message_id: "m" }, { channel: "imessage", kind: "resume" });
    expect(auditEventLog(L.events).ok).toBe(true);
  });

  it("does not let one business's consent cover another", () => {
    const L = logBuilder();
    L.add("consent.recorded", "voice", { business_id: BIZ, consent_id: "c1" });
    L.add("message.sent", "system", { business_id: BIZ2, message_id: "m" }, { channel: "imessage", kind: "booking_request" });
    expect(errors(auditEventLog(L.events), "R3")).toHaveLength(1);
  });
});

describe("R4: one live call per business, no blind retry, do-not-call", () => {
  it("flags a second call while the first is live, and allows it after call.ended", () => {
    const L = logBuilder();
    L.add("call.placed", "system", { business_id: BIZ, call_id: "c1" });
    L.add("call.placed", "system", { business_id: BIZ2, call_id: "c2" }); // other business: fine
    L.add("call.placed", "system", { business_id: BIZ, call_id: "c3" });
    const r = auditEventLog(L.events);
    expect(errors(r, "R4")).toHaveLength(1);
    expect(errors(r, "R4")[0]!.message).toMatch(/still live/);

    const M = logBuilder();
    M.add("call.placed", "system", { business_id: BIZ, call_id: "c1" });
    M.add("call.ended", "system", { business_id: BIZ, call_id: "c1" });
    M.add("call.placing", "system", { business_id: BIZ, call_id: "c2" });
    M.add("call.placed", "system", { business_id: BIZ, call_id: "c2" });
    expect(auditEventLog(M.events).ok).toBe(true);
  });

  it("flags a new attempt while an earlier placement is unknown, until it is reconciled", () => {
    const L = logBuilder();
    L.add("call.placing", "system", { business_id: BIZ, call_id: "c1" });
    L.add("call.placement_unknown", "system", { business_id: BIZ, call_id: "c1" }, {}, { confidence: 0.5 });
    L.add("call.placing", "system", { business_id: BIZ, call_id: "c2" });
    expect(errors(auditEventLog(L.events), "R4")[0]!.message).toMatch(/blind retry/);

    const M = logBuilder();
    M.add("call.placing", "system", { business_id: BIZ, call_id: "c1" });
    M.add("call.placement_unknown", "system", { business_id: BIZ, call_id: "c1" }, {}, { confidence: 0.5 });
    M.add("call.placement_reconciled", "system", { business_id: BIZ, call_id: "c1" }, { dial_call_id: "d1" });
    M.add("call.ended", "system", { business_id: BIZ, call_id: "c1" });
    M.add("call.placing", "system", { business_id: BIZ, call_id: "c2" });
    expect(auditEventLog(M.events).ok).toBe(true);
  });

  it("flags a call after call.do_not_call, unless the do-not-call signal was weak", () => {
    const L = logBuilder();
    L.add("call.do_not_call", "system", { business_id: BIZ, call_id: "c0" }, {}, { confidence: 0.95 });
    L.add("call.placed", "system", { business_id: BIZ, call_id: "c1" });
    expect(errors(auditEventLog(L.events), "R4")[0]!.message).toMatch(/asked not to be called/);

    const M = logBuilder();
    M.add("call.do_not_call", "system", { business_id: BIZ, call_id: "c0" }, {}, { confidence: 0.6 });
    M.add("call.placed", "system", { business_id: BIZ, call_id: "c1" });
    expect(auditEventLog(M.events).ok).toBe(true);
  });
});

describe("R5: well-formed events and legal transitions", () => {
  it("flags unknown actors, out-of-range confidence and missing timestamps", () => {
    const L = logBuilder();
    L.add("x.y", "robot" as EventActor);
    L.add("x.y", "system", {}, {}, { confidence: 1.5 });
    L.add("x.y", "system", {}, {}, { confidence: Number.NaN });
    L.add("x.y", "system", {}, {}, { created_at: "yesterday" });
    expect(errors(auditEventLog(L.events), "R5")).toHaveLength(4);
  });

  it("flags ids that go backwards or repeat", () => {
    const L = logBuilder();
    L.add("a.b", "system");
    L.add("a.b", "system");
    const swapped = [L.events[1]!, L.events[0]!];
    expect(errors(auditEventLog(swapped), "R5")[0]!.message).toMatch(/not greater/);
    expect(errors(auditEventLog([L.events[0]!, L.events[0]!]), "R5")[0]!.message).toMatch(/appears twice/);
  });

  it("flags a state change with no reason", () => {
    const L = logBuilder();
    L.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ }, {}, { reason: null });
    L.add("agent.tool_called", "agent", {}, {}, { reason: null }); // not a state change: fine
    expect(errors(auditEventLog(L.events), "R5")).toHaveLength(1);
  });

  it("flags transitions the state machine forbids, and a from that disagrees with the log", () => {
    const L = logBuilder();
    L.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ });
    L.add("booking.completed", "system", { booking_id: "b", business_id: BIZ }, { from: "pending", to: "completed" });
    expect(errors(auditEventLog(L.events), "R5")[0]!.message).toMatch(/pending → completed/);

    const M = logBuilder();
    M.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ });
    M.add("booking.cancelled", "agent", { booking_id: "b", business_id: BIZ }, { from: "quoted", to: "cancelled" });
    expect(errors(auditEventLog(M.events), "R5")[0]!.message).toMatch(/from quoted, but the log has it at pending/);
  });

  it("flags a booking created twice or first seen in a non-initial state", () => {
    const L = logBuilder();
    L.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ });
    L.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ });
    L.add("booking.expired", "system", { booking_id: "x", business_id: BIZ });
    expect(errors(auditEventLog(L.events), "R5")).toHaveLength(2);
  });

  it("flags a hold or an agreed slot that changes a confirmed booking without a reschedule", () => {
    const L = logBuilder();
    callBooking(L);
    L.add("hold.placed", "voice", { booking_id: "bkg_1", business_id: BIZ, hold_id: "h9" }, LATER);
    L.add("booking.slot_agreed", "voice", { booking_id: "bkg_1", business_id: BIZ, hold_id: "h9" }, { ...LATER, price_cents: 1 });
    const r = auditEventLog(L.events);
    expect(errors(r, "R5").map((v) => v.message)).toEqual([expect.stringMatching(/hold\.placed changes the slot/), expect.stringMatching(/slot_agreed changes the slot/)]);

    const M = logBuilder();
    callBooking(M);
    M.add("booking.rescheduled", "owner", { booking_id: "bkg_1", business_id: BIZ }, { from: "confirmed", to: "rescheduled" });
    M.add("hold.placed", "voice", { booking_id: "bkg_1", business_id: BIZ, hold_id: "h9" }, LATER);
    expect(auditEventLog(M.events).ok).toBe(true);
  });

  it("ignores event types it has no rule for, such as the call service's checks", () => {
    const L = logBuilder();
    for (const t of ["call.placing", "call.stop_requested", "call.friction_scored", "evidence.quote_verified", "routing.lookup", "booking.dispatch_failed", "booking.price_mismatch"]) {
      L.add(t, "system", { business_id: BIZ, booking_id: "b", call_id: "c" }, {}, { reason: null, confidence: 0.4 });
    }
    expect(auditEventLog(L.events).violations).toEqual([]);
  });

  it("trusts a mid-log booking's own from when the log starts after its creation", () => {
    const L = logBuilder();
    L.add("booking.cancelled", "agent", { booking_id: "b", business_id: BIZ }, { from: "pending", to: "cancelled" });
    expect(auditEventLog(L.events).ok).toBe(true);
  });
});

describe("R6: no sms to non-Dial numbers", () => {
  it("flags sms unless it is flagged Dial-to-Dial", () => {
    const L = logBuilder();
    L.add("consent.recorded", "voice", { business_id: BIZ, consent_id: "c" });
    L.add("message.sent", "system", { business_id: BIZ, message_id: "m1" }, { channel: "sms", kind: "booking_request" });
    L.add("message.sent", "system", { business_id: BIZ, message_id: "m2" }, { channel: "sms", kind: "booking_request", dial_to_dial: true });
    L.add("message.sent", "system", { business_id: BIZ, message_id: "m3" }, { channel: "dial", kind: "booking_request" });
    const r = auditEventLog(L.events);
    expect(errors(r, "R6")).toHaveLength(1);
    expect(errors(r, "R6")[0]!.event_id).toBe(L.events[1]!.id);
  });
});

describe("R7: no double booking", () => {
  it("flags overlapping active holds, but not adjacent ones or ones after a release", () => {
    const L = logBuilder();
    L.add("hold.placed", "system", { business_id: BIZ, hold_id: "h1" }, SLOT);
    L.add("hold.placed", "system", { business_id: BIZ2, hold_id: "h2" }, SLOT); // other business
    L.add("hold.placed", "system", { business_id: BIZ, hold_id: "h3" }, { slot_start: SLOT.slot_end, slot_end: "2026-10-13T22:30:00.000Z" }); // adjacent
    expect(auditEventLog(L.events).ok).toBe(true);
    L.add("hold.placed", "system", { business_id: BIZ, hold_id: "h4" }, { slot_start: "2026-10-13T21:30:00.000Z", slot_end: "2026-10-13T22:00:00.000Z" });
    expect(errors(auditEventLog(L.events), "R7")).toHaveLength(2); // overlaps h1 and h3

    const M = logBuilder();
    M.add("hold.placed", "system", { business_id: BIZ, hold_id: "h1" }, SLOT);
    M.add("hold.released", "system", { business_id: BIZ, hold_id: "h1" });
    M.add("hold.placed", "system", { business_id: BIZ, hold_id: "h2" }, SLOT);
    M.add("hold.expired", "system", { business_id: BIZ, hold_id: "h2" });
    M.add("hold.placed", "system", { business_id: BIZ, hold_id: "h3" }, SLOT);
    expect(auditEventLog(M.events).ok).toBe(true);
  });

  it("flags a hold over a confirmed booking and two confirmed bookings on one slot", () => {
    const L = logBuilder();
    callBooking(L);
    L.add("hold.placed", "system", { business_id: BIZ, hold_id: "h9" }, SLOT);
    expect(errors(auditEventLog(L.events), "R7")[0]!.message).toMatch(/overlaps confirmed booking/);

    const M = logBuilder();
    M.add("consent.recorded", "voice", { business_id: BIZ, consent_id: "c" });
    textBooking(M, { booking: "b1", msg: "m1", slot: SLOT });
    M.add("booking.pending", "agent", { booking_id: "b2", business_id: BIZ });
    M.add("booking.slot_agreed", "voice", { booking_id: "b2", business_id: BIZ }, SLOT);
    M.add("booking.confirmed", "autopilot", { booking_id: "b2", business_id: BIZ }, { from: "pending", to: "confirmed", evidence: { kind: "rule", ruleId: "r" } });
    expect(errors(auditEventLog(M.events), "R7")[0]!.message).toMatch(/double booking/);
  });

  it("flags a hold that leaves the active state twice, and a hold with an inverted slot", () => {
    const L = logBuilder();
    L.add("hold.placed", "system", { business_id: BIZ, hold_id: "h1" }, SLOT);
    L.add("hold.converted", "owner", { business_id: BIZ, hold_id: "h1" });
    L.add("hold.expired", "system", { business_id: BIZ, hold_id: "h1" });
    L.add("hold.placed", "system", { business_id: BIZ, hold_id: "h2" }, { slot_start: SLOT.slot_end, slot_end: SLOT.slot_start });
    const msgs = errors(auditEventLog(L.events), "R7").map((v) => v.message);
    expect(msgs).toEqual([expect.stringMatching(/already converted/), expect.stringMatching(/ends before it starts/)]);
  });
});

describe("R8: a transcript is never a confirmation", () => {
  it("flags a confirmation from the transcript alone", () => {
    const L = logBuilder();
    L.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ });
    L.add("call.placed", "system", { booking_id: "b", business_id: BIZ, call_id: "c" });
    L.add("transcript.mined", "system", { booking_id: "b", business_id: BIZ, call_id: "c" }, { kind: "agreement", quote: "yep" }, { confidence: 0.8 });
    L.add("booking.transcript_candidate", "system", { booking_id: "b", business_id: BIZ, call_id: "c" }, { source: "transcript", ...SLOT });
    L.add("booking.confirmed", "voice", { booking_id: "b", business_id: BIZ }, { from: "pending", to: "confirmed", evidence: { kind: "call", callId: "c", quotedSentence: "yep" } });
    const r = auditEventLog(L.events);
    expect(errors(r, "R8")[0]!.message).toMatch(/transcript alone/);
    expect(r.rules.find((x) => x.id === "R8")!.checked).toBe(1);
  });

  it("flags evidence that is itself taken from the transcript", () => {
    const L = logBuilder();
    L.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ });
    L.add("booking.confirmed", "system", { booking_id: "b", business_id: BIZ }, { from: "pending", to: "confirmed", evidence: { kind: "transcript", turn: 5 } });
    expect(errors(auditEventLog(L.events), "R8")).toHaveLength(1);
  });

  it("accepts a booking with transcript findings that the owner then confirmed by text", () => {
    const L = logBuilder();
    L.add("consent.recorded", "voice", { business_id: BIZ, consent_id: "c" });
    L.add("booking.pending", "agent", { booking_id: "b", business_id: BIZ });
    L.add("booking.transcript_candidate", "system", { booking_id: "b", business_id: BIZ }, { source: "transcript" });
    L.add("message.received", "owner", { booking_id: "b", business_id: BIZ, message_id: "m" }, { body: "Y" });
    L.add("reply.classified", "system", { booking_id: "b", message_id: "m" }, { class: "accept" });
    L.add("booking.confirmed", "owner", { booking_id: "b", business_id: BIZ }, { from: "pending", to: "confirmed", evidence: { kind: "text", messageId: "m" } });
    expect(auditEventLog(L.events).violations).toEqual([]);
  });
});

describe("formatAuditReport", () => {
  it("prints a check per rule, the violations under the rule that failed, and the stats", () => {
    const ok = formatAuditReport(auditEventLog(golden), { source: "golden" });
    expect(ok).toContain("✓ R1");
    expect(ok).toContain("All 8 rules hold.");
    expect(ok).toContain("median 4.0s over 1 reply");

    const L = logBuilder();
    for (let i = 0; i < 12; i++) L.add("message.sent", "system", { business_id: BIZ, message_id: `m${i}` }, { channel: "sms" });
    const bad = formatAuditReport(auditEventLog(L.events), { maxPerRule: 3 });
    expect(bad).toContain("✗ R3");
    expect(bad).toContain("✗ R6");
    expect(bad).toContain("...and 9 more");
    expect(bad).toMatch(/24 violations across 2 rule\(s\)/);
    expect(bad).not.toContain("\x1b[");
    expect(formatAuditReport(auditEventLog(L.events), { color: true })).toContain("\x1b[31m");
  });
});
