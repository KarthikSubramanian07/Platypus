import {
  attachHold,
  BookingError,
  confirm,
  createBooking,
  getBooking,
  OCCUPYING_STATUSES,
  placeHold,
  releaseHold,
  type BookingContext,
} from "@platypus/shared/booking";
import { isE164, maskNumber, type TextChannel } from "@platypus/shared/config";
import {
  authorizeVoiceRequest,
  VOICE_TOOLS,
  VoiceAuthorizationError,
  type VoiceToolContext,
  type VoiceToolName,
  type VoiceTools,
} from "@platypus/shared/contracts";
import { getBusiness, getRow, insertRow, selectRows, updateRow, type Business, type Call, type Db, type Hold } from "@platypus/shared/db";
import { emit, type EmitInput, type EventBus, type PlatypusEvent } from "@platypus/shared/events";
// shared does not export ./ids yet; one monotonic ULID source keeps ids ordered across packages.
import { newId } from "@platypus/shared/ids";
import { sanitizeUntrustedText } from "@platypus/shared/safety";
import type { z } from "zod";
import { generateSlots } from "./business-hours";
import { failureCode, VoiceToolInputError } from "./errors";

/** Injectable time (structurally the shared Clock). */
export interface Clock {
  now(): Date;
}

const systemClock: Clock = { now: () => new Date() };

export interface VoiceToolsDeps {
  db: Db;
  bus: Pick<EventBus, "publish">;
  clock?: Clock;
  /** TEXT_CHANNEL: the rail the business moves to once it says yes to texts. */
  textChannel: TextChannel;
}

type Input<K extends VoiceToolName> = z.infer<(typeof VOICE_TOOLS)[K]["input"]>;
type Output<K extends VoiceToolName> = z.infer<(typeof VOICE_TOOLS)[K]["output"]>;

/** What a tool body returns: the contract output, and whether it replayed an earlier result. */
interface Outcome<K extends VoiceToolName> {
  output: Output<K>;
  replayed?: boolean;
}

/** Owner-stated slots this far in the past are refused; a little slack absorbs clock skew. */
const PAST_SLACK_MS = 60_000;
const MAX_SLOT_MS = 24 * 60 * 60_000;
const DEFAULT_DURATION_MINUTES = 60;

/**
 * The real VoiceTools: what Dial's voice agent calls mid-call through the Context MCP.
 *
 * Every request is authorized on its own. It needs an E.164 caller number and
 * direction "outbound", and that number must have a live outbound call with the
 * business the tool names. Context MCP tools are wired to every call on the Dial
 * account, so nothing here may trust the arguments alone.
 *
 * The voice model retries, so the writes are idempotent within one live call:
 * - holding the same slot twice returns the same hold;
 * - booking the same hold twice returns the same booking;
 * - recording consent twice on one call returns the same consent.
 *
 * Bookings are confirmed only through confirm() with call evidence, meaning the
 * call id and the owner's quoted words (non-negotiable 1). Every outcome, success
 * or failure, is appended to the event log as voice.tool_called.
 */
