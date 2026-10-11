import fc from "fast-check";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { auditEventLog, formatAuditReport, type AuditRuleId } from "@platypus/shared/audit";
import { createBooking, getBooking, placeHold } from "@platypus/shared/booking";
import { getActiveConsent, getBusinessBySlug, openDb } from "@platypus/shared/db";
import { EventBus, listEvents, type PlatypusEvent } from "@platypus/shared/events";
import { createPhoneSide } from "./phone-side";

/**
 * The auditor against the real phone side. The whole consent flow runs in process
 * (FakeDial's scripted owner, the real VoiceTools, call service and text service):
 * the log it produces must audit clean on both rails. Then fast-check corrupts that
 * log one fact at a time, each corruption a way the non-negotiables could break,
 * and the auditor must name the rule that broke.
 */

fc.configureGlobal({ seed: Number(process.env.FC_SEED ?? 0xf022), numRuns: Number(process.env.FC_RUNS ?? 200) });

const ENV = { DEMO_MODE: "fakes", CONTEXT_MCP_SECRET: "s".repeat(40), CONTEXT_MCP_TOKEN: "t".repeat(48) } as NodeJS.ProcessEnv;

async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = read();
    if (ok(v)) return v;
    if (Date.now() - start > ms) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The demo journey: call, book mid-call, consent, then the next job by text Y. Returns the event log. */
async function runConsentFlow(rail: "imessage" | "dial"): Promise<PlatypusEvent[]> {
  const db = openDb(":memory:");
  const bus = new EventBus();
  const side = createPhoneSide({ db, bus }, { env: { ...ENV, TEXT_CHANNEL: rail }, fakeTimeScale: 0 });
  side.mount(new Hono());
  const sal = getBusinessBySlug(db, "sals-auto")!;
  const ctx = { db, bus };
  const window = { window_start: new Date(Date.now() + 86_400_000).toISOString(), window_end: new Date(Date.now() + 2 * 86_400_000).toISOString() };

  const first = createBooking(ctx, { business_id: sal.id, agent_id: "claude-desktop", service: "oil change", route: "call", details: "2019 Civic", requested_by: "Alex's assistant", ...window });
  await side.owner.startOnboardingCall({ booking_id: first.id, business_id: sal.id });
  await until(() => getBooking(ctx, first.id), (b) => b.status === "confirmed");
  await until(() => getActiveConsent(db, sal.id), (c) => Boolean(c));
  await side.calls.idle();
  await until(() => listEvents(db, { type: "call.transcribed" }), (e) => e.length === 1);

  const second = createBooking(ctx, { business_id: sal.id, agent_id: "claude-desktop", service: "brake inspection", route: "text", details: "2019 Civic", requested_by: "Alex's assistant", ...window });
  const slot = new Date(Date.now() + 3 * 86_400_000);
  slot.setUTCHours(17, 0, 0, 0);
  placeHold(ctx, { business_id: sal.id, booking_id: second.id, slot_start: slot.toISOString(), slot_end: new Date(slot.getTime() + 30 * 60_000).toISOString(), created_by: "system" });
  await side.owner.sendBookingRequest({ booking_id: second.id, business_id: sal.id });
  await until(() => getBooking(ctx, second.id), (b) => b.status === "confirmed");
  await side.text.drain();
  await side.calls.idle();
  side.calls.dispose();
  return listEvents(db, { limit: 10_000 });
}

const logs: Record<string, PlatypusEvent[]> = {};
beforeAll(async () => {
  logs.imessage = await runConsentFlow("imessage");
  logs.dial = await runConsentFlow("dial");
}, 30_000);

