import { attachHold, confirm, createBooking, getBooking, OCCUPYING_STATUSES, placeHold, type BookingContext } from "../booking/index";
import { systemClock } from "../clock";
import { maskNumber, type TextChannel } from "../config";
import { getRow, insertRow, selectRows, updateRow } from "../db/repo";
import { emit } from "../events/log";
import { authorizeVoiceRequest, VOICE_TOOLS, type VoiceToolContext, type VoiceToolName, type VoiceTools } from "../contracts/index";
import { newId } from "../ids";

export interface FakeGatewayOptions extends BookingContext {
  /** The rail consent is recorded for; mirrors TEXT_CHANNEL. */
  textChannel?: TextChannel;
}

/**
 * In-memory VoiceTools for workstream A until the real gateway lands. Not a mock:
 * it validates inputs against the contract, authorizes every request on the
 * caller number, and books through the real state machine, so a test that
 * passes here exercises the same rules the real gateway enforces.
 * Every tool call is logged as a voice.tool_called event for the dashboard timeline.
 */
export function createFakeGateway(options: FakeGatewayOptions): VoiceTools {
  const ctx: BookingContext = options;
  const clock = options.clock ?? systemClock;
  const { db } = options;
  const textChannel = options.textChannel ?? "imessage";
  const log = (tool: VoiceToolName, call: { id: string; business_id: string; booking_id: string | null }, ok: boolean, payload: Record<string, unknown>) =>
    emit(
      db,
      {
        type: "voice.tool_called",
        actor: "voice",
        refs: { call_id: call.id, business_id: call.business_id, ...(call.booking_id ? { booking_id: call.booking_id } : {}) },
        payload: { tool, ok, ...payload },
        reason: ok ? `${tool} succeeded` : `${tool} failed`,
      },
      { ...(options.bus ? { bus: options.bus } : {}), clock },
    );

  async function run<K extends VoiceToolName>(
    tool: K,
    rawInput: unknown,
    vctx: VoiceToolContext,
    businessIdOf: (input: never) => string | undefined,
    body: (input: never, call: ReturnType<typeof authorizeVoiceRequest>) => Record<string, unknown>,
  ): Promise<never> {
    const input = VOICE_TOOLS[tool].input.parse(rawInput) as never;
    const call = authorizeVoiceRequest(db, vctx, businessIdOf(input));
    try {
      const output = body(input, call);
      log(tool, call, true, { output });
      return VOICE_TOOLS[tool].output.parse(output) as never;
    } catch (error) {
      log(tool, call, false, { error: (error as Error).message });
      throw error;
    }
  }

  return {
    check_slot: (input, vctx) =>
      run("check_slot", input, vctx, (i: { business_id: string }) => i.business_id, (i: { business_id: string; window: { start: string; end: string } }) => {
        const business = getRow(db, "businesses", i.business_id)!;
        const minutes = business.services[0]?.duration_minutes ?? 60;
        const start = new Date(i.window.start);
        const end = new Date(i.window.end);
        start.setUTCMinutes(Math.ceil(start.getUTCMinutes() / 30) * 30, 0, 0);
        const slots: { start: string; end: string }[] = [];
        for (let t = start.getTime(); t + minutes * 60_000 <= end.getTime() && slots.length < 8; t += 60 * 60_000) {
          const s = new Date(t).toISOString();
          const e = new Date(t + minutes * 60_000).toISOString();
          const busy =
            selectRows(db, "holds", "business_id = ? AND status = 'active' AND expires_at > ? AND slot_start < ? AND slot_end > ?", [business.id, clock.now().toISOString(), e, s]).length +
            selectRows(db, "bookings", `business_id = ? AND status IN (${OCCUPYING_STATUSES.map(() => "?").join(",")}) AND slot_start < ? AND slot_end > ?`, [business.id, ...OCCUPYING_STATUSES, e, s]).length;
          if (!busy) slots.push({ start: s, end: e });
        }
        return { slots };
      }),

    hold_slot: (input, vctx) =>
      run("hold_slot", input, vctx, (i: { business_id: string }) => i.business_id, (i: { business_id: string; slot: { start: string; end: string } }, call) => {
        const hold = placeHold(ctx, { business_id: i.business_id, slot_start: i.slot.start, slot_end: i.slot.end, booking_id: call.booking_id, created_by: "voice" });
        return { hold_id: hold.id, expires_at: hold.expires_at };
      }),

    create_booking: (input, vctx) =>
      run("create_booking", input, vctx, () => undefined, (i: { hold_id: string; price_cents: number; verbal_confirmation: string }, call) => {
        const hold = getRow(db, "holds", i.hold_id);
        if (!hold || hold.business_id !== call.business_id) throw new Error("The hold is not for the business on this call");
        const bookingId =
          call.booking_id ??
          createBooking(ctx, { business_id: call.business_id, agent_id: "voice-call", service: "unspecified", route: "call", reason: "booked on an inbound call" }).id;
        attachHold(ctx, hold.id, bookingId, i.price_cents, "voice");
        const booking = confirm(ctx, bookingId, { kind: "call", callId: call.id, quotedSentence: i.verbal_confirmation });
        return { booking_id: booking.id, short_code: getBooking(ctx, booking.id).short_code };
      }),

    record_consent: (input, vctx) =>
      run("record_consent", input, vctx, (i: { business_id: string }) => i.business_id, (i: { business_id: string; channel: "sms" | "imessage" | "whatsapp" | "dial"; quote: string }, call) => {
        const now = clock.now().toISOString();
        const consent = insertRow(db, "consents", {
          id: newId("consent", clock.now().getTime()),
          business_id: i.business_id,
          channel: i.channel,
          source: "call",
          quoted_sentence: i.quote,
          call_id: call.id,
          transcript_turn_ref: null,
          message_id: null,
          created_at: now,
          revoked_at: null,
          revoked_reason: null,
        });
        const before = getRow(db, "businesses", i.business_id)!;
        updateRow(db, "businesses", i.business_id, { channel_state: "text_enabled", channel_pref: textChannel, updated_at: now });
        const busOpts = { ...(options.bus ? { bus: options.bus } : {}), clock };
        emit(db, { type: "consent.recorded", actor: "voice", refs: { consent_id: consent.id, business_id: i.business_id, call_id: call.id }, payload: { channel: i.channel, quoted_sentence: i.quote, source: "call" }, reason: "owner said yes to texts on the call" }, busOpts);
        emit(db, { type: "business.channel_changed", actor: "voice", refs: { business_id: i.business_id, consent_id: consent.id }, payload: { from: before.channel_state, to: "text_enabled", rail: textChannel }, reason: "consent recorded" }, busOpts);
        return { consent_id: consent.id };
      }),

    set_text_number: (input, vctx) =>
      run("set_text_number", input, vctx, (i: { business_id: string }) => i.business_id, (i: { business_id: string; e164: string }, call) => {
        updateRow(db, "businesses", i.business_id, { text_number_e164: i.e164, updated_at: clock.now().toISOString() });
        emit(db, { type: "business.text_number_set", actor: "voice", refs: { business_id: i.business_id, call_id: call.id }, payload: { number_masked: maskNumber(i.e164), same_as_called: i.e164 === call.to_e164 }, reason: "owner gave the best cell to text" }, { ...(options.bus ? { bus: options.bus } : {}), clock });
        return { ok: true as const };
      }),
  };
}
