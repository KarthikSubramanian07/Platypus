import { Hono } from "hono";
import { createBooking, placeHold, type BookingContext } from "@platypus/shared/booking";
import type { TextChannel } from "@platypus/shared/config";
import { DEMO_SHOP_SLUG, getBusinessBySlug, getRow, insertRow, openDb, seed, updateRow, type Booking, type Business, type Db } from "@platypus/shared/db";
import { EventBus, listEvents, type PlatypusEvent } from "@platypus/shared/events";
import { FakeDial } from "@platypus/shared/testing";
import { createFakeDialMessaging, type FakeDialMessagingOptions } from "./dial-messaging";
import { createTextService, type TextService, type TextServiceDeps } from "./index";
import type { ReplyModel } from "./model";
import { signDialPayload } from "./webhook";

/** Test scaffolding: an in-memory database seeded like the demo, FakeDial, and a signed-webhook helper. Not exported from the package. */

export const WEBHOOK_SECRET = "whsec_test_platypus";
export const OUR_NUMBER = "+15550100000";
/** Tue Oct 13 2026, 10am Pacific: the golden-path slot. */
export const TUE_10AM = "2026-10-13T17:00:00.000Z";

export interface TestClock {
  now(): Date;
  advance(ms: number): void;
}

export function testClock(start = "2026-10-11T19:00:00.000Z"): TestClock {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (ms) => void (t += ms) };
}

export interface Harness {
  db: Db;
  clock: TestClock;
  bus: EventBus;
  fake: FakeDial;
  messaging: ReturnType<typeof createFakeDialMessaging>;
  service: TextService;
  app: Hono;
  sal: Business;
  ctx: BookingContext;
  booking: Booking;
  newBooking(service?: string, slot?: string): Booking;
  post(envelope: object, options?: { secret?: string; timestamp?: number; eventId?: string }): Promise<Response>;
  inbound(body: string, extra?: Record<string, unknown>): object;
  events(type?: string): PlatypusEvent[];
  outbox(): { to: string; body: string; channel: string }[];
}

export interface HarnessOptions {
  textChannel?: TextChannel;
  consent?: boolean;
  dialNumbers?: string[];
  allowedNumbers?: string[];
  lookup?: FakeDialMessagingOptions["lookup"];
  model?: ReplyModel | null;
  textNumber?: string | null;
  overrides?: Partial<TextServiceDeps>;
}

let eventSeq = 0;

export function harness(options: HarnessOptions = {}): Harness {
  const clock = testClock();
  const bus = new EventBus();
  const db = openDb(":memory:");
  seed(db, { clock });
  let sal = getBusinessBySlug(db, DEMO_SHOP_SLUG)!;
  const ctx: BookingContext = { db, bus, clock };
  const textChannel = options.textChannel ?? "imessage";

  if (options.consent !== false) {
    const iso = clock.now().toISOString();
    insertRow(db, "calls", {
      id: "call_test",
      business_id: sal.id,
      booking_id: null,
      dial_call_id: "call_dial_test",
      direction: "outbound",
      to_e164: sal.phone_e164,
      status: "Terminated",
      script_version: "golden-v1",
      started_at: iso,
      ended_at: iso,
      duration_seconds: 49,
      end_reason: "completed",
      transcript: null,
      transcript_turns: null,
      mined: null,
      friction_score: null,
      created_at: iso,
      updated_at: iso,
    });
    insertRow(db, "consents", {
      id: "cns_test",
      business_id: sal.id,
      channel: textChannel,
      source: "call",
      quoted_sentence: "Yeah, text me.",
      call_id: "call_test",
      transcript_turn_ref: null,
      message_id: null,
      created_at: iso,
      revoked_at: null,
      revoked_reason: null,
    });
    sal = updateRow(db, "businesses", sal.id, {
      channel_state: "text_enabled",
      channel_pref: textChannel,
      text_number_e164: options.textNumber === undefined ? sal.phone_e164 : options.textNumber,
      updated_at: iso,
    });
  }

  const allowed = options.allowedNumbers ?? [sal.phone_e164];
  const fake = new FakeDial({ allowedNumbers: allowed, clock, fromNumber: OUR_NUMBER, dialNumbers: options.dialNumbers ?? [], timeScale: 0 });
  const messaging = createFakeDialMessaging(fake, options.lookup ? { lookup: options.lookup } : {});
  const service = createTextService({
    db,
    bus,
    clock,
    messaging,
    textChannel,
    allowedNumbers: allowed,
    dialNumbers: options.dialNumbers ?? [],
    ourNumber: OUR_NUMBER,
    model: options.model ?? null,
    webhookSecret: WEBHOOK_SECRET,
    onError: (e) => {
      throw e;
    },
    ...options.overrides,
  });
  const app = new Hono();
  service.routes(app);

  const newBooking = (service = "brake inspection", slot = TUE_10AM): Booking => {
    const b = createBooking(ctx, {
      business_id: sal.id,
      agent_id: "claude-desktop",
      service,
      route: "text",
      window_start: slot,
      window_end: new Date(new Date(slot).getTime() + 2 * 86_400_000).toISOString(),
      details: "2019 Civic",
      requested_by: "Alex's assistant",
    });
    placeHold(ctx, { business_id: sal.id, slot_start: slot, slot_end: new Date(new Date(slot).getTime() + 30 * 60_000).toISOString(), booking_id: b.id, created_by: "system" });
    return getBusinessBooking(db, b.id);
  };

  return {
    db,
    clock,
    bus,
    fake,
    messaging,
    service,
    app,
    get sal() {
      return getBusinessBySlug(db, DEMO_SHOP_SLUG)!;
    },
    ctx,
    booking: newBooking(),
    newBooking,
    async post(envelope, opts = {}) {
      const raw = JSON.stringify(envelope);
      const t = opts.timestamp ?? Math.floor(clock.now().getTime() / 1000);
      const sig = signDialPayload(opts.secret ?? WEBHOOK_SECRET, t, raw);
      return app.request("/webhooks/dial", {
        method: "POST",
        body: raw,
        headers: {
          "content-type": "application/json",
          "x-dial-signature": `t=${t},v1=${sig}`,
          "x-dial-event-id": opts.eventId ?? (envelope as { id: string }).id,
          "x-dial-event-type": (envelope as { type: string }).type,
        },
      });
    },
    inbound(body, extra = {}) {
      eventSeq += 1;
      return {
        id: `evt_in_${eventSeq}`,
        object: "event",
        type: "message.received",
        version: 1,
        createdAt: clock.now().toISOString(),
        relatedObject: { id: `msg_in_${eventSeq}`, type: "message", url: null },
        data: { messageId: `msg_in_${eventSeq}`, from: sal.phone_e164, to: OUR_NUMBER, channel: "imessage", body, media: [], replyToId: null, reaction: null, source: "external", ...extra },
      };
    },
    events: (type) => listEvents(db, type ? { type } : {}),
    outbox: () => fake.messages.filter((m) => m.direction === "outbound").map((m) => ({ to: m.to, body: m.body, channel: m.channel })),
  };
}

function getBusinessBooking(db: Db, id: string): Booking {
  return getRow(db, "bookings", id)!;
}