describe.each(["imessage", "dial"])("the phone side's own log on the %s rail", (rail) => {
  it("audits clean, with every rule exercised", () => {
    const log = logs[rail]!;
    const result = auditEventLog(log);
    if (!result.ok) throw new Error(formatAuditReport(result));
    expect(result.violations.filter((v) => v.severity === "error")).toEqual([]);
    const checked = Object.fromEntries(result.rules.map((r) => [r.id, r.checked]));
    for (const rule of ["R1", "R2", "R3", "R4", "R5", "R6", "R7"]) expect(checked[rule], rule).toBeGreaterThan(0);
    expect(result.stats.bookings.confirmed_by).toEqual({ call: 1, text: 1 });
    expect(result.stats.calls).toMatchObject({ placed: 1, ended: 1, transcribed: 1, disclosure_verified: 1 });
    expect(result.stats.owner_reply_seconds.samples).toBeGreaterThan(0);
  });
});

// ---- Corruptions: each is a way a non-negotiable could break, and the rule that must catch it ----

type Corruption = { name: string; rule: AuditRuleId; apply: (log: PlatypusEvent[], pick: number) => PlatypusEvent[] | null };

const clone = (log: PlatypusEvent[]) => log.map((e) => structuredClone(e));
const indexesOf = (log: PlatypusEvent[], test: (e: PlatypusEvent) => boolean) => log.flatMap((e, i) => (test(e) ? [i] : []));
const without = (log: PlatypusEvent[], test: (e: PlatypusEvent) => boolean, pick: number) => {
  const at = indexesOf(log, test);
  if (!at.length) return null;
  const drop = at[pick % at.length]!;
  return clone(log).filter((_, i) => i !== drop);
};
const editing = (log: PlatypusEvent[], test: (e: PlatypusEvent) => boolean, pick: number, edit: (e: PlatypusEvent) => void) => {
  const at = indexesOf(log, test);
  if (!at.length) return null;
  const out = clone(log);
  edit(out[at[pick % at.length]!]!);
  return out;
};
/** Inserts `e` right after the event at index i, with an id that keeps the log ordered. */
const insertAfter = (log: PlatypusEvent[], i: number, e: Omit<PlatypusEvent, "id">) => {
  const out = clone(log);
  out.splice(i + 1, 0, { ...e, id: `${log[i]!.id}0` });
  return out;
};

