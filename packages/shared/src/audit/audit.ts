import { canTransition, OCCUPYING_STATUSES } from "../booking/machine";
import { BOOKING_STATUSES, type BookingStatus } from "../db/types";
import { EVENT_ACTORS, type PlatypusEvent } from "../events/types";
import { DISCLOSURE } from "../testing/call-script";
import { AUDIT_RULE_IDS, AUDIT_RULES, type AuditRuleId } from "./rules";

/**
 * auditEventLog: a pure replay of the append-only log that checks every
 * non-negotiable expressible from events alone. It reads nothing but the events
 * (no database, no clock, no network), so the same function audits a live
 * process, a JSONL export, a fixture, or a log a property test just produced.
 *
 * Severity:
 *  - error: an invariant was broken. `ok` is false.
 *  - warning: the system saw a problem and flagged it itself (for example a call
 *    whose disclosure was missed and logged as call.disclosure_missing), or the
 *    log is too partial to judge. Reported, but `ok` stays true.
 */

export type AuditSeverity = "error" | "warning";

export interface AuditViolation {
  rule: AuditRuleId;
  severity: AuditSeverity;
  /** The event where the problem shows; null for findings about the log as a whole. */
  event_id: string | null;
  message: string;
}

export interface AuditRuleSummary {
  id: AuditRuleId;
  title: string;
  /** How many facts this rule checked (confirmations, sends, calls, events...). */
  checked: number;
  errors: number;
  warnings: number;
}

export interface AuditStats {
  events: number;
  first_at: string | null;
  last_at: string | null;
  events_by_actor: Record<string, number>;
  bookings: { total: number; by_route: Record<string, number>; by_status: Record<string, number>; confirmed_by: Record<string, number> };
  calls: { placed: number; ended: number; transcribed: number; disclosure_verified: number; disclosure_missing: number; live_at_end: number; tool_calls: number };
  holds: { placed: number; converted: number; released: number; expired: number; active_at_end: number };
  consents: { recorded: number; revoked: number; active_at_end: number };
  messages: { sent: number; received: number; not_sent: number; by_channel: Record<string, number> };
  /** Seconds from a text to the owner's next reply on the same business, median over every reply. */
  owner_reply_seconds: { median: number | null; samples: number };
}

export interface AuditResult {
  /** True when no rule has an error. Warnings do not fail the audit. */
  ok: boolean;
  violations: AuditViolation[];
  rules: AuditRuleSummary[];
  stats: AuditStats;
}

export interface AuditOptions {
  /** The sentence every call must open with. Defaults to the hard-coded DISCLOSURE. */
  disclosure?: string;
  /** call.do_not_call at or above this confidence blocks later calls (the call service uses 0.9). */
  dncConfidence?: number;
  /** message.sent kinds allowed without active consent. Defaults to the STOP confirmation and HELP. */
  consentExemptKinds?: readonly string[];
}

const DEFAULT_EXEMPT_KINDS = ["stop_confirmation", "stop", "help"];
const TERMINAL_FOR_CONFIRM: readonly BookingStatus[] = ["declined", "cancelled", "expired"];
const STATUS_SET = new Set<string>(BOOKING_STATUSES);
const ACTOR_SET = new Set<string>(EVENT_ACTORS);
/** Event types that record a state change and so must say why (non-negotiable 7). */
const NEEDS_REASON = /^(booking\.(?:quote_pending|quoted|pending|countered|confirmed|rescheduled|completed|no_show|disputed|declined|expired|cancelled|slot_agreed)|hold\.(?:placed|converted|released|expired)|consent\.(?:recorded|revoked)|business\.channel_changed|call\.(?:placed|ended|status_changed))$/;

// ---- Small readers that never throw on a malformed event -----------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const ms = (v: unknown): number | undefined => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
};
const short = (id: string | undefined): string => (id ? (id.length > 14 ? `${id.slice(0, 4)}…${id.slice(-6)}` : id) : "?");