export function createVoiceTools(deps: VoiceToolsDeps): VoiceTools {
  const { db, bus, textChannel } = deps;
  const clock = deps.clock ?? systemClock;
  const booking: BookingContext = { db, bus, clock };

  /** Runs fn in one transaction and publishes its events only after commit. */
  function inTx<T>(fn: (record: (input: EmitInput) => void) => T): T {
    const held: PlatypusEvent[] = [];
    const collector = { publish: (e: PlatypusEvent) => held.push(e) };
    const result = db.transaction(() => fn((input) => void emit(db, input, { bus: collector, clock })))();
    for (const e of held) bus.publish(e);
    return result;
  }

  function authorize(vctx: VoiceToolContext | undefined, businessId: string | undefined): Call {
    if (!vctx?.caller_number || !isE164(vctx.caller_number)) throw new VoiceAuthorizationError("Missing or invalid X-Dial-User-Number");
    if (vctx.direction !== "outbound") throw new VoiceAuthorizationError("Booking tools only run on outbound calls");
    const call = authorizeVoiceRequest(db, vctx, businessId);
    if (call.direction !== "outbound") throw new VoiceAuthorizationError("Booking tools only run on outbound calls");
    return call;
  }

  function logCall(tool: VoiceToolName, callId: string | undefined, vctx: VoiceToolContext | undefined, ok: boolean, payload: Record<string, unknown>, reason: string): void {
    const call = callId ? getRow(db, "calls", callId) : undefined;
    emit(
      db,
      {
        type: "voice.tool_called",
        actor: "voice",
        refs: call ? { call_id: call.id, business_id: call.business_id, ...(call.booking_id ? { booking_id: call.booking_id } : {}) } : {},
        payload: {
          tool,
          ok,
          ...payload,
          ...(!call && vctx?.caller_number ? { caller_masked: maskNumber(vctx.caller_number) } : {}),
        },
        reason,
      },
      { bus, clock },
    );
  }

  async function run<K extends VoiceToolName>(
    tool: K,
    rawInput: unknown,
    vctx: VoiceToolContext,
    body: (input: Input<K>, call: Call) => Outcome<K>,
  ): Promise<Output<K>> {
    let call: Call | undefined;
    try {
      // Authorize before reading the input closely, so a stranger learns nothing about the contract.
      const named = (rawInput as { business_id?: unknown } | null)?.business_id;
      call = authorize(vctx, typeof named === "string" ? named : undefined);
      const parsed = VOICE_TOOLS[tool].input.safeParse(rawInput);
      if (!parsed.success) throw new VoiceToolInputError([...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))]);
      const { output, replayed } = body(parsed.data as Input<K>, call);
      const checked = VOICE_TOOLS[tool].output.parse(output) as Output<K>;
      logCall(tool, call.id, vctx, true, { output: checked, ...(replayed ? { replayed: true } : {}) }, replayed ? `${tool} replayed an earlier result` : `${tool} succeeded`);
      return checked;
    } catch (error) {
      const code = failureCode(error);
      logCall(tool, call?.id, vctx, false, { code, error: (error as Error).message }, `${tool} failed: ${code}`);
      throw error;
    }
  }

  // ---- Helpers ------------------------------------------------------------------

  /** True when [start, end) overlaps a live hold (other than `exclude`) or an occupying booking. */
  function slotBusy(businessId: string, start: string, end: string, exclude: readonly string[] = []): boolean {
    const now = clock.now().toISOString();
    const notIn = exclude.length ? ` AND id NOT IN (${exclude.map(() => "?").join(", ")})` : "";
    const holds = selectRows(db, "holds", `business_id = ? AND status = 'active' AND expires_at > ? AND slot_start < ? AND slot_end > ?${notIn}`, [businessId, now, end, start, ...exclude]);
    if (holds.length) return true;
    const bookings = selectRows(
      db,
      "bookings",
      `business_id = ? AND status IN (${OCCUPYING_STATUSES.map(() => "?").join(", ")}) AND slot_start < ? AND slot_end > ?`,
      [businessId, ...OCCUPYING_STATUSES, end, start],
    );
    return bookings.length > 0;
  }

  /** Holds this call placed, newest first. A call row's booking ties them together; created_at bounds them to this call. */
  function callHolds(call: Call, statuses: Hold["status"][]): Hold[] {
    const marks = statuses.map(() => "?").join(", ");
    const sameBooking = call.booking_id ? "booking_id = ?" : "booking_id IS NULL";
    return selectRows(
      db,
      "holds",
      `business_id = ? AND created_by = 'voice' AND created_at >= ? AND status IN (${marks}) AND ${sameBooking}`,
      [call.business_id, call.created_at, ...statuses, ...(call.booking_id ? [call.booking_id] : [])],
      "created_at DESC, id DESC",
    );
  }

  function serviceDuration(business: Business, call: Call): number {
    const service = call.booking_id ? getRow(db, "bookings", call.booking_id)?.service : undefined;
    const match = service ? business.services.find((s) => s.name.toLowerCase() === service.toLowerCase()) : undefined;
    return (match ?? business.services[0])?.duration_minutes ?? DEFAULT_DURATION_MINUTES;
  }

  const iso = (value: string) => new Date(value).toISOString();

  // ---- Tools ----------------------------------------------------------------------

  return {
    check_slot: (input, vctx) =>
      run("check_slot", input, vctx, (i, call) => {
        const business = getBusiness(db, call.business_id)!;
        // The call's own holds are not "busy" to itself: re-checking after a hold still shows that time.
        const own = callHolds(call, ["active"]).map((h) => h.id);
        const slots = generateSlots({
          hours: business.hours,
          timeZone: business.timezone,
          window: i.window,
          durationMinutes: serviceDuration(business, call),
          notBefore: clock.now(),
          isBusy: (s, e) => slotBusy(business.id, s.toISOString(), e.toISOString(), own),
        });
        return { output: { slots } };
      }),

    hold_slot: (input, vctx) =>
      run("hold_slot", input, vctx, (i, call) => {
        const start = iso(i.slot.start);
        const end = iso(i.slot.end);
        const startMs = Date.parse(start);
        const endMs = Date.parse(end);
        if (!(startMs < endMs)) throw new BookingError("invalid_slot", "A slot must end after it starts");
        if (endMs - startMs > MAX_SLOT_MS) throw new BookingError("invalid_slot", "A slot cannot be longer than a day");
        if (startMs < clock.now().getTime() - PAST_SLACK_MS) throw new BookingError("invalid_slot", "That time has already passed");

        // Retry of the same slot on this call: return the hold it already has.
        const mine = callHolds(call, ["active", "converted"]);
        const same = mine.find((h) => h.slot_start === start && h.slot_end === end && (h.status === "converted" || Date.parse(h.expires_at) > clock.now().getTime()));
        if (same) return { output: { hold_id: same.id, expires_at: same.expires_at }, replayed: true };

        // The owner may name any free time, not only one check_slot offered. Business
        // hours are advice for offering times; the owner's own word overrides them.
        const active = mine.filter((h) => h.status === "active").map((h) => h.id);
        if (slotBusy(call.business_id, start, end, active)) throw new BookingError("slot_unavailable", "That slot is already held or booked");
        // The owner changed their mind on this call: free the time held earlier first.
        for (const id of active) releaseHold(booking, id, "voice", "owner picked a different time on the call");
        const hold = placeHold(booking, { business_id: call.business_id, slot_start: start, slot_end: end, booking_id: call.booking_id, created_by: "voice" });
        return { output: { hold_id: hold.id, expires_at: hold.expires_at } };
      }),

    create_booking: (input, vctx) =>
      run("create_booking", input, vctx, (i, call) => {
        const hold = getRow(db, "holds", i.hold_id);
        if (!hold) throw new BookingError("not_found", "No hold with that id");
        if (hold.business_id !== call.business_id) throw new VoiceAuthorizationError("The hold is for a different business than the live call");
        if (hold.booking_id && call.booking_id && hold.booking_id !== call.booking_id) {
          throw new VoiceAuthorizationError("The hold belongs to a different business booking than the live call");
        }

        // Retry after success: the hold was converted into this booking already.
        if (hold.status === "converted" && hold.booking_id) {
          const done = getBooking(booking, hold.booking_id);
          if (done.status === "confirmed") return { output: { booking_id: done.id, short_code: done.short_code }, replayed: true };
        }

        let bookingId = hold.booking_id ?? call.booking_id;
        if (!bookingId) {
          // A call placed without a pending booking (a manual test call): open one so the yes has somewhere to land.
          const business = getBusiness(db, call.business_id)!;
          bookingId = createBooking(booking, {
            business_id: call.business_id,
            agent_id: "voice-call",
            service: business.services[0]?.name ?? "unspecified",
            route: "call",
            reason: "booked on a call that had no pending booking",
          }).id;
          updateRow(db, "calls", call.id, { booking_id: bookingId, updated_at: clock.now().toISOString() });
        }

        const quoted = sanitizeUntrustedText(i.verbal_confirmation);
        attachHold(booking, hold.id, bookingId, i.price_cents, "voice");
        const confirmed = confirm(booking, bookingId, { kind: "call", callId: call.id, quotedSentence: quoted });
        return { output: { booking_id: confirmed.id, short_code: confirmed.short_code } };
      }),

    record_consent: (input, vctx) =>
      run("record_consent", input, vctx, (i, call) => {
        const existing = selectRows(db, "consents", "call_id = ? AND revoked_at IS NULL", [call.id], "created_at DESC")[0];
        if (existing) return { output: { consent_id: existing.id }, replayed: true };

        const quote = sanitizeUntrustedText(i.quote);
        if (!quote) throw new VoiceToolInputError(["quote"]);
        const consentId = inTx((record) => {
          const now = clock.now().toISOString();
          const consent = insertRow(db, "consents", {
            id: newId("consent", clock.now().getTime()),
            business_id: call.business_id,
            // The owner agreed to texts; the rail is ours to choose, and never sms to a non-Dial number.
            channel: textChannel,
            source: "call",
            quoted_sentence: quote,
            call_id: call.id,
            transcript_turn_ref: null,
            message_id: null,
            created_at: now,
            revoked_at: null,
            revoked_reason: null,
          });
          const before = getBusiness(db, call.business_id)!;
          record({
            type: "consent.recorded",
            actor: "voice",
            refs: { consent_id: consent.id, business_id: call.business_id, call_id: call.id },
            payload: { channel: textChannel, requested_channel: i.channel, quoted_sentence: quote, source: "call" },
            reason: "owner said yes to texts on the call",
          });
          if (before.channel_state !== "text_enabled" || before.channel_pref !== textChannel) {
            updateRow(db, "businesses", call.business_id, { channel_state: "text_enabled", channel_pref: textChannel, updated_at: now });
            record({
              type: "business.channel_changed",
              actor: "voice",
              refs: { business_id: call.business_id, consent_id: consent.id },
              payload: { from: before.channel_state, to: "text_enabled", rail: textChannel },
              reason: "consent recorded",
            });
          }
          return consent.id;
        });
        return { output: { consent_id: consentId } };
      }),

    set_text_number: (input, vctx) =>
      run("set_text_number", input, vctx, (i, call) => {
        const business = getBusiness(db, call.business_id)!;
        if (business.text_number_e164 === i.e164) return { output: { ok: true as const }, replayed: true };
        inTx((record) => {
          updateRow(db, "businesses", call.business_id, { text_number_e164: i.e164, updated_at: clock.now().toISOString() });
          // Storing a number is not contacting it; ALLOWED_NUMBERS is enforced where messages are sent.
          record({
            type: "business.text_number_set",
            actor: "voice",
            refs: { business_id: call.business_id, call_id: call.id },
            payload: { number_masked: maskNumber(i.e164), same_as_called: i.e164 === call.to_e164 },
            reason: "owner gave the best cell to text",
          });
        });
        return { output: { ok: true as const } };
      }),
  };
}
