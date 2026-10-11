import { confirm, createBooking, getBooking, placeHold, type BookingContext } from "../booking/index";
import { systemClock } from "../clock";
import type { TextChannel } from "../config";
import { getBusinessByNumber, getBusinessBySlug, insertRow, type Db } from "../db/repo";
import { DEMO_SHOP_SLUG, seed } from "../db/seed";
import type { Booking } from "../db/types";
import { emitSeedEvents } from "../events/seed-events";
import { emit } from "../events/log";
import type { EventBus } from "../events/bus";
import { newId } from "../ids";
import { loadDarwinRecording } from "./fake-darwin";
import { FakeDial } from "./fake-dial";
import { createFakeGateway } from "./fake-gateway";
import { addMinutes, localDate, zonedTime } from "./time";

export interface GoldenPathOptions {
  db: Db;
  bus?: Pick<EventBus, "publish">;
  clock?: BookingContext["clock"];
  /** FakeDial refuses everything else. Defaults to the auto shop's fictional seed number. */
  allowedNumbers?: string[];
  timeScale?: number;
  textChannel?: TextChannel;
}

export interface GoldenPathResult {
  first: Booking;
  second: Booking;
  dial: FakeDial;
}

/**
 * The whole demo, end to end, against the fakes: an agent asks, Darwin is
 * consulted, Sal's Auto is called, books through the mid-call tools and says
 * yes to texts; the second request goes by text and the owner's Y confirms it.
 *
 * The gateway and text steps here are stand-ins written for the fixture, not
 * the real packages: they show the event sequence those packages must produce.
 */
