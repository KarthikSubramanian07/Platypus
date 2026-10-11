/**
 * `pnpm ci:audit-diff`: N-version check of the event-log auditor.
 *
 * Two independent readings of the non-negotiables (packages/shared/src/audit/audit.ts
 * and crates/platypus-audit) must agree on every log, so a bug in either one shows up
 * as a disagreement. This builds the Rust binary, checks that the constants it copied
 * from the TypeScript sources have not drifted, then runs both auditors on a
 * deterministic corpus (the golden path, the golden path with one targeted corruption,
 * hand-built scenarios with one corruption each, and seeded random logs) and compares
 * ok, the multiset of (rule, severity, event_id), every rule's checked/errors/warnings,
 * and the stats. On a mismatch it prints the case, the log and both outputs and exits 1.
 *
 * Set PLATYPUS_AUDIT_BIN to use a prebuilt binary. Set AUDIT_DIFF_SEED to vary the
 * random logs (the default seed keeps CI deterministic).
 */
// Naive timestamps ("2026-10-12T02:00:00") are local time to Date.parse; the Rust side
// reads them as UTC. Pin the zone so both read the same instant.
process.env.TZ = "UTC";

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditEventLog, AUDIT_RULES, AUDIT_RULE_IDS, type AuditResult } from "../../packages/shared/src/audit/index";
import { OCCUPYING_STATUSES, TRANSITIONS } from "../../packages/shared/src/booking/machine";
import { BOOKING_STATUSES } from "../../packages/shared/src/db/types";
import { parseJsonl } from "../../packages/shared/src/events/log";
import { EVENT_ACTORS } from "../../packages/shared/src/events/types";
import { DISCLOSURE } from "../../packages/shared/src/testing/call-script";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = resolve(ROOT, "crates/platypus-audit/Cargo.toml");
const GOLDEN = resolve(ROOT, "packages/shared/src/testing/fixtures/golden-path.jsonl");
const AUDIT_TS = resolve(ROOT, "packages/shared/src/audit/audit.ts");
const SEED = Number(process.env.AUDIT_DIFF_SEED ?? 20261011);
const RANDOM_LOGS = 400;

type Json = unknown;
type Ev = Record<string, Json>;
interface Case {
  name: string;
  events: Json[];
}

// ---- The binary ---------------------------------------------------------------------------

function binary(): string {
  if (process.env.PLATYPUS_AUDIT_BIN) return process.env.PLATYPUS_AUDIT_BIN;
  execFileSync("cargo", ["build", "--release", "--quiet", "--manifest-path", MANIFEST], { stdio: "inherit" });
  return resolve(ROOT, "crates/platypus-audit/target/release/platypus-audit");
}