/** Lowercase words only, so punctuation and transcription case never matter. */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’‘]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** The agent's opening: its first turn, joined with any agent turns before the other party speaks. */
export function openingStartsWithDisclosure(turns: unknown, disclosure: string = DISCLOSURE): { ok: boolean; opening: string | null } {
  if (!Array.isArray(turns)) return { ok: false, opening: null };
  const expected = words(disclosure);
  const isAgent = (t: unknown): t is Obj => isObj(t) && t.speaker === "agent";
  // A first attempt cut off by crosstalk ("Hi, this", then the full line) still opens with the
  // disclosure, as in the call service's own check: skip agent turns that are only a prefix of it.
  const clipped = (t: Obj) => {
    const w = words(typeof t.text === "string" ? t.text : "");
    return w.length > 0 && w.length < expected.length && w.every((x, i) => expected[i] === x);
  };
  let first = turns.findIndex(isAgent);
  while (first >= 0 && clipped(turns[first] as Obj)) {
    const next = turns.findIndex((t, i) => i > first && isAgent(t));
    if (next < 0) break;
    first = next;
  }
  if (first < 0) return { ok: false, opening: null };
  const parts: string[] = [];
  for (let i = first; i < turns.length; i++) {
    const t = turns[i];
    if (!isObj(t) || t.speaker !== "agent") break;
    parts.push(typeof t.text === "string" ? t.text : "");
  }
  const opening = parts.join(" ");
  const said = words(opening);
  return { ok: expected.every((w, i) => said[i] === w), opening: opening.slice(0, 120) };
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const inc = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};
/** A counter keyed by log data, with no prototype: "toString" or "__proto__" is a key like any other. */
const counts = (): Record<string, number> => Object.create(null) as Record<string, number>;

// ---- Replay state ------------------------------------------------------------------

interface Slot {
  start: number;
  end: number;
}

interface BookingState {
  id: string;
  business_id: string | undefined;
  status: BookingStatus;
  route: string | null;
  /** The booking's most recent slot (from its hold or the agreed slot). */
  slot: Slot | null;
  holds: Set<string>;
  slotAgreed: boolean;
  slotAgreedHold: string | undefined;
  everConfirmed: boolean;
  transcriptFindings: number;
  confirmedBy: string | null;
}

interface HoldState {
  id: string;
  business_id: string | undefined;
  booking_id: string | undefined;
  slot: Slot | null;
  status: "active" | "converted" | "released" | "expired";
  placed_event: string;
}

interface CallState {
  id: string;
  business_id: string | undefined;
  booking_id: string | undefined;
  dial_call_id: string | undefined;
  checkedPlacement: boolean;
  live: boolean;
  ended: boolean;
  transcript: { ok: boolean; opening: string | null; event_id: string } | null;
  flaggedMissing: boolean;
  verifiedEvent: string | undefined;
}