export async function runGoldenPath(options: GoldenPathOptions): Promise<GoldenPathResult> {
  const { db } = options;
  const clock = options.clock ?? systemClock;
  const ctx: BookingContext = { db, clock, ...(options.bus ? { bus: options.bus } : {}) };
  const emitOpts = { clock, ...(options.bus ? { bus: options.bus } : {}) };
  const textChannel = options.textChannel ?? "imessage";

  seed(db, { allowedNumbers: [], clock, onSeeded: emitSeedEvents(db, emitOpts) });
  const sal = getBusinessBySlug(db, DEMO_SHOP_SLUG)!;
  const allowed = options.allowedNumbers ?? [sal.phone_e164];
  const tz = sal.timezone;
  const now = clock.now();
  const tomorrow = localDate(now, tz, 1);

  // 1. The customer's agent asks.
  emit(db, {
    type: "agent.tool_called",
    actor: "agent",
    payload: { tool: "search_providers", agent_id: "claude-desktop", service: "oil change", location: "1025 Sansome St, San Francisco", budget_cents: 12000, window: { start: zonedTime(tomorrow, 12, 0, tz).toISOString(), end: zonedTime(tomorrow, 17, 0, tz).toISOString() } },
    reason: "Get me an oil change tomorrow afternoon, under $120, near 1025 Sansome.",
  }, emitOpts);

  // 2. Darwin, exactly as the gateway's lookup runs it, from real recordings only (never a simulated
  // no_match): the demo phrasing returned HTTP 500, so the lookup fell back to the bare trade, which
  // answered with one agent that is not ready to book. That is the beat: Darwin has no ready agent.
  const failed = loadDarwinRecording("error_500");
  const answered = loadDarwinRecording("auto_repair");
  const darwinBody = answered.body as { searchId: string; status: string; response: { agents: Array<{ agentId: string; name: string; readiness: string; canStartThread: boolean }> } };
  const request = (r: unknown) => (r as { request: { query: string } }).request.query;
  emit(db, {
    type: "darwin.searched",
    actor: "system",
    payload: {
      status: darwinBody.status,
      http_status: answered.status,
      provenance: "recorded",
      recorded_at: answered._provenance.recorded_at,
      latency_ms: Number(failed._provenance.latency_ms) + Number(answered._provenance.latency_ms),
      query: request(answered),
      search_id: darwinBody.searchId,
      outcome: "listed_only",
      candidate_agent_id: null,
      agents: darwinBody.response.agents.map((a) => ({ agent_id: a.agentId, name: a.name, readiness: a.readiness, can_start_thread: a.canStartThread })),
      attempts: [
        { query: request(failed), withContext: true, ok: false, status: failed.status, requestId: failed._provenance.x_request_id },
        { query: request(answered), withContext: false, ok: true, status: answered.status, requestId: answered._provenance.x_request_id },
      ],
    },
    reason: "Darwin Search v3 consulted before any call",
  }, emitOpts);

  // 3. Routing signals: no history yet, so nothing is claimed.
  emit(db, { type: "signals.computed", actor: "system", refs: { business_id: sal.id }, payload: { source: "local", signals: {}, note: "no history yet" }, reason: "routing signals for the candidate" }, emitOpts);

  // 4. request_booking: no agent, no consent, so we call.
  const first = createBooking(ctx, {
    business_id: sal.id,
    agent_id: "claude-desktop",
    service: "oil change",
    route: "call",
    window_start: zonedTime(tomorrow, 12, 0, tz).toISOString(),
    window_end: zonedTime(tomorrow, 17, 0, tz).toISOString(),
    details: "2019 Honda Civic",
    requested_by: "Alex's assistant",
    routing_reasons: ["Darwin returned no ready agent", "no text consent on record"],
  });

  // 5. The call, with mid-call tools booking through the real state machine.
  const gateway = createFakeGateway({ ...ctx, textChannel });
  const dial = new FakeDial({
    allowedNumbers: allowed,
    voiceTools: gateway,
    db,
    clock,
    ...(options.bus ? { bus: options.bus } : {}),
    timeScale: options.timeScale ?? 1,
    autoReply: { body: "Y", afterMs: 4_000 },
  });

  // Stand-in for the text package: record inbound, classify Y deterministically, confirm with text evidence.
  let second: Booking | undefined;
  dial.on((event) => {
    if (event.type !== "message.received") return;
    const business = getBusinessByNumber(db, event.data.from);
    if (!business || !second) return;
    const message = insertRow(db, "messages", {
      id: newId("message", clock.now().getTime()),
      business_id: business.id,
      booking_id: second.id,
      direction: "inbound",
      channel: textChannel,
      from_e164: event.data.from,
      to_e164: event.data.to ?? "",
      body: event.data.body,
      provider_message_id: event.data.messageId,
      status: "received",
      reply_class: "accept",
      classification: { class: "accept", confidence: 1 },
      created_at: clock.now().toISOString(),
    });
    emit(db, { type: "message.received", actor: "owner", refs: { message_id: message.id, business_id: business.id, booking_id: second.id }, payload: { channel: textChannel, body: event.data.body }, reason: "owner replied" }, emitOpts);
    emit(db, { type: "reply.classified", actor: "system", refs: { message_id: message.id, booking_id: second.id }, payload: { class: "accept", method: "deterministic" }, reason: "exact match: Y", confidence: 1 }, emitOpts);
    second = confirm(ctx, second.id, { kind: "text", messageId: message.id });
  });

  await dial.placeCall(
    { to: sal.phone_e164, fromNumberId: "num_fake", outboundInstruction: "golden-path script", language: "en-US", maxCallDurationSeconds: 120 },
    { business_id: sal.id, booking_id: first.id },
  );
  await dial.settle();

  // 6. The agent polls and gets structured truth.
  emit(db, { type: "agent.tool_called", actor: "agent", refs: { booking_id: first.id }, payload: { tool: "get_booking", status: getBooking(ctx, first.id).status }, reason: "agent polled the booking" }, emitOpts);

  // 7. Second request: consent exists, so the route is text. No call.
  const tuesday = nextWeekday(now, tz, 2);
  const tue10 = zonedTime(tuesday, 10, 0, tz);
  second = createBooking(ctx, {
    business_id: sal.id,
    agent_id: "claude-desktop",
    service: "brake inspection",
    route: "text",
    window_start: tue10.toISOString(),
    window_end: zonedTime(nextWeekday(now, tz, 4), 17, 0, tz).toISOString(),
    details: "2019 Honda Civic",
    requested_by: "Alex's assistant",
    routing_reasons: [`consent recorded on the call (${textChannel})`],
  });
  placeHold(ctx, { business_id: sal.id, slot_start: tue10.toISOString(), slot_end: addMinutes(tue10, 30).toISOString(), booking_id: second.id, created_by: "system" });

  const body = "New job via Platypus (AI-assisted): brake inspection, Tue 10am, 2019 Civic. From Alex's assistant. Reply Y, N, or a time.";
  const salNow = getBusinessBySlug(db, DEMO_SHOP_SLUG)!;
  const to = salNow.text_number_e164 ?? salNow.phone_e164;
  const { message: sent } = await dial.sendMessage({ to, body, channel: textChannel === "dial" ? "sms" : textChannel });
  const outbound = insertRow(db, "messages", {
    id: newId("message", clock.now().getTime()),
    business_id: sal.id,
    booking_id: second.id,
    direction: "outbound",
    channel: textChannel,
    from_e164: sent.from,
    to_e164: to,
    body,
    provider_message_id: sent.id,
    status: "sent",
    reply_class: null,
    classification: null,
    created_at: clock.now().toISOString(),
  });
  emit(db, { type: "message.sent", actor: "system", refs: { message_id: outbound.id, business_id: sal.id, booking_id: second.id }, payload: { channel: textChannel, body }, reason: "owner opted in to texts" }, emitOpts);
  await dial.settle();

  emit(db, { type: "agent.tool_called", actor: "agent", refs: { booking_id: second.id }, payload: { tool: "get_booking", status: getBooking(ctx, second.id).status }, reason: "agent polled the booking" }, emitOpts);

  return { first: getBooking(ctx, first.id), second: getBooking(ctx, second.id), dial };
}

/** The local date of the given weekday (1 = Monday ... 7 = Sunday) in the calendar week after the one containing `at`. */
function nextWeekday(at: Date, tz: string, weekday: number): string {
  const isoDay = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  const daysLeftThisWeek = 7 - isoDay(localDate(at, tz));
  for (let d = daysLeftThisWeek + 1; d <= daysLeftThisWeek + 7; d++) {
    const date = localDate(at, tz, d);
    if (isoDay(date) === weekday) return date;
  }
  return localDate(at, tz, 7);
}