function runRust(bin: string, events: Json[]): { code: number | null; result: AuditResult | null; stderr: string } {
  const input = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const r = spawnSync(bin, ["-", "--json"], { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let result: AuditResult | null;
  try {
    result = JSON.parse(r.stdout) as AuditResult;
  } catch {
    result = null;
  }
  return { code: r.status, result, stderr: r.stderr };
}

// ---- Constants drift ----------------------------------------------------------------------

function literal(source: string, name: string): string {
  const m = new RegExp(`const ${name}(?::[^=]+)? = (.+);`).exec(source);
  if (!m) throw new Error(`audit-differential: could not find ${name} in audit.ts`);
  return m[1]!;
}

function checkConstants(bin: string): string[] {
  const rust = JSON.parse(execFileSync(bin, ["--print-constants"], { encoding: "utf8" })) as Record<string, Json>;
  const src = readFileSync(AUDIT_TS, "utf8");
  const arr = (name: string) => JSON.parse(literal(src, name).replace(/^\[/, "[").replace(/\]$/, "]")) as string[];
  const needsReason = new RegExp(literal(src, "NEEDS_REASON").replace(/^\/|\/$/g, ""));
  const dnc = /opts\.dncConfidence \?\? ([0-9.]+)/.exec(src)?.[1];
  const ts: Record<string, Json> = {
    disclosure: DISCLOSURE,
    event_actors: [...EVENT_ACTORS],
    booking_statuses: [...BOOKING_STATUSES],
    transitions: Object.fromEntries(BOOKING_STATUSES.map((s) => [s, [...TRANSITIONS[s]]])),
    occupying_statuses: [...OCCUPYING_STATUSES],
    default_exempt_kinds: arr("DEFAULT_EXEMPT_KINDS"),
    default_dnc_confidence: Number(dnc),
    terminal_for_confirm: arr("TERMINAL_FOR_CONFIRM"),
    settled: arr("SETTLED"),
    rules: AUDIT_RULE_IDS.map((id) => ({ id, title: AUDIT_RULES[id].title, non_negotiables: [...AUDIT_RULES[id].non_negotiables] })),
  };
  const problems: string[] = [];
  for (const [k, v] of Object.entries(ts)) {
    if (canon(v) !== canon(rust[k])) problems.push(`constant ${k} differs:\n  TS   ${canon(v)}\n  Rust ${canon(rust[k])}`);
  }
  // NEEDS_REASON is a regex in TS and a list in Rust: every listed type must match, and
  // every other plausible type must not.
  const rustReason = new Set(rust.needs_reason as string[]);
  const candidates = new Set<string>([...rustReason, ...ALL_TYPES]);
  for (const prefix of ["booking", "hold", "consent", "call", "business", "message"]) {
    for (const s of [...BOOKING_STATUSES, "slot_agreed", "placed", "converted", "released", "expired", "recorded", "revoked", "channel_changed", "ended", "status_changed", "x"]) {
      candidates.add(`${prefix}.${s}`);
      candidates.add(`${prefix}.${s}x`);
    }
  }
  for (const t of candidates) {
    if (needsReason.test(t) !== rustReason.has(t)) problems.push(`NEEDS_REASON disagrees on "${t}": TS ${needsReason.test(t)}, Rust ${rustReason.has(t)}`);
  }
  return problems;
}

// ---- Comparison ---------------------------------------------------------------------------

/** JSON with sorted keys, so key order never matters. */
function canon(v: Json): string {
  return JSON.stringify(v, (_k, x: Json) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, Json>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );
}

function verdict(r: AuditResult) {
  return {
    ok: r.ok,
    violations: r.violations.map((v) => `${v.rule} ${v.severity} ${JSON.stringify(v.event_id)}`).sort(),
    rules: r.rules.map((x) => ({ id: x.id, title: x.title, checked: x.checked, errors: x.errors, warnings: x.warnings })),
    stats: r.stats,
  };
}

function diff(ts: AuditResult, rust: AuditResult): string[] {
  const a = verdict(ts);
  const b = verdict(rust);
  const out: string[] = [];
  for (const k of ["ok", "violations", "rules", "stats"] as const) {
    if (canon(a[k]) !== canon(b[k])) out.push(`${k}:\n    TS   ${canon(a[k])}\n    Rust ${canon(b[k])}`);
  }
  return out;
}

// ---- A seeded PRNG ------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- The corpus ---------------------------------------------------------------------------

const clone = <T>(x: T): T => structuredClone(x);
const BIZ = "biz_SAL";
const BIZ2 = "biz_MIRA";
const SLOT = { slot_start: "2026-10-13T21:00:00.000Z", slot_end: "2026-10-13T21:45:00.000Z" };
const LATER = { slot_start: "2026-10-13T23:00:00.000Z", slot_end: "2026-10-13T23:45:00.000Z" };
const GOOD_TURNS = [
  { speaker: "user", text: "Sal's Auto?" },
  { speaker: "agent", text: `${DISCLOSURE} Is this Sal's Auto?` },
  { speaker: "user", text: "Yep." },
];

/** Timestamp values whose Date.parse result the Rust parser is known to match (see js.rs tests). */
const TIMESTAMPS: Json[] = [
  "2026-10-12T02:00:00.000Z",
  "2026-10-12T02:00:00Z",
  "2026-10-12 02:00:00Z",
  "2026-10-12T02:00Z",
  "2026-10-12T02:00:00+05:30",
  "2026-10-12T02:00:00-0700",
  "2026-10-12T02:00:00",
  "2026-10-12",
  "2026-02-30T00:00:00Z",
  "2026-10-12T24:00:00Z",
  "2026-10-12T25:00:00Z",
  "2026-13-01T00:00:00Z",
  "2026-10-12T02:00:00.1234567Z",
  "1999-01-01T00:00:00Z",
  "not-a-date",
  "",
  "yesterday",
  "20261012",
  null,
  1791770400000,
];

/** Builds a log by hand, as audit.test.ts does: monotonic ids, one second apart. */
function builder() {
  const events: Ev[] = [];
  let n = 0;
  const add = (type: string, actor: string, refs: Record<string, string> = {}, payload: Record<string, Json> = {}, extra: Ev = {}) => {
    n++;
    const e: Ev = {
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
type B = ReturnType<typeof builder>;

function callBooking(L: B, o: { booking?: string; call?: string; hold?: string; biz?: string; slot?: typeof SLOT; end?: boolean } = {}) {
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

function textBooking(L: B, o: { booking?: string; msg?: string; biz?: string; cls?: string; slot?: typeof SLOT } = {}) {
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

function journey(): Ev[] {
  const L = builder();
  callBooking(L);
  textBooking(L);
  return L.events;
}

/** Hand-built scenarios, each a known way to break (or almost break) one rule. */
function scenarios(): Case[] {
  const out: Case[] = [];
  const scene = (name: string, build: (L: B) => void) => {
    const L = builder();
    build(L);
    out.push({ name: `scenario: ${name}`, events: L.events });
  };
  scene("call then text journey", (L) => {
    callBooking(L);
    textBooking(L);
  });
  scene("consent revoked before a send", (L) => {
    callBooking(L);
    L.add("consent.revoked", "owner", { business_id: BIZ }, {});
    L.add("message.sent", "system", { business_id: BIZ }, { channel: "imessage", kind: "booking_request" });
    L.add("message.sent", "system", { business_id: BIZ }, { channel: "imessage", kind: "stop_confirmation" });
    L.add("message.sent", "system", { business_id: BIZ }, { channel: "imessage", kind: "help" });
  });
  scene("consent revoked by id, then JOIN", (L) => {
    callBooking(L);
    L.add("consent.revoked", "owner", { business_id: BIZ, consent_id: "cns_call_1" }, {});
    L.add("message.sent", "system", { business_id: BIZ }, { channel: "imessage" });
    L.add("consent.recorded", "owner", { business_id: BIZ }, { channel: "imessage" });
    L.add("message.sent", "system", { business_id: BIZ }, { channel: "imessage" });
  });
  scene("text with no consent, and one with no business", (L) => {
    L.add("message.sent", "system", { business_id: BIZ2 }, { channel: "imessage" });
    L.add("message.sent", "system", {}, { channel: "imessage" });
  });
  scene("overlapping holds", (L) => {
    L.add("hold.placed", "system", { business_id: BIZ, hold_id: "h1" }, SLOT);
    L.add("hold.placed", "system", { business_id: BIZ, hold_id: "h2" }, SLOT);
    L.add("hold.released", "system", { business_id: BIZ, hold_id: "h1" });
    L.add("hold.placed", "system", { business_id: BIZ, hold_id: "h3" }, { slot_start: SLOT.slot_end, slot_end: LATER.slot_end });
    L.add("hold.released", "system", { business_id: BIZ, hold_id: "h1" });
    L.add("hold.placed", "system", { business_id: BIZ, hold_id: "h4" }, { slot_start: LATER.slot_end, slot_end: LATER.slot_start });
    L.add("hold.placed", "system", { business_id: BIZ, hold_id: "h4" }, {});
    L.add("hold.placed", "system", { business_id: BIZ2, hold_id: "h5" }, { slot_start: SLOT.slot_start, slot_end: SLOT.slot_start });
  });
  scene("overlapping calls", (L) => {
    L.add("call.placed", "system", { business_id: BIZ, call_id: "c1" });
    L.add("call.placed", "system", { business_id: BIZ, call_id: "c2" });
    L.add("call.ended", "system", { business_id: BIZ, call_id: "c1" });
    L.add("call.ended", "system", { business_id: BIZ, call_id: "c2" });
    L.add("call.placed", "system", { business_id: BIZ, call_id: "c3" });
  });
  scene("blind retry after an unknown placement", (L) => {
    L.add("call.placing", "system", { business_id: BIZ, call_id: "c1" });
    L.add("call.placement_unknown", "system", { business_id: BIZ, call_id: "c1" });
    L.add("call.placing", "system", { business_id: BIZ, call_id: "c2" });
    L.add("call.placement_reconciled", "system", { business_id: BIZ, call_id: "c1" }, { dial_call_id: "d1" });
    L.add("call.placing", "system", { business_id: BIZ, call_id: "c3" });
  });
  for (const conf of [0.95, 0.9, 0.5, "0.95", true, null]) {
    scene(`do-not-call at confidence ${JSON.stringify(conf)}`, (L) => {
      L.add("call.do_not_call", "voice", { business_id: BIZ }, {}, { confidence: conf });
      L.add("call.placed", "system", { business_id: BIZ, call_id: "c1" });
    });
  }
  scene("sms without dial_to_dial", (L) => {
    L.add("consent.recorded", "owner", { business_id: BIZ, consent_id: "k" });
    L.add("message.sent", "system", { business_id: BIZ }, { channel: "sms" });
    L.add("message.sent", "system", { business_id: BIZ }, { channel: "sms", dial_to_dial: true });
    L.add("message.sent", "system", { business_id: BIZ }, { channel: "sms", dial_to_dial: "true" });
  });
  scene("transcript-only confirmation", (L) => {
    L.add("booking.pending", "agent", { booking_id: "b1", business_id: BIZ }, { route: "call" });
    L.add("call.placed", "system", { booking_id: "b1", business_id: BIZ, call_id: "c1" });
    L.add("call.ended", "system", { booking_id: "b1", business_id: BIZ, call_id: "c1" });
    L.add("transcript.mined", "system", { call_id: "c1" }, {});
    L.add("booking.transcript_candidate", "system", { booking_id: "b1" }, {});
    L.add("booking.confirmed", "voice", { booking_id: "b1", business_id: BIZ }, { from: "pending", evidence: { kind: "call", callId: "c1", quotedSentence: "sure" } });
  });
  scene("evidence taken from the transcript", (L) => {
    L.add("booking.pending", "agent", { booking_id: "b1", business_id: BIZ });
    L.add("booking.confirmed", "voice", { booking_id: "b1", business_id: BIZ }, { from: "pending", evidence: { kind: "transcript", transcript_turn: 3 } });
    L.add("booking.pending", "agent", { booking_id: "b2", business_id: BIZ });
    L.add("booking.confirmed", "voice", { booking_id: "b2", business_id: BIZ }, { from: "pending", evidence: { kind: "call", source: "transcript" } });
  });
  scene("one yes confirms two bookings", (L) => {
    textBooking(L, { booking: "b1", msg: "m1" });
    L.add("booking.pending", "agent", { booking_id: "b9", business_id: BIZ });
    L.add("booking.confirmed", "owner", { booking_id: "b9", business_id: BIZ }, { from: "pending", evidence: { kind: "text", messageId: "m1" } });
  });
  scene("text classified decline, and from another business", (L) => {
    textBooking(L, { booking: "b1", msg: "m1", cls: "decline" });
    textBooking(L, { booking: "b2", msg: "m2", biz: BIZ2, slot: SLOT });
    L.add("booking.confirmed", "owner", { booking_id: "b3", business_id: BIZ }, { from: "pending", evidence: { kind: "text", messageId: "m2" } });
  });
  scene("double booking", (L) => {
    callBooking(L, { booking: "b1", call: "c1", hold: "h1" });
    callBooking(L, { booking: "b2", call: "c2", hold: "h2" });
  });
  scene("confirmed twice, after decline, rescheduled", (L) => {
    callBooking(L, { end: false });
    L.add("booking.confirmed", "voice", { booking_id: "bkg_1", business_id: BIZ }, { from: "confirmed", evidence: { kind: "call", callId: "call_1", quotedSentence: "yes" } });
    L.add("booking.rescheduled", "agent", { booking_id: "bkg_1", business_id: BIZ }, { from: "confirmed" });
    L.add("booking.confirmed", "voice", { booking_id: "bkg_1", business_id: BIZ }, { from: "rescheduled", evidence: { kind: "call", callId: "dial_call_1", quotedSentence: "yes" } });
    L.add("booking.pending", "agent", { booking_id: "b5", business_id: BIZ });
    L.add("booking.declined", "owner", { booking_id: "b5", business_id: BIZ }, { from: "pending" });
    L.add("booking.confirmed", "autopilot", { booking_id: "b5", business_id: BIZ }, { from: "declined", evidence: { kind: "rule" } });
  });
  scene("disclosure missing, flagged, verified, clipped", (L) => {
    const bad = [{ speaker: "agent", text: "Hey, got a minute?" }];
    const clipped = [{ speaker: "agent", text: "Hi, this" }, { speaker: "user", text: "Hello?" }, { speaker: "agent", text: DISCLOSURE }];
    L.add("call.transcribed", "system", { business_id: BIZ, call_id: "c1" }, { turns: bad });
    L.add("call.transcribed", "system", { business_id: BIZ, call_id: "c2" }, { turns: bad });
    L.add("call.disclosure_missing", "system", { business_id: BIZ, call_id: "c2" });
    L.add("call.transcribed", "system", { business_id: BIZ, call_id: "c3" }, { turns: bad });
    L.add("call.disclosure_verified", "system", { business_id: BIZ, call_id: "c3" });
    L.add("call.transcribed", "system", { business_id: BIZ, call_id: "c4" }, { turns: clipped });
    L.add("call.transcribed", "system", { business_id: BIZ, call_id: "c5" }, { turns: [{ speaker: "user", text: "hi" }] });
    L.add("call.disclosure_missing", "system", { business_id: BIZ, call_id: "c6" });
    L.add("call.transcribed", "system", { business_id: BIZ, call_id: "c7" }, { turns: "not turns" });
  });
  scene("owner reply times", (L) => {
    L.add("consent.recorded", "owner", { business_id: BIZ });
    L.add("message.sent", "system", { business_id: BIZ }, { channel: "imessage" });
    L.add("message.received", "owner", { business_id: BIZ, message_id: "r1" });
    L.add("message.sent", "system", { business_id: BIZ }, { channel: "imessage" });
    L.add("message.received", "owner", { business_id: BIZ, message_id: "r2" }, {}, { created_at: "2026-10-12T02:05:00Z" });
    L.add("message.sent", "system", { business_id: BIZ }, { channel: "imessage" });
    L.add("message.received", "owner", { business_id: BIZ, message_id: "r3" }, {}, { created_at: "2026-10-12T03:00:00Z" });
  });
  scene("malformed events", (L) => {
    L.events.push({} as Ev, null as unknown as Ev, 5 as unknown as Ev, "str" as unknown as Ev, [] as unknown as Ev);
    L.add("", "robot", {}, {}, { id: "" });
    L.add("booking.pending", "agent", { booking_id: "b1" }, {}, { reason: "  ", refs: [] as unknown as Ev });
    L.add("booking.confirmed", "agent", { booking_id: "b1" }, { from: "nope", evidence: "yes" });
    L.add("booking.quoted", "agent", { booking_id: "b2" }, { from: "pending" });
    L.add("booking.slot_agreed", "agent", { booking_id: "b3" }, SLOT, { payload: [] });
  });
  return out;
}

/** The golden path with exactly one targeted corruption per log. */
function corruptions(golden: Ev[]): Case[] {
  const out: Case[] = [];
  const push = (name: string, events: Json[]) => out.push({ name: `golden: ${name}`, events });
  const n = golden.length;
  for (let i = 0; i < n; i++) {
    const t = String(golden[i]!.type);
    push(`drop #${i} ${t}`, golden.filter((_, j) => j !== i));
    push(`duplicate #${i} ${t}`, [...golden.slice(0, i + 1), clone(golden[i]!), ...golden.slice(i + 1)]);
    if (i + 1 < n) {
      const s = clone(golden);
      [s[i], s[i + 1]] = [s[i + 1]!, s[i]!];
      push(`swap #${i} and #${i + 1}`, s);
    }
    const mutate = (what: string, f: (e: Ev) => void) => {
      const s = clone(golden);
      f(s[i]!);
      push(`#${i} ${t}: ${what}`, s);
    };
    for (const actor of ["robot", undefined, 5, "owner", "voice", "autopilot"]) mutate(`actor ${JSON.stringify(actor)}`, (e) => (actor === undefined ? delete e.actor : (e.actor = actor)));
    for (const c of [1.5, -0.1, "0.95", null, undefined, 0]) mutate(`confidence ${JSON.stringify(c)}`, (e) => (c === undefined ? delete e.confidence : (e.confidence = c)));
    mutate("timestamp", (e) => (e.created_at = TIMESTAMPS[i % TIMESTAMPS.length]));
    for (const id of [undefined, "", "evt_0", i > 0 ? golden[i - 1]!.id : "zzz"]) mutate(`id ${JSON.stringify(id)}`, (e) => (id === undefined ? delete e.id : (e.id = id)));
    for (const r of [null, "", "   "]) mutate(`reason ${JSON.stringify(r)}`, (e) => (e.reason = r));
    mutate("refs dropped", (e) => (e.refs = {}));
    const refs = (golden[i]!.refs ?? {}) as Record<string, Json>;
    for (const k of Object.keys(refs)) mutate(`refs.${k} swapped`, (e) => ((e.refs as Record<string, Json>)[k] = "other_" + k));
    const payload = (golden[i]!.payload ?? {}) as Record<string, Json>;
    for (const k of Object.keys(payload)) {
      mutate(`payload.${k} deleted`, (e) => delete (e.payload as Record<string, Json>)[k]);
      mutate(`payload.${k} nulled`, (e) => ((e.payload as Record<string, Json>)[k] = null));
    }
  }
  // Targeted payload corruptions the per-field ones above do not reach.
  const at = (type: string, nth = 0) => golden.map((e, j) => [e, j] as const).filter(([e]) => e.type === type)[nth]?.[1] ?? -1;
  const edit = (name: string, j: number, f: (e: Ev) => void) => {
    if (j < 0) return;
    const s = clone(golden);
    f(s[j]!);
    push(name, s);
  };
  const pay = (e: Ev) => e.payload as Record<string, Json>;
  edit("sms without dial_to_dial", at("message.sent"), (e) => (pay(e).channel = "sms"));
  edit("sms with dial_to_dial", at("message.sent"), (e) => Object.assign(pay(e), { channel: "sms", dial_to_dial: true }));
  edit("transcript evidence", at("booking.confirmed"), (e) => (pay(e).evidence = { kind: "transcript" }));
  edit("evidence kind unknown", at("booking.confirmed", 1), (e) => (pay(e).evidence = { kind: "vibes" }));
  edit("text classified decline", at("reply.classified"), (e) => (pay(e).class = "decline"));
  edit("disclosure missing", at("call.transcribed"), (e) => (pay(e).turns = [{ speaker: "agent", text: "Hello there" }]));
  edit("consent revoked instead of recorded", at("consent.recorded"), (e) => (e.type = "consent.revoked"));
  edit("hold overlapping slot moved", at("hold.placed", 1), (e) => Object.assign(pay(e), clone((golden[at("hold.placed")]!.payload ?? {}) as object)));
  edit("call confirmation after call ended", at("call.ended"), (e) => (e.id = String(golden[at("booking.confirmed")]!.id).replace(/.$/, "0")));
  return out;
}

const ALL_TYPES = [
  "booking.pending", "booking.quote_pending", "booking.quoted", "booking.countered", "booking.confirmed", "booking.rescheduled", "booking.completed",
  "booking.no_show", "booking.disputed", "booking.declined", "booking.expired", "booking.cancelled", "booking.slot_agreed", "booking.transcript_candidate",
  "booking.route_changed", "hold.placed", "hold.converted", "hold.released", "hold.expired", "call.placing", "call.placed", "call.placement_unknown",
  "call.placement_reconciled", "call.ended", "call.transcribed", "call.disclosure_missing", "call.disclosure_verified", "call.do_not_call",
  "call.status_changed", "voice.tool_called", "transcript.mined", "consent.recorded", "consent.revoked", "message.received", "reply.classified",
  "message.not_sent", "message.sent", "business.channel_changed", "business.listed", "agent.tool_called",
];

/** Random logs over a small world (2 businesses, 3 bookings, 3 calls...), so entities collide often. */
function randomLogs(seed: number, count: number): Case[] {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const maybe = (p: number) => rnd() < p;
  const slots = [SLOT, LATER, { slot_start: "2026-10-13T21:30:00.000Z", slot_end: "2026-10-13T22:00:00.000Z" }, { slot_start: SLOT.slot_end, slot_end: LATER.slot_start }, { slot_start: LATER.slot_end, slot_end: LATER.slot_start }];
  const turnsPool: Json[] = [
    GOOD_TURNS,
    [{ speaker: "agent", text: "Hey there" }],
    [{ speaker: "agent", text: "Hi, this" }, { speaker: "agent", text: DISCLOSURE.toUpperCase() }],
    [{ speaker: "agent", text: "Hi, this" }, { speaker: "user", text: "yes?" }, { speaker: "agent", text: DISCLOSURE.replace(/,/g, "") }],
    [{ speaker: "user", text: "hello" }],
    [],
    "nope",
  ];
  const out: Case[] = [];
  for (let k = 0; k < count; k++) {
    const events: Ev[] = [];
    const len = 3 + Math.floor(rnd() * 40);
    let t = Date.UTC(2026, 9, 12, 2, 0, 0);
    for (let n = 1; n <= len; n++) {
      t += Math.floor(rnd() * 120_000);
      const type = pick(ALL_TYPES);
      const refs: Record<string, Json> = {};
      if (maybe(0.9)) refs.business_id = pick(["b_A", "b_A", "b_B"]);
      if (maybe(0.6)) refs.booking_id = pick(["k1", "k2", "k3"]);
      if (type.startsWith("call.") || type === "transcript.mined" || maybe(0.1)) refs.call_id = pick(["c1", "c2", "c3", "d1"]);
      if (type.startsWith("hold.") || type === "booking.slot_agreed" || maybe(0.05)) refs.hold_id = pick(["h1", "h2", "h3"]);
      if (type.startsWith("message.") || type === "reply.classified") refs.message_id = pick(["m1", "m2", "m3"]);
      if (type.startsWith("consent.") && maybe(0.5)) refs.consent_id = pick(["s1", "s2"]);
      const payload: Record<string, Json> = {};
      if (type.startsWith("booking.")) {
        if (maybe(0.7)) payload.from = pick([...BOOKING_STATUSES, "pending", "pending", "bogus"]);
        if (maybe(0.3)) payload.route = pick(["call", "text", "darwin_act"]);
        if (maybe(0.3)) payload.to = pick(["call", "text"]);
        if (type === "booking.confirmed" && maybe(0.9)) {
          payload.evidence = pick<Json>([
            { kind: "call", callId: pick(["c1", "c2", "d1", "c9"]), quotedSentence: pick(["Yes.", "", "  "]) },
            { kind: "text", messageId: pick(["m1", "m2", "m9"]) },
            { kind: "rule", ruleId: pick(["r1", ""]) },
            { kind: "transcript" },
            { kind: "call", source: "transcript", callId: "c1", quotedSentence: "ok" },
            { transcript_turn: 2 },
            "yes",
            { kind: 7 },
          ]);
        }
      }
      if (type === "hold.placed" || type === "booking.slot_agreed" || (type.startsWith("booking.") && maybe(0.2))) Object.assign(payload, pick(slots));
      if (type === "call.placed" || type === "call.placing" || type === "call.placement_reconciled") if (maybe(0.5)) payload.dial_call_id = pick(["d1", "d2"]);
      if (type === "call.transcribed") payload.turns = pick(turnsPool);
      if (type === "reply.classified") payload.class = pick(["accept", "accept", "decline", "counter", ""]);
      if (type === "message.sent") {
        payload.channel = pick(["imessage", "sms", "rcs", "", undefined]);
        if (maybe(0.4)) payload.dial_to_dial = pick([true, false, "true"]);
        if (maybe(0.5)) payload.kind = pick(["booking_request", "stop_confirmation", "help", "stop", "reminder"]);
      }
      const e: Ev = {
        id: maybe(0.97) ? `evt_${String(n).padStart(4, "0")}` : pick<Json>([`evt_${String(n - 2).padStart(4, "0")}`, "", undefined, 42]),
        type,
        actor: maybe(0.95) ? pick(["agent", "owner", "autopilot", "voice", "system", "owner", "voice"]) : pick<Json>(["robot", null, 1]),
        refs,
        payload,
        reason: maybe(0.93) ? `${type} because` : pick<Json>([null, "", " "]),
        confidence: maybe(0.9) ? pick([1, 1, 0.95, 0.9, 0.5]) : pick<Json>([1.2, -1, "1", null, true]),
        created_at: maybe(0.95) ? new Date(t).toISOString() : pick(TIMESTAMPS),
      };
      for (const key of Object.keys(e)) if (e[key] === undefined) delete e[key];
      events.push(e);
    }
    out.push({ name: `random: seed ${seed} log ${k}`, events });
  }
  return out;
}

/**
 * Logs where the TS auditor itself is wrong, so the two are expected to disagree.
 * KNOWN TS BUG (stats counter keys): audit.ts counts stats in plain objects
 * (`m[k] = (m[k] ?? 0) + 1`), so a key that is an Object.prototype property such as
 * "constructor" or "toString" (an actor string, a message channel, a booking route or
 * an evidence kind) starts from the inherited function and the count becomes a string
 * like "function Object() { [native code] }1"; "__proto__" is dropped entirely. The Rust
 * side counts 1. The harness runs this case, expects the stats to differ, and skips it.
 */
const KNOWN_TS_BUGS: Case[] = [
  {
    name: "known TS bug: stats key inherited from Object.prototype",
    events: [
      { id: "evt_1", type: "consent.recorded", actor: "owner", refs: { business_id: "b_A" }, payload: {}, reason: "joined", confidence: 1, created_at: "2026-10-12T02:00:00Z" },
      { id: "evt_2", type: "message.sent", actor: "system", refs: { business_id: "b_A" }, payload: { channel: "toString" }, reason: null, confidence: 1, created_at: "2026-10-12T02:00:01Z" },
    ],
  },
];

// ---- Main ---------------------------------------------------------------------------------

const bin = binary();
const problems = checkConstants(bin);
if (problems.length) {
  console.error(`audit-differential: the Rust constants drifted from the TypeScript ones:\n${problems.join("\n")}`);
  process.exit(1);
}

const golden = parseJsonl(readFileSync(GOLDEN, "utf8")) as unknown as Ev[];
const corpus: Case[] = [
  { name: "golden path", events: golden },
  { name: "hand-built journey", events: journey() },
  ...scenarios(),
  ...corruptions(golden),
  ...randomLogs(SEED, RANDOM_LOGS),
];

let failures = 0;
for (const c of corpus) {
  const ts = auditEventLog(c.events as never);
  const rust = runRust(bin, c.events);
  const problems = rust.result ? diff(ts, rust.result) : [`Rust exited ${rust.code} with no JSON: ${rust.stderr.trim()}`];
  if (!problems.length) continue;
  failures++;
  if (failures <= 3) {
    console.error(`\n✗ ${c.name} (seed ${SEED})`);
    console.error(problems.map((p) => `  ${p}`).join("\n"));
    console.error("  log:");
    for (const e of c.events) console.error(`    ${JSON.stringify(e)}`);
  }
}

let skipped = 0;
for (const c of KNOWN_TS_BUGS) {
  const rust = runRust(bin, c.events);
  const still = rust.result ? diff(auditEventLog(c.events as never), rust.result).length > 0 : true;
  if (still) skipped++;
  else console.log(`audit-differential: "${c.name}" now agrees; the TS bug looks fixed, so remove it from KNOWN_TS_BUGS.`);
}

const summary = failures
  ? `audit-differential: ${failures} of ${corpus.length} logs disagree (seed ${SEED})`
  : `audit-differential: ${corpus.length} logs, TS and Rust agree on every verdict${skipped ? ` (${skipped} known TS bug skipped)` : ""}`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${failures ? "❌" : "✅"} ${summary}\n`);
process.exit(failures ? 1 : 0);