const CORRUPTIONS: Corruption[] = [
  { name: "a text sent before any consent", rule: "R3", apply: (log, p) => without(log, (e) => e.type === "consent.recorded", p) },
  {
    name: "consent revoked right before the request",
    rule: "R3",
    apply: (log) => {
      const i = log.findIndex((e) => e.type === "message.sent" && e.payload.kind === "booking_request");
      const consent = log.find((e) => e.type === "consent.recorded");
      if (i < 1 || !consent) return null;
      return insertAfter(log, i - 1, { type: "consent.revoked", actor: "owner", refs: { ...consent.refs }, payload: {}, reason: "owner texted STOP", confidence: 1, created_at: log[i]!.created_at });
    },
  },
  { name: "a call booking never agreed through the tools", rule: "R1", apply: (log, p) => without(log, (e) => e.type === "booking.slot_agreed", p) },
  {
    name: "a text yes that was never classified",
    rule: "R1",
    apply: (log, p) => {
      const yes = log.find((e) => e.type === "booking.confirmed" && (e.payload.evidence as { kind?: string })?.kind === "text");
      const messageId = (yes?.payload.evidence as { messageId?: string } | undefined)?.messageId;
      return messageId ? without(log, (e) => e.type === "reply.classified" && e.refs.message_id === messageId, p) : null;
    },
  },
  { name: "a call confirmation with no quoted yes", rule: "R1", apply: (log, p) => editing(log, (e) => e.type === "booking.confirmed" && (e.payload.evidence as { kind?: string })?.kind === "call", p, (e) => void ((e.payload.evidence as Record<string, unknown>).quotedSentence = "")) },
  {
    name: "a booking confirmed twice",
    rule: "R1",
    apply: (log, p) => {
      const at = indexesOf(log, (e) => e.type === "booking.confirmed");
      const i = at[p % at.length]!;
      return insertAfter(log, i, { ...structuredClone(log[i]!), payload: { ...log[i]!.payload, from: "confirmed" } });
    },
  },
  { name: "a booking confirmed from the transcript", rule: "R8", apply: (log, p) => editing(log, (e) => e.type === "booking.confirmed", p, (e) => void (e.payload.evidence = { kind: "transcript", turn: 5 })) },
  {
    name: "an opening without the disclosure",
    rule: "R2",
    apply: (log) =>
      editing(log, (e) => e.type === "call.transcribed", 0, (e) => {
        const turns = e.payload.turns as { speaker: string; text: string }[];
        const first = turns.find((t) => t.speaker === "agent");
        if (first) first.text = "Hey, it's Platypus. Need an oil change slot tomorrow.";
      }),
  },
  {
    name: "a second call while the first is live",
    rule: "R4",
    apply: (log) => {
      const i = log.findIndex((e) => e.type === "call.placed");
      if (i < 0) return null;
      return insertAfter(log, i, { ...structuredClone(log[i]!), refs: { ...log[i]!.refs, call_id: "call_SECOND" } });
    },
  },
  {
    name: "a call after do-not-call",
    rule: "R4",
    apply: (log) => {
      const i = log.findIndex((e) => e.type === "call.placing" || e.type === "call.placed");
      if (i < 1) return null;
      const refs = { business_id: log[i]!.refs.business_id! };
      return insertAfter(log, i - 1, { type: "call.do_not_call", actor: "system", refs, payload: {}, reason: "owner asked", confidence: 0.95, created_at: log[i]!.created_at });
    },
  },
  { name: "sms without the Dial-to-Dial flag", rule: "R6", apply: (log, p) => editing(log, (e) => e.type === "message.sent", p, (e) => {
    e.payload.channel = "sms";
    delete e.payload.dial_to_dial;
  }) },
  { name: "an unknown actor", rule: "R5", apply: (log, p) => editing(log, () => true, p, (e) => void (e.actor = "intern" as PlatypusEvent["actor"])) },
  { name: "a confidence above 1", rule: "R5", apply: (log, p) => editing(log, () => true, p, (e) => void (e.confidence = 1.01)) },
  {
    name: "two events out of order",
    rule: "R5",
    apply: (log, p) => {
      const i = p % (log.length - 1);
      const out = clone(log);
      [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
      return out;
    },
  },
  { name: "a state change without a reason", rule: "R5", apply: (log, p) => editing(log, (e) => /^(booking\.(pending|confirmed)|hold\.|consent\.recorded)/.test(e.type), p, (e) => void (e.reason = null)) },
  {
    name: "a hold over a confirmed slot",
    rule: "R7",
    apply: (log, p) => {
      const at = indexesOf(log, (e) => e.type === "hold.placed");
      const hold = log[at[p % at.length]!]!;
      const i = log.findIndex((e) => e.type === "booking.confirmed" && e.refs.booking_id === hold.refs.booking_id);
      if (i < 0) return null;
      return insertAfter(log, i, { ...structuredClone(hold), refs: { business_id: hold.refs.business_id!, hold_id: "hld_INTRUDER" }, created_at: log[i]!.created_at });
    },
  },
];

describe("corrupting the phone side's log, one fact at a time", () => {
  it.each(CORRUPTIONS.map((c) => [c.name, c] as const))("catches %s", (_name, c) => {
    // Every corruption applies to the real log at least once.
    expect(c.apply(logs.imessage!, 0)).not.toBeNull();
  });

  it("names the broken rule for every corruption, at every position, on both rails", () => {
    fc.assert(
      fc.property(fc.constantFrom(...CORRUPTIONS), fc.constantFrom("imessage", "dial"), fc.nat(), (c, rail, pick) => {
        const corrupted = c.apply(logs[rail]!, pick);
        fc.pre(corrupted !== null);
        const result = auditEventLog(corrupted!);
        expect(result.ok, c.name).toBe(false);
        expect(result.violations.filter((v) => v.severity === "error").map((v) => v.rule), c.name).toContain(c.rule);
      }),
    );
  });
});