export function auditEventLog(events: readonly PlatypusEvent[], opts: AuditOptions = {}): AuditResult {
  const disclosure = opts.disclosure ?? DISCLOSURE;
  const dncConfidence = opts.dncConfidence ?? 0.9;
  const exempt = new Set(opts.consentExemptKinds ?? DEFAULT_EXEMPT_KINDS);

  const violations: AuditViolation[] = [];
  const checked: Record<AuditRuleId, number> = Object.fromEntries(AUDIT_RULE_IDS.map((r) => [r, 0])) as Record<AuditRuleId, number>;
  const fail = (rule: AuditRuleId, event_id: string | null, message: string, severity: AuditSeverity = "error") =>
    violations.push({ rule, severity, event_id, message });

  const bookings = new Map<string, BookingState>();
  const holds = new Map<string, HoldState>();
  const calls = new Map<string, CallState>();
  const callsByDialId = new Map<string, CallState>();
  const liveCallByBusiness = new Map<string, string>();
  const unresolvedPlacement = new Map<string, { call_id: string; event_id: string }>();
  const doNotCall = new Map<string, string>();
  const consents = new Map<string, { business_id: string | undefined; active: boolean }>();
  const revokedBusinesses = new Set<string>();
  const received = new Map<string, { business_id: string | undefined; booking_id: string | undefined; event_id: string }>();
  const replyClass = new Map<string, string>();
  /** message id -> the booking its yes confirmed: one yes confirms one booking. */
  const usedYes = new Map<string, string>();

  const stats: AuditStats = {
    events: events.length,
    first_at: null,
    last_at: null,
    events_by_actor: counts(),
    bookings: { total: 0, by_route: counts(), by_status: counts(), confirmed_by: counts() },
    calls: { placed: 0, ended: 0, transcribed: 0, disclosure_verified: 0, disclosure_missing: 0, live_at_end: 0, tool_calls: 0 },
    holds: { placed: 0, converted: 0, released: 0, expired: 0, active_at_end: 0 },
    consents: { recorded: 0, revoked: 0, active_at_end: 0 },
    messages: { sent: 0, received: 0, not_sent: 0, by_channel: counts() },
    owner_reply_seconds: { median: null, samples: 0 },
  };
  const lastSentAt = new Map<string, number>();
  const replySeconds: number[] = [];

  const activeConsentCount = (businessId: string) => [...consents.values()].filter((c) => c.active && c.business_id === businessId).length;

  const callFor = (id: string | undefined): CallState | undefined => (id ? (calls.get(id) ?? callsByDialId.get(id)) : undefined);
  const ensureCall = (id: string, e: PlatypusEvent): CallState => {
    let c = calls.get(id);
    if (!c) {
      c = {
        id,
        business_id: str(e.refs?.business_id),
        booking_id: str(e.refs?.booking_id),
        dial_call_id: undefined,
        checkedPlacement: false,
        live: false,
        ended: false,
        transcript: null,
        flaggedMissing: false,
        verifiedEvent: undefined,
      };
      calls.set(id, c);
    }
    c.business_id ??= str(e.refs?.business_id);
    c.booking_id ??= str(e.refs?.booking_id);
    return c;
  };

  const slotOf = (p: Obj): Slot | null => {
    const start = ms(p.slot_start);
    const end = ms(p.slot_end);
    return start !== undefined && end !== undefined ? { start, end } : null;
  };

  let previousId: string | null = null;
  const seenIds = new Set<string>();

  for (const raw of events) {
    const e = raw as PlatypusEvent;
    const id = typeof e?.id === "string" ? e.id : null;
    const type = typeof e?.type === "string" ? e.type : "";
    const refs: Obj = isObj(e?.refs) ? e.refs : {};
    const p: Obj = isObj(e?.payload) ? e.payload : {};
    const businessId = str(refs.business_id);
    const bookingId = str(refs.booking_id);

    // ---- R5: shape, actor, confidence, ids, reasons ---------------------------------
    checked.R5++;
    if (!id) fail("R5", null, `An event of type "${type || "?"}" has no id.`);
    else {
      if (seenIds.has(id)) fail("R5", id, `Event id ${id} appears twice; the log is append-only and ids are unique.`);
      else if (previousId !== null && id <= previousId) fail("R5", id, `Event id ${id} is not greater than the previous id ${previousId}; ids must increase monotonically.`);
      seenIds.add(id);
      previousId = id;
    }
    if (!type) fail("R5", id, "An event has no type.");
    if (!ACTOR_SET.has(e?.actor as string)) fail("R5", id, `${type || "Event"} has actor "${String(e?.actor)}", which is not one of ${EVENT_ACTORS.join(", ")}.`);
    if (typeof e?.confidence !== "number" || !(e.confidence >= 0 && e.confidence <= 1)) {
      fail("R5", id, `${type || "Event"} has confidence ${String(e?.confidence)}; it must be a number in [0, 1].`);
    }
    if (NEEDS_REASON.test(type) && !(typeof e.reason === "string" && e.reason.trim())) {
      fail("R5", id, `${type} changes state but records no reason.`);
    }
    const at = ms(e?.created_at);
    if (at === undefined) fail("R5", id, `${type || "Event"} has no valid created_at timestamp.`);
    else {
      stats.first_at ??= e.created_at;
      stats.last_at = e.created_at;
    }
    if (typeof e?.actor === "string") inc(stats.events_by_actor, e.actor);

    // ---- Bookings ------------------------------------------------------------------------
    if (type.startsWith("booking.")) {
      const sub = type.slice("booking.".length);
      if (STATUS_SET.has(sub) && bookingId) {
        const to = sub as BookingStatus;
        const from = str(p.from);
        let b = bookings.get(bookingId);
        let r1Flagged = false;

        if (to === "confirmed") r1Flagged = checkConfirmation(e, id, p, b);

        if (from === undefined) {
          // A creation event: booking.pending or booking.quote_pending.
          if (b) fail("R5", id, `${type} re-creates booking ${short(bookingId)}, which already exists (${b.status}).`);
          else if (to !== "pending" && to !== "quote_pending") fail("R5", id, `Booking ${short(bookingId)} first appears as ${to} with no "from" status; bookings start as pending or quote_pending.`);
          if (!b) {
            b = newBooking(bookingId, businessId, to, str(p.route) ?? null);
            bookings.set(bookingId, b);
          }
        } else if (!b) {
          // The log starts after this booking was created: trust the event's own "from".
          b = newBooking(bookingId, businessId, STATUS_SET.has(from) ? (from as BookingStatus) : "pending", null);
          bookings.set(bookingId, b);
          if (!STATUS_SET.has(from)) fail("R5", id, `${type} says it moved from "${from}", which is not a booking status.`);
          else if (!canTransition(from as BookingStatus, to) && !r1Flagged) fail("R5", id, `Booking ${short(bookingId)} moved ${from} → ${to}, which the state machine does not allow.`);
        } else {
          if (from !== b.status) fail("R5", id, `${type} says booking ${short(bookingId)} moved from ${from}, but the log has it at ${b.status}.`);
          if (!canTransition(b.status, to) && !r1Flagged) fail("R5", id, `Booking ${short(bookingId)} moved ${b.status} → ${to}, which the state machine does not allow.`);
        }
        if (to === "confirmed") {
          b.everConfirmed = true;
          const ev = isObj(p.evidence) ? str(p.evidence.kind) : undefined;
          b.confirmedBy = ev ?? "none";
          // A confirmed booking occupies its slot: it may not overlap another one (R7).
          if (b.slot && b.business_id) {
            checked.R7++;
            for (const other of bookings.values()) {
              if (other.id === b.id || other.business_id !== b.business_id || !other.slot) continue;
              if ((OCCUPYING_STATUSES as readonly string[]).includes(other.status) && overlaps(other.slot, b.slot)) {
                fail("R7", id, `Booking ${short(b.id)} was confirmed for a slot that overlaps confirmed booking ${short(other.id)} of the same business (double booking).`);
              }
            }
          }
        }
        b.status = to;
      } else if (sub === "slot_agreed" && bookingId) {
        const b = bookings.get(bookingId) ?? newBooking(bookingId, businessId, "pending", null);
        bookings.set(bookingId, b);
        checkSlotChange(b, id, type);
        b.slotAgreed = true;
        b.slotAgreedHold = str(refs.hold_id);
        b.slot = slotOf(p) ?? b.slot;
      } else if (sub === "transcript_candidate" && bookingId) {
        const b = bookings.get(bookingId);
        if (b) b.transcriptFindings++;
      } else if (sub === "route_changed" && bookingId) {
        const b = bookings.get(bookingId);
        if (b && str(p.to)) b.route = str(p.to)!;
      }
    }

    // ---- Holds (R7) -------------------------------------------------------------------------
    const holdId = str(refs.hold_id);
    if (type === "hold.placed" && holdId) {
      stats.holds.placed++;
      checked.R7++;
      const slot = slotOf(p);
      if (!slot) fail("R7", id, `hold.placed ${short(holdId)} has no readable slot_start/slot_end.`);
      else if (!(slot.start < slot.end)) fail("R7", id, `hold.placed ${short(holdId)} ends before it starts.`);
      if (holds.has(holdId)) fail("R7", id, `Hold ${short(holdId)} was placed twice.`);
      if (slot && businessId) {
        for (const h of holds.values()) {
          if (h.id !== holdId && h.status === "active" && h.business_id === businessId && h.slot && overlaps(h.slot, slot)) {
            fail("R7", id, `Hold ${short(holdId)} overlaps active hold ${short(h.id)} for the same business.`);
          }
        }
        for (const b of bookings.values()) {
          if (b.id === bookingId || b.business_id !== businessId || !b.slot) continue;
          if ((OCCUPYING_STATUSES as readonly string[]).includes(b.status) && overlaps(b.slot, slot)) {
            fail("R7", id, `Hold ${short(holdId)} overlaps confirmed booking ${short(b.id)} of the same business.`);
          }
        }
      }
      holds.set(holdId, { id: holdId, business_id: businessId, booking_id: bookingId, slot, status: "active", placed_event: id ?? "" });
      if (bookingId) {
        const b = bookings.get(bookingId);
        if (b) {
          checkSlotChange(b, id, type);
          b.holds.add(holdId);
          if (slot) b.slot = slot;
        }
      }
    } else if ((type === "hold.converted" || type === "hold.released" || type === "hold.expired") && holdId) {
      const next = type.slice("hold.".length) as HoldState["status"];
      stats.holds[next as "converted" | "released" | "expired"]++;
      const h = holds.get(holdId);
      if (h) {
        if (h.status !== "active") fail("R7", id, `Hold ${short(holdId)} became ${next}, but it was already ${h.status}.`);
        h.status = next;
        if (bookingId && !h.booking_id) h.booking_id = bookingId;
      }
      if (bookingId) bookings.get(bookingId)?.holds.add(holdId);
    }

    // ---- Calls (R2, R4) ---------------------------------------------------------------------
    const callId = str(refs.call_id);
    if (type === "call.placing" || type === "call.placed") {
      if (callId) {
        const c = ensureCall(callId, e);
        if (str(p.dial_call_id)) {
          c.dial_call_id = str(p.dial_call_id);
          callsByDialId.set(c.dial_call_id!, c);
        }
        if (!c.checkedPlacement && c.business_id) {
          c.checkedPlacement = true;
          checked.R4++;
          const dnc = doNotCall.get(c.business_id);
          if (dnc) fail("R4", id, `A call to business ${short(c.business_id)} was placed after the owner asked not to be called (${short(dnc)}).`);
          const live = liveCallByBusiness.get(c.business_id);
          if (live && live !== callId) fail("R4", id, `Call ${short(callId)} was placed while call ${short(live)} to the same business was still live.`);
          const unknown = unresolvedPlacement.get(c.business_id);
          if (unknown && unknown.call_id !== callId) {
            fail("R4", id, `Call ${short(callId)} was attempted while the placement of call ${short(unknown.call_id)} was still unknown: a blind retry. List calls and reconcile first.`);
          }
        }
        if (type === "call.placed") {
          stats.calls.placed++;
          c.live = true;
          if (c.business_id) liveCallByBusiness.set(c.business_id, callId);
        }
      }
    } else if (type === "call.placement_unknown" && callId) {
      const c = ensureCall(callId, e);
      if (c.business_id) unresolvedPlacement.set(c.business_id, { call_id: callId, event_id: id ?? "" });
    } else if (type === "call.placement_reconciled" && callId) {
      const c = ensureCall(callId, e);
      if (c.business_id && unresolvedPlacement.get(c.business_id)?.call_id === callId) unresolvedPlacement.delete(c.business_id);
      if (str(p.dial_call_id)) callsByDialId.set(str(p.dial_call_id)!, c);
    } else if (type === "call.ended" && callId) {
      stats.calls.ended++;
      const c = ensureCall(callId, e);
      c.live = false;
      c.ended = true;
      if (c.business_id && liveCallByBusiness.get(c.business_id) === callId) liveCallByBusiness.delete(c.business_id);
    } else if (type === "call.transcribed" && callId) {
      stats.calls.transcribed++;
      const c = ensureCall(callId, e);
      const check = openingStartsWithDisclosure(p.turns, disclosure);
      c.transcript = { ...check, event_id: id ?? "" };
    } else if (type === "call.disclosure_missing" && callId) {
      stats.calls.disclosure_missing++;
      ensureCall(callId, e).flaggedMissing = true;
    } else if (type === "call.disclosure_verified" && callId) {
      stats.calls.disclosure_verified++;
      ensureCall(callId, e).verifiedEvent = id ?? undefined;
    } else if (type === "call.do_not_call" && businessId) {
      if ((e.confidence ?? 0) >= dncConfidence) doNotCall.set(businessId, id ?? "");
    } else if (type === "voice.tool_called") {
      stats.calls.tool_calls++;
    } else if (type === "transcript.mined") {
      const bid = bookingId ?? callFor(callId)?.booking_id;
      const b = bid ? bookings.get(bid) : undefined;
      if (b) b.transcriptFindings++;
    }

    // ---- Consent and messages (R3, R6) -----------------------------------------------------
    const consentId = str(refs.consent_id);
    if (type === "consent.recorded") {
      stats.consents.recorded++;
      if (consentId) consents.set(consentId, { business_id: businessId, active: true });
      else if (businessId) consents.set(`anon:${id}`, { business_id: businessId, active: true });
    } else if (type === "consent.revoked") {
      stats.consents.revoked++;
      if (businessId) revokedBusinesses.add(businessId);
      const c = consentId ? consents.get(consentId) : undefined;
      if (c) c.active = false;
      else if (businessId) for (const x of consents.values()) if (x.business_id === businessId) x.active = false;
    } else if (type === "message.received") {
      stats.messages.received++;
      const mid = str(refs.message_id);
      if (mid) received.set(mid, { business_id: businessId, booking_id: bookingId, event_id: id ?? "" });
      if (businessId && at !== undefined && e.actor === "owner") {
        const sentAt = lastSentAt.get(businessId);
        if (sentAt !== undefined && at >= sentAt) {
          replySeconds.push((at - sentAt) / 1000);
          lastSentAt.delete(businessId);
        }
      }
    } else if (type === "reply.classified") {
      const mid = str(refs.message_id);
      if (mid && str(p.class)) replyClass.set(mid, str(p.class)!);
    } else if (type === "message.not_sent") {
      stats.messages.not_sent++;
    } else if (type === "message.sent") {
      stats.messages.sent++;
      const channel = str(p.channel) ?? "unknown";
      inc(stats.messages.by_channel, channel);
      const kind = str(p.kind);

      checked.R3++;
      if (!businessId) fail("R3", id, "message.sent names no business, so its consent cannot be checked.", "warning");
      else if (activeConsentCount(businessId) === 0) {
        if (kind && exempt.has(kind)) {
          // The one-time STOP confirmation and HELP replies are allowed without consent.
        } else if (revokedBusinesses.has(businessId)) {
          fail("R3", id, `A ${kind ?? "message"} text went to business ${short(businessId)} after it revoked consent; only STOP and HELP confirmations may follow a revocation.`);
        } else {
          fail("R3", id, `A ${kind ?? "message"} text went to business ${short(businessId)}, which never consented to texts.`);
        }
      }

      checked.R6++;
      if (channel === "sms" && p.dial_to_dial !== true) {
        fail("R6", id, `A text went out over sms to business ${short(businessId)} without the dial_to_dial flag; sms to non-Dial numbers needs 10DLC.`);
      }
      if (businessId && at !== undefined) lastSentAt.set(businessId, at);
    }
  }

  // ---- R2, judged at the end: the disclosure check events follow the transcript ------------
  for (const c of calls.values()) {
    if (!c.transcript) {
      if (c.flaggedMissing) fail("R2", null, `Call ${short(c.id)} was flagged call.disclosure_missing.`, "warning");
      continue;
    }
    checked.R2++;
    if (c.transcript.ok) continue;
    const said = c.transcript.opening ? `"${c.transcript.opening}"` : "no agent turn at all";
    if (c.verifiedEvent) {
      fail("R2", c.verifiedEvent, `Call ${short(c.id)} was marked disclosure_verified, but the agent opened with ${said}.`);
    } else if (c.flaggedMissing) {
      fail("R2", c.transcript.event_id, `Call ${short(c.id)} opened without the disclosure (${said}); it was flagged call.disclosure_missing.`, "warning");
    } else {
      fail("R2", c.transcript.event_id, `Call ${short(c.id)} opened with ${said} instead of the disclosure, and nothing flagged it.`);
    }
  }

  // ---- Stats --------------------------------------------------------------------------------
  stats.bookings.total = bookings.size;
  for (const b of bookings.values()) {
    inc(stats.bookings.by_status, b.status);
    inc(stats.bookings.by_route, b.route ?? "unrouted");
    if (b.confirmedBy) inc(stats.bookings.confirmed_by, b.confirmedBy);
  }
  stats.calls.live_at_end = [...calls.values()].filter((c) => c.live).length;
  stats.holds.active_at_end = [...holds.values()].filter((h) => h.status === "active").length;
  stats.consents.active_at_end = [...consents.values()].filter((c) => c.active).length;
  stats.owner_reply_seconds = { median: median(replySeconds), samples: replySeconds.length };

  const rules: AuditRuleSummary[] = AUDIT_RULE_IDS.map((rule) => ({
    id: rule,
    title: AUDIT_RULES[rule].title,
    checked: checked[rule],
    errors: violations.filter((v) => v.rule === rule && v.severity === "error").length,
    warnings: violations.filter((v) => v.rule === rule && v.severity === "warning").length,
  }));
  return { ok: !violations.some((v) => v.severity === "error"), violations, rules, stats };

  /** A hold or an agreed slot for a confirmed or closed booking changes its terms without a transition. */
  function checkSlotChange(b: BookingState, id: string | null, type: string): void {
    if (SETTLED.includes(b.status)) {
      fail("R5", id, `${type} changes the slot of booking ${short(b.id)}, which is ${b.status}; its time and price may only change through a transition (rescheduled).`);
    }
  }

  // ---- R1 and R8: the confirmation checks ------------------------------------------------------

  /** Returns true when it reported the confirmation as illegal, so R5 does not report it twice. */
  function checkConfirmation(e: PlatypusEvent, id: string | null, p: Obj, b: BookingState | undefined): boolean {
    checked.R1++;
    const bk = short(str(e.refs?.booking_id));
    let illegal = false;
    if (b?.everConfirmed && b.status !== "rescheduled") {
      fail("R1", id, `Booking ${bk} was confirmed twice.`);
      illegal = true;
    }
    if (b && TERMINAL_FOR_CONFIRM.includes(b.status)) {
      fail("R1", id, `Booking ${bk} was confirmed after it was ${b.status}.`);
      illegal = true;
    }

    const evidence = p.evidence;
    const transcriptShaped = isObj(evidence) && (evidence.kind === "transcript" || evidence.source === "transcript" || "transcript_turn" in evidence);
    if (b && (b.transcriptFindings > 0 || transcriptShaped)) checked.R8++;
    if (transcriptShaped) {
      fail("R8", id, `Booking ${bk} was confirmed with evidence taken from the transcript; a transcript is never a confirmation.`);
    }
    if (!isObj(evidence)) {
      fail("R1", id, `Booking ${bk} was confirmed with no evidence of the owner's yes.`);
      return illegal;
    }
    const kind = evidence.kind;
    const businessId = b?.business_id ?? str(e.refs?.business_id);

    if (kind === "call") {
      if (e.actor !== "voice") fail("R1", id, `Booking ${bk} has call evidence but was confirmed by actor "${e.actor}", not the voice tools.`);
      if (!str(evidence.quotedSentence)?.trim()) fail("R1", id, `Booking ${bk} was confirmed on a call without quoting the owner's yes.`);
      const call = callFor(str(evidence.callId));
      if (!call) fail("R1", id, `Booking ${bk} cites call ${short(str(evidence.callId))}, which never appears in the log.`);
      else {
        if (call.business_id && businessId && call.business_id !== businessId) fail("R1", id, `Booking ${bk} cites a call with a different business.`);
        if (call.ended) fail("R1", id, `Booking ${bk} was confirmed after call ${short(call.id)} had ended; call confirmations happen mid-call through the tools.`);
      }
      const toolsBooked = Boolean(b?.slotAgreed);
      const held = Boolean(b && ([...b.holds].some((h) => holds.has(h)) || (b.slotAgreedHold && holds.has(b.slotAgreedHold))));
      if (!toolsBooked) fail("R1", id, `Booking ${bk} was confirmed on a call, but no booking.slot_agreed shows it was booked through the tools.`);
      if (!held) fail("R1", id, `Booking ${bk} was confirmed on a call, but no hold.placed was ever recorded for it.`);
      if (b && b.transcriptFindings > 0 && !(toolsBooked && held)) {
        fail("R8", id, `Booking ${bk} was confirmed from the call transcript alone: it has transcript findings but was never booked through the tools.`);
      }
    } else if (kind === "text") {
      if (e.actor !== "owner") fail("R1", id, `Booking ${bk} has text evidence but was confirmed by actor "${e.actor}", not the owner.`);
      const mid = str(evidence.messageId);
      const msg = mid ? received.get(mid) : undefined;
      if (!msg) fail("R1", id, `Booking ${bk} cites message ${short(mid)}, but no message.received with that id came before.`);
      else {
        if (msg.business_id && businessId && msg.business_id !== businessId) fail("R1", id, `Booking ${bk} was confirmed by a text from a different business.`);
        const cls = replyClass.get(mid!);
        if (cls !== "accept") fail("R1", id, `Booking ${bk} was confirmed by a text classified ${cls ? `"${cls}"` : "nothing yet"}, not accept.`);
        const about = msg.booking_id;
        const target = str(e.refs?.booking_id);
        if (about && target && about !== target) fail("R1", id, `Booking ${bk} was confirmed by the owner's reply about booking ${short(about)}.`);
        const earlier = usedYes.get(mid!);
        if (earlier && target && earlier !== target) fail("R1", id, `Booking ${bk} was confirmed by the same yes that already confirmed booking ${short(earlier)}; one yes confirms one booking.`);
        if (target) usedYes.set(mid!, target);
      }
    } else if (kind === "rule") {
      if (e.actor !== "autopilot") fail("R1", id, `Booking ${bk} has rule evidence but was confirmed by actor "${e.actor}", not autopilot.`);
      if (!str(evidence.ruleId)) fail("R1", id, `Booking ${bk} cites rule evidence without a rule id.`);
    } else {
      fail("R1", id, `Booking ${bk} was confirmed with evidence of kind "${String(kind)}"; only call, text and rule are accepted.`);
    }
    return illegal;
  }
}

/** Statuses whose slot is settled or final: only a transition (reschedule) may change their time or price. */
const SETTLED: readonly BookingStatus[] = ["confirmed", "completed", "no_show", "disputed", "declined", "expired", "cancelled"];

function newBooking(id: string, business_id: string | undefined, status: BookingStatus, route: string | null): BookingState {
  return {
    id,
    business_id,
    status,
    route,
    slot: null,
    holds: new Set(),
    slotAgreed: false,
    slotAgreedHold: undefined,
    everConfirmed: false,
    transcriptFindings: 0,
    confirmedBy: null,
  };
}
