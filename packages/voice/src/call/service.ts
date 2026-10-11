import { maskNumber, type TextChannel } from "@platypus/shared/config";
import { getBusiness, getCallByDialId, getRow, insertRow, selectRows, updateRow, type Booking, type Call, type Db, type TranscriptTurn } from "@platypus/shared/db";
import { emit, rowToEvent, type EmitInput, type EventBus } from "@platypus/shared/events";
import { NumberNotAllowedError } from "@platypus/shared/safety";
import { DialApiError, DialNetworkError, type DialCalls } from "../dial/client";
import { CallEndedData, CallTranscribedData, isLiveState, StatusChangedData, WireEnvelope, type WireCall, type WireEnvelope as Envelope } from "../dial/wire";
import type { AnthropicLike } from "../mining/claude";
import { mineTranscript } from "../mining/mine";
import type { Finding } from "../mining/types";
import { newCallId, systemClock, type Clock } from "./ids";
import { checkDisclosure, findBookingAgreement, verifyQuote } from "./checks";
import { buildOutboundInstruction } from "./instruction";
import { localParts, zonedInstant } from "./time";

/** Dial's own cap, sent with every call. In the stage demo it is tighter, and a local timer backs it up. */
export const MAX_CALL_SECONDS = 120;
export const DEMO_MAX_CALL_SECONDS = 110;

/** Our status while POST /calls is in flight, before Dial has given us an id. */
const PLACING = "Placing";
/** POST /calls got no definite answer and the list did not show the call. Not live; Dial's list is checked again before any new call. */
const PLACEMENT_UNKNOWN = "PlacementUnknown";
const LOCAL_LIVE = [PLACING, "Queued", "Ringing", "In-Progress"];
const STATE_ORDER = [PLACING, PLACEMENT_UNKNOWN, "Queued", "Ringing", "In-Progress", "Terminated"];

export type CallRefusal = "not_found" | "booking_mismatch" | "do_not_call" | "no_phone" | "live_call" | "cannot_verify";

/** startOnboardingCall said no before dialing. Nothing was sent to Dial. */
export class CallRefusedError extends Error {
  override name = "CallRefusedError";
  constructor(readonly code: CallRefusal, message: string) {
    super(message);
  }
}

/** Dial refused the call, or we could not tell whether it was placed. Never retried automatically. */
export class CallPlacementError extends Error {
  override name = "CallPlacementError";
  constructor(readonly code: string, message: string, readonly ambiguous: boolean) {
    super(message);
  }
}

export interface CallServiceOptions {
  db: Db;
  bus?: Pick<EventBus, "publish">;
  clock?: Clock;
  /** createDialCalls(...) for real calls, createFakeDialCalls(fakeDial) for tests and DEMO_MODE=fakes. */
  calls: DialCalls;
  fromNumberId: string;
  /** The stage demo: 110-second cap plus a local stop timer. */
  demoMode: boolean;
  /** TEXT_CHANNEL: the rail record_consent is recorded for. Never "sms". */
  textChannel: TextChannel;
  /** Mining client; undefined uses ANTHROPIC_API_KEY when set, null stays deterministic. */
  anthropic?: AnthropicLike | null;
  /** Our Dial number, read out if the owner asks how to reach us. */
  callbackNumber?: string;
}

export interface CallService {
  /** OwnerChannels.startOnboardingCall: places the one onboarding call for a pending booking. */
  startOnboardingCall(input: { booking_id: string; business_id: string }): Promise<{ call_id: string }>;
  /** A Dial event envelope from the webhook, the events stream or FakeDial. Deduped by envelope id; safe to call twice. */
  handleDialEvent(envelope: unknown): Promise<{ handled: boolean; reason: string }>;
  /** The kill switch. Stops the given call, or the live one. */
  stopCall(callId?: string, requestedBy?: "kill_switch" | "duration_cap"): Promise<{ stopped: boolean; call_id: string | null; reason: string }>;
  liveCall(): Call | null;
  /** Re-emits the last call's events (payload.replayed = true) for the dashboard. timeScale 1 = original pacing, 0 = at once. */
  replayLastCall(options?: { timeScale?: number }): Promise<{ call_id: string | null; events: number }>;
  /** Resolves once every queued Dial event has been processed. */
  idle(): Promise<void>;
  /** Clears timers and unsubscribes from an in-process event source. */
  dispose(): void;
}

const isTerminal = (c: Call) => c.status === "Terminated" || c.ended_at !== null;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createCallService(options: CallServiceOptions): CallService {
  const { db, calls } = options;
  const clock = options.clock ?? systemClock;
  const emitOpts = { ...(options.bus ? { bus: options.bus } : {}), clock };
  const record = (input: EmitInput) => emit(db, input, emitOpts);
  const maxSeconds = options.demoMode ? DEMO_MAX_CALL_SECONDS : MAX_CALL_SECONDS;

  const placing = new Set<string>(); // numbers with a POST /calls in flight
  const processed = new Set<string>(); // envelope ids already handled
  const parked: Envelope[] = []; // events that arrived before POST /calls returned
  const capTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let queue: Promise<unknown> = Promise.resolve();

  const refsFor = (row: Call) => ({ call_id: row.id, business_id: row.business_id, ...(row.booking_id ? { booking_id: row.booking_id } : {}) });
  const now = () => clock.now().toISOString();

  function refuse(code: CallRefusal, message: string, refs: Record<string, string>): never {
    record({ type: "call.refused", actor: "system", refs, payload: { code }, reason: message });
    throw new CallRefusedError(code, message);
  }

  // ---- Placing the call ---------------------------------------------------------

  async function startOnboardingCall(input: { booking_id: string; business_id: string }): Promise<{ call_id: string }> {
    const refs = { booking_id: input.booking_id, business_id: input.business_id };
    const booking = getRow(db, "bookings", input.booking_id);
    const business = getBusiness(db, input.business_id);
    if (!booking || !business) return refuse("not_found", "Unknown booking or business", refs);
    if (booking.business_id !== business.id) return refuse("booking_mismatch", "The booking belongs to a different business", refs);
    const dncEvent = selectRows(db, "events", "business_id = ? AND type = 'call.do_not_call' AND confidence >= 0.9", [business.id])[0];
    if (business.do_not_call || dncEvent) return refuse("do_not_call", "The owner asked not to be called again", refs);
    const to = business.phone_e164;
    if (!to) return refuse("no_phone", "The business has no phone number", refs);

    // Non-negotiable 4: never two calls to one number. Local state first (synchronously, so two
    // concurrent requests cannot both pass), then Dial's own list.
    const localLive = selectRows(db, "calls", `to_e164 = ? AND status IN (${LOCAL_LIVE.map(() => "?").join(", ")})`, [to, ...LOCAL_LIVE]);
    if (placing.has(to) || localLive.length > 0) return refuse("live_call", "A call to this business is already live", refs);
    placing.add(to);
    try {
      let dialLive: WireCall | undefined;
      try {
        dialLive = (await calls.listCalls({ contact: to })).find((c) => isLiveState(c.status.state));
      } catch (error) {
        return refuse("cannot_verify", `Could not list Dial calls to check for a live one: ${(error as Error).message}`, refs);
      }
      if (dialLive) return refuse("live_call", "Dial shows a call to this number is already live", refs);
      return await place(booking, business.id, to);
    } finally {
      placing.delete(to);
      drainParked();
    }
  }

  async function place(booking: Booking, businessId: string, to: string): Promise<{ call_id: string }> {
    const business = getBusiness(db, businessId)!;
    const nowDate = clock.now();
    const windowStart = booking.window_start ?? nowDate.toISOString();
    const windowEnd = booking.window_end ?? new Date(nowDate.getTime() + 7 * 86_400_000).toISOString();
    const service = business.services.find((s) => s.name.toLowerCase() === booking.service.toLowerCase()) ?? business.services[0];
    const instruction = buildOutboundInstruction({
      businessName: business.display_name,
      businessId: business.id,
      service: booking.service,
      windowStartIso: windowStart,
      windowEndIso: windowEnd,
      timeZone: business.timezone,
      now: nowDate,
      ...(booking.details ? { details: booking.details } : {}),
      ...(booking.requested_by ? { customerLabel: booking.requested_by } : {}),
      calledNumber: to,
      consentChannel: options.textChannel,
      slotMinutes: service?.duration_minutes ?? 60,
      ...(options.callbackNumber ? { callbackNumber: options.callbackNumber } : {}),
    });
    const idempotencyKey = `onboard-${booking.id}`;

    // The intent is stored before the POST: the row (not yet live, so mid-call tools refuse it)
    // and the Idempotency-Key, so a crash mid-request can be reconciled from the log.
    const row = insertRow(db, "calls", {
      id: newCallId(nowDate.getTime()),
      business_id: business.id,
      booking_id: booking.id,
      dial_call_id: null,
      direction: "outbound",
      to_e164: to,
      status: PLACING,
      script_version: instruction.scriptVersion,
      started_at: null,
      ended_at: null,
      duration_seconds: null,
      end_reason: null,
      transcript: null,
      transcript_turns: null,
      mined: null,
      friction_score: null,
      created_at: now(),
      updated_at: now(),
    });
    record({
      type: "call.placing",
      actor: "system",
      refs: refsFor(row),
      payload: { idempotency_key: idempotencyKey, script_version: instruction.scriptVersion, max_call_duration_seconds: maxSeconds, instruction_chars: instruction.text.length, to_masked: maskNumber(to) },
      reason: "placing the onboarding call",
    });

    const attemptStartedAt = clock.now();
    let call: WireCall;
    try {
      call = await calls.placeCall(
        { to, fromNumberId: options.fromNumberId, outboundInstruction: instruction.text, language: "en-US", maxCallDurationSeconds: maxSeconds },
        { idempotencyKey, link: { business_id: business.id, booking_id: booking.id } },
      );
    } catch (error) {
      if (error instanceof DialApiError || error instanceof NumberNotAllowedError) {
        // A definite no: Dial guarantees no live call after a non-2xx.
        const code = error instanceof DialApiError ? (error.code ?? `http_${error.status}`) : "number_not_allowed";
        updateRow(db, "calls", row.id, { status: "Failed", end_reason: code, ended_at: now(), updated_at: now() });
        record({ type: "call.placement_failed", actor: "system", refs: refsFor(row), payload: { code, ...(error instanceof DialApiError ? { http_status: error.status } : {}) }, reason: error.message });
        throw new CallPlacementError(code, error.message, false);
      }
      // No definite answer. Never re-POST: ask Dial what happened.
      const found = await reconcile(to, attemptStartedAt);
      if (!found) {
        updateRow(db, "calls", row.id, { status: PLACEMENT_UNKNOWN, end_reason: "placement_unknown", updated_at: now() });
        record({
          type: "call.placement_unknown",
          actor: "system",
          refs: refsFor(row),
          payload: { idempotency_key: idempotencyKey },
          reason: `POST /calls got no answer (${(error as Error).message}) and Dial's list does not show the call; not retrying`,
          confidence: 0.5,
        });
        throw new CallPlacementError("placement_unknown", "Could not confirm the call was placed; check Dial before trying again", true);
      }
      call = found;
      record({ type: "call.placement_reconciled", actor: "system", refs: refsFor(row), payload: { dial_call_id: found.id }, reason: "POST /calls got no answer; Dial's list shows the call, so it is adopted, not re-placed" });
    }

    const placed = updateRow(db, "calls", row.id, { dial_call_id: call.id, status: call.status.state, updated_at: now() });
    record({
      type: "call.placed",
      actor: "system",
      refs: refsFor(placed),
      payload: { dial_call_id: call.id, max_call_duration_seconds: maxSeconds, state: call.status.state },
      reason: "outbound call queued",
    });

    if (options.demoMode) {
      // Belt and braces: Dial enforces maxCallDurationSeconds, and we stop the call ourselves too.
      const timer = setTimeout(() => {
        capTimers.delete(placed.id);
        void stopCall(placed.id, "duration_cap").catch(() => undefined);
      }, DEMO_MAX_CALL_SECONDS * 1000);
      timer.unref?.();
      capTimers.set(placed.id, timer);
    }
    return { call_id: placed.id };
  }

  /** After an ambiguous POST: the newest live or just-created call to this number that we do not already track. */
  async function reconcile(to: string, since: Date): Promise<WireCall | undefined> {
    try {
      const listed = await calls.listCalls({ contact: to, since: new Date(since.getTime() - 60_000).toISOString() });
      return listed.find(
        (c) => c.to === to && !getCallByDialId(db, c.id) && (isLiveState(c.status.state) || (c.createdAt ? Date.parse(c.createdAt) >= since.getTime() - 60_000 : false)),
      );
    } catch {
      return undefined;
    }
  }

  // ---- Dial events ----------------------------------------------------------------

  function rowForEvent(callId: string, to: string | null | undefined): Call | undefined {
    const known = getCallByDialId(db, callId);
    if (known || !to) return known;
    // A call whose POST got no answer: attach it when Dial tells us about it.
    const pending = selectRows(db, "calls", "dial_call_id IS NULL AND to_e164 = ? AND status = ?", [to, PLACEMENT_UNKNOWN], "created_at DESC")[0];
    if (!pending) return undefined;
    const attached = updateRow(db, "calls", pending.id, { dial_call_id: callId, status: "Queued", end_reason: null, updated_at: now() });
    record({ type: "call.placement_reconciled", actor: "system", refs: refsFor(attached), payload: { dial_call_id: callId }, reason: "Dial reported the call whose placement was unknown" });
    return attached;
  }

  function drainParked(): void {
    if (placing.size > 0) return;
    for (const env of parked.splice(0)) enqueue(env);
  }

  function enqueue(env: Envelope): Promise<{ handled: boolean; reason: string }> {
    const run = queue.then(() => processEnvelope(env));
    queue = run.catch(() => undefined);
    return run;
  }

  async function handleDialEvent(raw: unknown): Promise<{ handled: boolean; reason: string }> {
    const parsed = WireEnvelope.safeParse(raw);
    if (!parsed.success) return { handled: false, reason: "not a Dial event envelope" };
    if (processed.has(parsed.data.id)) return { handled: false, reason: "duplicate" };
    return enqueue(parsed.data);
  }

  async function processEnvelope(env: Envelope): Promise<{ handled: boolean; reason: string }> {
    if (processed.has(env.id)) return { handled: false, reason: "duplicate" };
    const callIdOf = (d: Record<string, unknown>) => (typeof d.callId === "string" ? d.callId : null);
    if (!["call.status_changed", "call.ended", "call.transcribed"].includes(env.type)) {
      processed.add(env.id);
      return { handled: false, reason: `ignored ${env.type}` };
    }
    const dialId = callIdOf(env.data);
    const to = typeof env.data.to === "string" ? env.data.to : null;
    const row = dialId ? rowForEvent(dialId, to) : undefined;
    if (!row) {
      if (placing.size > 0) {
        parked.push(env); // POST /calls has not returned yet; replay once it has
        return { handled: false, reason: "parked until the call is placed" };
      }
      processed.add(env.id);
      return { handled: false, reason: "unknown call" };
    }
    processed.add(env.id);
    try {
      switch (env.type) {
        case "call.status_changed":
          return onStatusChanged(row, StatusChangedData.parse(env.data));
        case "call.ended":
          return onEnded(row, CallEndedData.parse(env.data));
        default:
          CallTranscribedData.parse(env.data);
          return await onTranscribed(row);
      }
    } catch (error) {
      // Not marked processed, so Dial's retry of the same event (or the events stream) can finish the job.
      processed.delete(env.id);
      const message = (error as Error).message;
      record({ type: "call.event_failed", actor: "system", refs: refsFor(row), payload: { dial_event_id: env.id, dial_event_type: env.type }, reason: message.slice(0, 300) });
      return { handled: false, reason: `failed: ${message}` };
    }
  }

  function onStatusChanged(row: Call, data: ReturnType<typeof StatusChangedData.parse>) {
    const next = data.status.state;
    if (row.status === next) return { handled: true, reason: "status unchanged" };
    // Webhooks can arrive late or twice: never move a call backwards.
    const rank = (s: string) => STATE_ORDER.indexOf(s);
    if (row.ended_at || (rank(next) >= 0 && rank(row.status) >= 0 && rank(next) < rank(row.status))) return { handled: true, reason: "stale status" };
    const from = data.previousState ?? row.status;
    updateRow(db, "calls", row.id, {
      status: next,
      updated_at: now(),
      ...(next === "In-Progress" && !row.started_at ? { started_at: now() } : {}),
      ...(next === "Terminated" && data.terminationType ? { end_reason: data.terminationType } : {}),
    });
    record({ type: "call.status_changed", actor: "system", refs: refsFor(row), payload: { from, to: next }, reason: "Dial status update" });
    return { handled: true, reason: "status updated" };
  }

  function onEnded(row: Call, data: ReturnType<typeof CallEndedData.parse>) {
    clearCap(row.id);
    if (row.ended_at) return { handled: true, reason: "already ended" };
    updateRow(db, "calls", row.id, {
      status: "Terminated",
      ended_at: now(),
      duration_seconds: data.durationSeconds ?? null,
      end_reason: data.status,
      updated_at: now(),
    });
    record({
      type: "call.ended",
      actor: "system",
      refs: refsFor(row),
      payload: { duration_seconds: data.durationSeconds ?? null, status: data.status, canceled: data.canceled ?? false },
      reason: "Dial reported the call ended",
    });
    return { handled: true, reason: "call ended" };
  }

  async function onTranscribed(row: Call) {
    if (row.transcript_turns) return { handled: true, reason: "already transcribed" };
    const call = await calls.getCall(row.dial_call_id!);
    const turns: TranscriptTurn[] = (call.transcriptTurns ?? []).map((t) => ({
      speaker: t.speaker === "agent" || t.speaker === "user" ? t.speaker : "transfer_target",
      text: t.text,
      startMs: t.startMs,
      endMs: t.endMs,
    }));
    const updated = updateRow(db, "calls", row.id, { transcript: call.transcript ?? null, transcript_turns: turns, updated_at: now() });
    record({ type: "call.transcribed", actor: "system", refs: refsFor(updated), payload: { turns }, reason: "transcript available" });
    await afterCall(updated, turns);
    return { handled: true, reason: "transcribed and mined" };
  }

  // ---- After the call: checks and mining ---------------------------------------------

  async function afterCall(row: Call, turns: TranscriptTurn[]): Promise<void> {
    const refs = refsFor(row);
    const business = getBusiness(db, row.business_id)!;
    const booking = row.booking_id ? getRow(db, "bookings", row.booking_id) : undefined;

    // 1. Non-negotiable 2, verified.
    const disclosure = checkDisclosure(turns);
    record({
      type: disclosure.ok ? "call.disclosure_verified" : "call.disclosure_missing",
      actor: "system",
      refs,
      payload: { ok: disclosure.ok, similarity: disclosure.similarity, first_agent_words: disclosure.first_agent_words },
      reason: disclosure.ok ? "the agent's first words were the disclosure" : "the agent's first words did not start with the disclosure",
      // A near miss is more likely a transcription slip than a skipped disclosure.
      confidence: disclosure.ok || disclosure.similarity < 0.8 ? 1 : 0.6,
    });

    // 2. Mining. Findings are evidence with a confidence; never a confirmation.
    const mined = await mineTranscript(turns, {
      ...(options.anthropic !== undefined ? { anthropic: options.anthropic } : {}),
      ...(booking?.window_start && booking.window_end ? { window: { startIso: booking.window_start, endIso: booking.window_end, timeZone: business.timezone } } : {}),
    });
    updateRow(db, "calls", row.id, { mined: { findings: mined.findings, friction: mined.friction, claude: mined.claude }, friction_score: mined.friction.score, updated_at: now() });
    for (const f of mined.findings) {
      record({
        type: "transcript.mined",
        actor: "system",
        refs,
        payload: { kind: f.kind, value: f.value, quote: f.quote, turn_index: f.turnIndex, method: f.method },
        reason: `the owner said it on the call (${f.method})`,
        confidence: f.confidence,
      });
    }
    record({
      type: "call.friction_scored",
      actor: "system",
      refs,
      payload: { score: mined.friction.score, median_owner_reply_ms: mined.friction.median_owner_reply_ms, max_pause_ms: mined.friction.maxPauseMs, overlaps: mined.friction.overlaps, clarifications: mined.friction.clarification_requests },
      reason: "how smooth the call was",
    });

    const dnc = mined.findings.find((f) => f.kind === "do_not_call" && f.confidence >= 0.9);
    if (dnc) {
      record({
        type: "call.do_not_call",
        actor: "system",
        refs: { business_id: row.business_id, call_id: row.id },
        payload: { quote: dnc.quote, turn_index: dnc.turnIndex },
        reason: "the owner asked not to be called again; no onboarding call will be placed to this business",
        confidence: dnc.confidence,
      });
    }

    // 3. Quotes the tools stored must match what the owner said.
    for (const q of storedQuotes(row, booking)) {
      const check = verifyQuote(q.quote, turns);
      record({
        type: check.verified ? "evidence.quote_verified" : "evidence.quote_unverified",
        actor: "system",
        refs: { ...refs, ...(q.consent_id ? { consent_id: q.consent_id } : {}) },
        payload: { tool: q.tool, quote: q.quote, similarity: check.similarity, turn_index: check.turn_index },
        reason: check.verified ? `${q.tool} quote matches the owner's words` : `${q.tool} quote does not match anything the owner said`,
        confidence: check.verified ? check.similarity : 1 - check.similarity,
      });
    }

    const toolBooked = createBookingSucceeded(row, booking);
    const prices = mined.findings.filter((f) => f.kind === "price").sort((a, b) => b.confidence - a.confidence);
    // 4. The price the tool booked must be a price the owner said.
    if (booking && toolBooked && booking.price_cents !== null && prices.length > 0 && !prices.some((p) => p.value === booking.price_cents)) {
      const top = prices[0]!;
      record({
        type: "booking.price_mismatch",
        actor: "system",
        refs,
        payload: { tool_price_cents: booking.price_cents, mined_price_cents: top.value, quote: top.quote, turn_index: top.turnIndex },
        reason: "create_booking used a price the owner did not say",
        confidence: top.confidence,
      });
    }

    // 5. Tools missed but the owner agreed on the call: a candidate, never a confirmation.
    if (booking && !toolBooked) transcriptCandidate(row, booking, business.timezone, business.services, turns, mined.findings);
  }

  function storedQuotes(row: Call, booking: Booking | undefined): { tool: "create_booking" | "record_consent"; quote: string; consent_id?: string }[] {
    const out: { tool: "create_booking" | "record_consent"; quote: string; consent_id?: string }[] = [];
    const ev = booking?.confirmation_evidence;
    if (ev && ev.kind === "call" && (ev.callId === row.id || ev.callId === row.dial_call_id)) out.push({ tool: "create_booking", quote: ev.quotedSentence });
    for (const c of selectRows(db, "consents", "call_id = ?", [row.id])) {
      if (c.quoted_sentence) out.push({ tool: "record_consent", quote: c.quoted_sentence, consent_id: c.id });
    }
    // Tool logs that carry their input (the real Context MCP logs it) cover anything not in the tables.
    for (const e of selectRows(db, "events", "call_id = ? AND type = 'voice.tool_called'", [row.id]).map(rowToEvent)) {
      const input = e.payload.input as Record<string, unknown> | undefined;
      const tool = e.payload.tool;
      const quote = tool === "create_booking" ? input?.verbal_confirmation : tool === "record_consent" ? input?.quote : undefined;
      if (typeof quote === "string" && (tool === "create_booking" || tool === "record_consent") && !out.some((o) => o.tool === tool && o.quote === quote)) {
        out.push({ tool, quote });
      }
    }
    return out;
  }

  function createBookingSucceeded(row: Call, booking: Booking | undefined): boolean {
    const ev = booking?.confirmation_evidence;
    if (ev && ev.kind === "call" && (ev.callId === row.id || ev.callId === row.dial_call_id)) return true;
    return selectRows(db, "events", "call_id = ? AND type = 'voice.tool_called'", [row.id])
      .map(rowToEvent)
      .some((e) => e.payload.tool === "create_booking" && e.payload.ok === true);
  }

  /**
   * The fallback when the mid-call tools did not fire: the transcript shows a
   * price, a time and the owner's yes, so the dashboard can show the booking
   * "from transcript". It stays pending. Non-negotiable 1: a transcript is not
   * the owner's confirmation, so confirming it takes a Y by text (the text side
   * asks when consent was captured on the call).
   */
  function transcriptCandidate(row: Call, booking: Booking, timeZone: string, services: { name: string; duration_minutes: number }[], turns: TranscriptTurn[], findings: Finding[]): void {
    if (!["pending", "quote_pending", "quoted", "countered"].includes(booking.status)) return;
    const best = (kind: Finding["kind"]) => findings.filter((f) => f.kind === kind).sort((a, b) => b.confidence - a.confidence)[0];
    const price = best("price");
    const time = best("slot_time");
    const agreement = findBookingAgreement(turns);
    if (!price || !time || !agreement) return;
    const [h, m] = String(time.value).split(":").map(Number) as [number, number];
    const date = localParts(new Date(booking.window_start ?? row.created_at), timeZone).date;
    const start = zonedInstant(date, h, m, timeZone);
    const minutes = services.find((s) => s.name.toLowerCase() === booking.service.toLowerCase())?.duration_minutes ?? 60;
    const consent = best("consent_sentence");
    record({
      type: "booking.transcript_candidate",
      actor: "system",
      refs: refsFor(row),
      payload: {
        source: "transcript",
        price_cents: price.value,
        slot_start: start.toISOString(),
        slot_end: new Date(start.getTime() + minutes * 60_000).toISOString(),
        slot_time: time.value,
        quotes: { price: price.quote, time: time.quote, agreement: agreement.quote },
        turn_indexes: { price: price.turnIndex, time: time.turnIndex, agreement: agreement.turnIndex },
        consent: consent?.value ?? null,
        status: booking.status,
        next_step: "needs the owner's Y by text before it can be confirmed",
      },
      reason: "the owner agreed on the call but create_booking never ran; not confirmed",
      confidence: Math.round(Math.min(price.confidence, time.confidence, 0.9) * 0.9 * 100) / 100,
    });
  }

  // ---- Kill switch, live call, replay ---------------------------------------------

  function clearCap(callId: string): void {
    const t = capTimers.get(callId);
    if (t) clearTimeout(t);
    capTimers.delete(callId);
  }

  function liveCall(): Call | null {
    return selectRows(db, "calls", "status IN ('Queued', 'Ringing', 'In-Progress') AND ended_at IS NULL", [], "created_at DESC")[0] ?? null;
  }

  async function stopCall(callId?: string, requestedBy: "kill_switch" | "duration_cap" = "kill_switch") {
    const row = callId ? (getRow(db, "calls", callId) ?? getCallByDialId(db, callId)) : (liveCall() ?? undefined);
    if (!row || !row.dial_call_id) return { stopped: false, call_id: row?.id ?? null, reason: "no live call" };
    if (isTerminal(row)) return { stopped: false, call_id: row.id, reason: "the call already ended" };
    let result;
    try {
      result = await calls.stopCall(row.dial_call_id);
    } catch (error) {
      if (error instanceof DialApiError && error.status === 400) return { stopped: false, call_id: row.id, reason: "the call already ended" };
      // Stopping is safe to repeat (Dial: 502 means retry), so the kill switch tries once more.
      if (!(error instanceof DialNetworkError || (error instanceof DialApiError && error.status >= 500))) throw error;
      result = await calls.stopCall(row.dial_call_id);
    }
    if (requestedBy === "kill_switch") clearCap(row.id);
    record({
      type: "call.stop_requested",
      actor: "system",
      refs: refsFor(row),
      payload: { dial_call_id: row.dial_call_id, requested_by: requestedBy, cancel_pending: result.cancelPending },
      reason: requestedBy === "duration_cap" ? `the call reached the ${DEMO_MAX_CALL_SECONDS}-second demo cap` : "kill switch",
    });
    return { stopped: true, call_id: row.id, reason: requestedBy };
  }

  async function replayLastCall({ timeScale = 0 }: { timeScale?: number } = {}) {
    const last = selectRows(db, "calls", "1 = 1", [], "created_at DESC")[0];
    if (!last) return { call_id: null, events: 0 };
    const events = selectRows(db, "events", "call_id = ?", [last.id], "id")
      .map(rowToEvent)
      .filter((e) => e.payload.replayed !== true);
    let previous: number | null = null;
    for (const e of events) {
      const at = Date.parse(e.created_at);
      if (timeScale > 0 && previous !== null) await sleep(Math.min(10_000, Math.max(0, at - previous)) * timeScale);
      previous = at;
      record({
        type: e.type,
        actor: e.actor,
        refs: e.refs,
        payload: { ...e.payload, replayed: true },
        ...(e.reason ? { reason: e.reason } : {}),
        confidence: e.confidence,
      });
    }
    return { call_id: last.id, events: events.length };
  }

  const unsubscribe = calls.on?.((envelope) => void handleDialEvent(envelope));

  return {
    startOnboardingCall,
    handleDialEvent,
    stopCall,
    liveCall,
    replayLastCall,
    idle: async () => {
      // Events can enqueue more work (parked events); wait until the queue stops growing.
      let seen: Promise<unknown> | null = null;
      while (seen !== queue) {
        seen = queue;
        await queue;
      }
    },
    dispose: () => {
      unsubscribe?.();
      for (const t of capTimers.values()) clearTimeout(t);
      capTimers.clear();
    },
  };
}
