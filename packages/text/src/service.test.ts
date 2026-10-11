import { describe, expect, it, vi } from "vitest";
import { getActiveConsent, getRow, selectRows } from "@platypus/shared/db";
import { NumberNotAllowedError } from "@platypus/shared/safety";
import { HELP_COPY, RESUME_COPY, STOP_COPY } from "./copy";
import { createEventsConsumer } from "./events-consumer";
import type { ReplyModel } from "./model";
import { OwnerRateLimitedError, RoutingUnavailableError } from "./outbound";
import { LookupUnavailableError, SendOutcomeUnknownError } from "./dial-messaging";
import { harness, OUR_NUMBER } from "./test-helpers";
import { MAX_WEBHOOK_BYTES, verifyDialSignature } from "./webhook";

const GOLDEN_COPY = "New job via Platypus (AI-assisted): brake inspection, Tue 10am, 2019 Civic. From Alex's assistant. Reply Y, N, or a time.";

const throwingModel = (): ReplyModel => ({
  name: "throws",
  classify: vi.fn(async () => {
    throw new Error("the model must not be called");
  }),
});

describe("the text golden path", () => {
  it("texts the request, and a signed Y by webhook confirms with text evidence", async () => {
    const h = harness();
    const sent = await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    expect(sent).toHaveProperty("message_id");
    expect(h.outbox()).toEqual([{ to: h.sal.phone_e164, body: GOLDEN_COPY, channel: "imessage" }]);

    const lookup = h.events("routing.lookup")[0]!;
    expect(lookup.payload).toMatchObject({ supports: { imessage: true, whatsapp: false } });
    expect(JSON.stringify(lookup.payload)).not.toContain(h.sal.phone_e164);
    expect(h.events("message.sent")[0]!.payload).toMatchObject({ channel: "imessage", body: GOLDEN_COPY });

    const res = await h.post(h.inbound("Y"));
    expect(res.status).toBe(200);
    await h.service.drain();

    const booking = getRow(h.db, "bookings", h.booking.id)!;
    expect(booking.status).toBe("confirmed");
    const inbound = selectRows(h.db, "messages", "direction = 'inbound'")[0]!;
    expect(booking.confirmation_evidence).toEqual({ kind: "text", messageId: inbound.id });
    expect(inbound.reply_class).toBe("accept");

    const types = h.events().map((e) => e.type).filter((t) => t.startsWith("message.") || t.startsWith("reply.") || t === "booking.confirmed");
    expect(types).toEqual(["message.sent", "message.received", "reply.classified", "booking.confirmed", "message.sent"]);
    expect(h.events("reply.classified")[0]!.payload).toMatchObject({ class: "accept", method: "deterministic" });
    expect(h.outbox().at(-1)!.body).toBe(`Booked: brake inspection, Tue 10am. Ref ${booking.short_code}. Reply UNDO to reverse it.`);
  });

  it("acknowledges in well under 200ms even when the reply needs a slow model", async () => {
    const slow: ReplyModel = { name: "slow", classify: () => new Promise((r) => setTimeout(() => r({ class: "question", confidence: 0.9, extracted: { time: null, price_cents: null }, ambiguity: null, clarifying_question: null }), 400)) };
    const h = harness({ model: slow });
    await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    const started = performance.now();
    const res = await h.post(h.inbound("hmm what is this about"));
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(200);
    expect(h.events("reply.classified")).toHaveLength(0);
    await h.service.drain();
    expect(h.events("reply.classified")).toHaveLength(1);
  });

  it("processes a message once across webhook retries, the events stream and a second process", async () => {
    const h = harness();
    await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    const envelope = h.inbound("Y");
    expect((await h.post(envelope)).status).toBe(200);
    expect((await h.post(envelope)).status).toBe(200);

    let served = false;
    const fetch = vi.fn(async () => {
      if (!served) {
        served = true;
        return new Response(JSON.stringify({ event: envelope }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "timeout" }), { status: 408 });
    }) as unknown as typeof globalThis.fetch;
    const consumer = createEventsConsumer({ apiKey: "dial_test", fetch, ingest: h.service.ingest, timeoutSeconds: 1 });
    consumer.start();
    await vi.waitFor(() => expect(served).toBe(true));
    await consumer.stop();
    await h.service.drain();

    // A second process has no memory of the first: the UNIQUE provider id is the real guarantee.
    const data = (envelope as { data: { messageId: string; from: string; body: string } }).data;
    const again = await h.service.handleInbound({ provider_message_id: data.messageId, from: data.from, to: OUR_NUMBER, channel: "imessage", body: data.body, received_at: h.clock.now().toISOString() });
    expect(again).toEqual({ status: "duplicate" });

    expect(selectRows(h.db, "messages", "direction = 'inbound'")).toHaveLength(1);
    expect(h.events("booking.confirmed")).toHaveLength(1);
    expect(h.events("reply.classified")).toHaveLength(1);
  });

  it("rejects bad, stale and missing signatures, and refuses everything without a secret", async () => {
    const h = harness();
    expect((await h.post(h.inbound("Y"), { secret: "whsec_wrong" })).status).toBe(401);
    expect((await h.post(h.inbound("Y"), { timestamp: Math.floor(h.clock.now().getTime() / 1000) - 301 })).status).toBe(401);
    const unsigned = await h.app.request("/webhooks/dial", { method: "POST", body: JSON.stringify(h.inbound("Y")) });
    expect(unsigned.status).toBe(401);
    await h.service.drain();
    expect(selectRows(h.db, "messages", "direction = 'inbound'")).toHaveLength(0);

    const open = harness({ overrides: { webhookSecret: undefined } });
    expect((await open.post(open.inbound("Y"))).status).toBe(503);
  });

  it("dedupes a replayed signed event even when the unsigned event-id header changes", async () => {
    const seen: string[] = [];
    const h = harness({ overrides: { onDialEvent: (e) => void seen.push(e.id) } });
    const ended = { id: "evt_end_1", object: "event", type: "call.ended", version: 1, createdAt: h.clock.now().toISOString(), relatedObject: null, data: { callId: "call_1" } };
    expect((await h.post(ended)).status).toBe(200);
    expect((await h.post(ended, { eventId: "evt_forged_fresh_id" })).status).toBe(200);
    await h.service.drain();
    expect(seen).toEqual(["evt_end_1"]);
  });

  it("refuses an oversized body before reading it", async () => {
    const h = harness();
    const huge = "x".repeat(MAX_WEBHOOK_BYTES + 1);
    const res = await h.app.request("/webhooks/dial", { method: "POST", body: huge, headers: { "content-type": "application/json", "content-length": String(huge.length) } });
    expect(res.status).toBe(413);
  });

  it("matches Dial's published signature test vector (the whole whsec_ string is the key)", () => {
    const raw = '{"id":"evt_test","object":"event","type":"webhook.ping","version":1,"createdAt":"2026-10-11T19:00:00.000Z","relatedObject":null,"data":{}}';
    const header = "t=1791734400,v1=601c6219a3d515887714353fb9cc075989e76bb0bac62b250e2af71a64ae6bdb";
    expect(verifyDialSignature("whsec_test_0123456789abcdef", header, raw, 1791734400)).toEqual({ ok: true });
    expect(verifyDialSignature("test_0123456789abcdef", header, raw, 1791734400)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("acknowledges other event types and hands them to onDialEvent", async () => {
    const seen: string[] = [];
    const h = harness({ overrides: { onDialEvent: (e) => void seen.push(e.type) } });
    const ping = { id: "evt_ping", object: "event", type: "webhook.ping", version: 1, createdAt: h.clock.now().toISOString(), relatedObject: null, data: {} };
    const ended = { id: "evt_end", object: "event", type: "call.ended", version: 1, createdAt: h.clock.now().toISOString(), relatedObject: null, data: { callId: "call_1" } };
    expect((await h.post(ping)).status).toBe(200);
    expect((await h.post(ended)).status).toBe(200);
    await h.service.drain();
    expect(seen).toEqual(["webhook.ping", "call.ended"]);
  });
});

describe("keywords by text", () => {
  it("STOP unlists the business, revokes consent, confirms once, never calls the model, and blocks later sends", async () => {
    const model = throwingModel();
    const h = harness({ model });
    await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    await h.post(h.inbound("STOP"));
    await h.post(h.inbound("stop"));
    await h.service.drain();

    expect(model.classify).not.toHaveBeenCalled();
    expect(h.sal.channel_state).toBe("unlisted");
    expect(getActiveConsent(h.db, h.sal.id)).toBeUndefined();
    expect(getRow(h.db, "consents", "cns_test")!.revoked_reason).toBe("owner texted STOP");
    expect(h.events("consent.revoked")).toHaveLength(1);
    expect(h.events("business.channel_changed").at(-1)!.payload).toMatchObject({ from: "text_enabled", to: "unlisted" });
    expect(h.outbox().filter((m) => m.body === STOP_COPY)).toHaveLength(1);

    const next = h.newBooking("oil change", "2026-10-14T17:00:00.000Z");
    const result = await h.service.sendBookingRequest({ booking_id: next.id, business_id: h.sal.id });
    expect(result).toEqual({ needs_call: true, reason: "no text consent on record" });
    expect(h.events("routing.needs_call")).toHaveLength(1);
  });

  it("'wrong number' revokes and flags the record", async () => {
    const h = harness({ model: throwingModel() });
    await h.post(h.inbound("Wrong number"));
    await h.service.drain();
    expect(h.events("consent.revoked")[0]!.payload).toMatchObject({ wrong_number: true });
    expect(h.sal.channel_state).toBe("unlisted");
  });

  it("HELP answers with the exact help copy and no model", async () => {
    const model = throwingModel();
    const h = harness({ model });
    await h.post(h.inbound("HELP"));
    await h.service.drain();
    expect(h.outbox().map((m) => m.body)).toEqual([HELP_COPY]);
    expect(model.classify).not.toHaveBeenCalled();
  });

  it("PAUSE blocks sends; a timed pause ends on its own", async () => {
    const model = throwingModel();
    const h = harness({ model });
    await h.post(h.inbound("pause for 2 days"));
    await h.service.drain();
    expect(model.classify).not.toHaveBeenCalled();
    expect(h.sal.channel_state).toBe("paused");
    expect(h.outbox().at(-1)!.body).toContain("Paused for 2 days");
    expect(await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id })).toEqual({ needs_call: true, reason: "the owner paused texts" });

    h.clock.advance(3 * 86_400_000);
    const later = h.newBooking("tire rotation", "2026-10-16T17:00:00.000Z");
    expect(await h.service.sendBookingRequest({ booking_id: later.id, business_id: h.sal.id })).toHaveProperty("message_id");
    expect(h.sal.channel_state).toBe("text_enabled");
  });

  it("JOIN after STOP records a join_text consent tied to that message", async () => {
    const h = harness();
    await h.post(h.inbound("STOP"));
    await h.post(h.inbound("JOIN"));
    await h.service.drain();
    const consent = getActiveConsent(h.db, h.sal.id)!;
    const join = selectRows(h.db, "messages", "direction = 'inbound' AND body = 'JOIN'")[0]!;
    expect(consent).toMatchObject({ source: "join_text", message_id: join.id });
    expect(h.sal.channel_state).toBe("text_enabled");
    expect(h.outbox().at(-1)!.body).toBe(RESUME_COPY);
  });

  it("JOIN while already texting changes nothing and sends nothing", async () => {
    const h = harness();
    await h.post(h.inbound("JOIN"));
    await h.service.drain();
    expect(h.outbox()).toEqual([]);
    expect(h.events("consent.recorded")).toHaveLength(0);
  });

  it("UNDO cancels a booking confirmed by text in the last 24 hours", async () => {
    const h = harness();
    await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    await h.post(h.inbound("Y"));
    await h.post(h.inbound("UNDO"));
    await h.service.drain();
    expect(getRow(h.db, "bookings", h.booking.id)!.status).toBe("cancelled");
    expect(h.outbox().at(-1)!.body).toMatch(/^Undone: brake inspection, Tue 10am is cancelled/);
  });
});

describe("replies that are not a plain yes", () => {
  it("a 👍 Tapback asks for an explicit Y and books nothing", async () => {
    const h = harness();
    await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    await h.post(h.inbound("", { reaction: "👍", replyToId: h.fake.messages[0]!.id }));
    await h.service.drain();
    expect(getRow(h.db, "bookings", h.booking.id)!.status).toBe("pending");
    expect(h.outbox().at(-1)!.body).toBe("Got your 👍. Reply Y to confirm brake inspection Tue 10am, or N to pass.");
  });

  it("a Tapback that arrives as SMS text is read the same way", async () => {
    const h = harness();
    await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    await h.post(h.inbound(`Liked “${GOLDEN_COPY}”`));
    await h.service.drain();
    expect(getRow(h.db, "bookings", h.booking.id)!.status).toBe("pending");
  });

  it("'no problem' without a model gets a clarifying question; two of them, then a person", async () => {
    const h = harness({ model: null });
    await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    for (const text of ["no problem", "idk maybe", "hmm"]) await h.post(h.inbound(text));
    await h.service.drain();
    expect(getRow(h.db, "bookings", h.booking.id)!.status).toBe("pending");
    const clarifies = h.events("message.sent").filter((e) => e.payload.kind === "clarify");
    expect(clarifies).toHaveLength(2);
    expect(clarifies[0]!.payload.body).toBe("Just to confirm: brake inspection Tue Oct 13, 10am? Reply Y or N.");
    expect(h.events("reply.classified")[0]!.payload).toMatchObject({ class: "question", method: "fallback" });
    expect(h.events("reply.needs_human")).toHaveLength(1);
  });

  it("'3pm instead' counters with the time anchored to the offered day", async () => {
    const h = harness();
    await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    await h.post(h.inbound("3pm instead"));
    await h.service.drain();
    expect(getRow(h.db, "bookings", h.booking.id)!.status).toBe("countered");
    expect(h.events("booking.countered")[0]!.payload).toMatchObject({ proposed_time_iso: "2026-10-13T15:00:00-07:00" });
    expect(h.outbox().at(-1)!.body).toBe("Thanks. We'll offer Tue 3pm to the customer and text you back.");
  });

  it("'tue at 10' (the offered slot) asks for a Y instead of booking", async () => {
    const h = harness();
    await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    await h.post(h.inbound("tue at 10"));
    await h.service.drain();
    expect(getRow(h.db, "bookings", h.booking.id)!.status).toBe("pending");
    expect(h.outbox().at(-1)!.body).toBe("Just to confirm: brake inspection Tue Oct 13, 10am? Reply Y or N.");
  });

  it("N declines and releases the hold", async () => {
    const h = harness();
    await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    await h.post(h.inbound("N"));
    await h.service.drain();
    expect(getRow(h.db, "bookings", h.booking.id)!.status).toBe("declined");
    expect(h.events("hold.released")).toHaveLength(1);
  });

  it("a text from an unknown number is stored and nothing else happens", async () => {
    const h = harness();
    await h.post(h.inbound("Y", { from: "+14155550199" }));
    await h.service.drain();
    expect(h.outbox()).toEqual([]);
    expect(h.events("reply.classified")).toHaveLength(0);
  });
});

describe("outbound routing and safety", () => {
  it("is idempotent per booking: a second call returns the first message", async () => {
    const h = harness();
    const a = await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    const b = await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    expect(b).toEqual(a);
    expect(h.outbox()).toHaveLength(1);
  });

  it("texts one owner about at most N new jobs an hour, and never escalates to a call over it", async () => {
    const h = harness({ overrides: { maxRequestsPerHour: 2 } });
    const slots = ["2026-10-14T17:00:00.000Z", "2026-10-15T17:00:00.000Z"];
    await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    const second = h.newBooking("oil change", slots[0]);
    await h.service.sendBookingRequest({ booking_id: second.id, business_id: h.sal.id });
    const third = h.newBooking("tire rotation", slots[1]);
    await expect(h.service.sendBookingRequest({ booking_id: third.id, business_id: h.sal.id })).rejects.toBeInstanceOf(OwnerRateLimitedError);
    expect(h.outbox()).toHaveLength(2);
    expect(h.events("message.rate_limited")).toHaveLength(1);
    expect(h.events("routing.needs_call")).toHaveLength(0);
    // A repeat for a booking already texted is still answered from the first message.
    expect(await h.service.sendBookingRequest({ booking_id: second.id, business_id: h.sal.id })).toHaveProperty("message_id");
  });

  it("needs a call when there is no consent", async () => {
    const h = harness({ consent: false });
    expect(await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id })).toEqual({ needs_call: true, reason: "no text consent on record" });
    expect(h.outbox()).toEqual([]);
  });

  it("never sends iMessage to a number lookup says cannot receive it, and falls back to the texting cell", async () => {
    const cell = "+14155550188";
    const h = harness({ textNumber: cell, allowedNumbers: ["+14155550101", cell], lookup: (n) => ({ imessage: n !== cell, whatsapp: false }) });
    const result = await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    expect(result).toHaveProperty("message_id");
    expect(h.outbox()[0]!.to).toBe(h.sal.phone_e164);

    const none = harness({ lookup: () => ({ imessage: false, whatsapp: false }) });
    expect(await none.service.sendBookingRequest({ booking_id: none.booking.id, business_id: none.sal.id })).toMatchObject({ needs_call: true });
    expect(none.events("routing.needs_call")).toHaveLength(1);
    expect(none.outbox()).toEqual([]);
  });

  it("caches the lookup for 24 hours", async () => {
    const h = harness();
    await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    const second = h.newBooking("oil change", "2026-10-14T17:00:00.000Z");
    await h.service.sendBookingRequest({ booking_id: second.id, business_id: h.sal.id });
    expect(h.messaging.lookups).toHaveLength(1);
    h.clock.advance(25 * 3_600_000);
    const third = h.newBooking("tire rotation", "2026-10-15T17:00:00.000Z");
    await h.service.sendBookingRequest({ booking_id: third.id, business_id: h.sal.id });
    expect(h.messaging.lookups).toHaveLength(2);
  });

  it("a lookup that fails (502) is never read as false: nothing is sent and the caller can retry", async () => {
    const h = harness({
      lookup: () => {
        throw new LookupUnavailableError(502, null);
      },
    });
    await expect(h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id })).rejects.toBeInstanceOf(RoutingUnavailableError);
    expect(h.events("routing.lookup_failed")).toHaveLength(1);
    expect(h.outbox()).toEqual([]);
  });

  it("never sends sms to a number that is not on Dial", async () => {
    const h = harness({ textChannel: "dial" });
    const result = await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    expect(result).toMatchObject({ needs_call: true });
    expect(h.outbox()).toEqual([]);

    const dial = harness({ textChannel: "dial", dialNumbers: ["+14155550101"] });
    expect(await dial.service.sendBookingRequest({ booking_id: dial.booking.id, business_id: dial.sal.id })).toHaveProperty("message_id");
    expect(dial.outbox()[0]!.channel).toBe("sms");
    expect(dial.events("message.sent")[0]!.payload).toMatchObject({ channel: "dial" });
  });

  it("refuses a number outside ALLOWED_NUMBERS at the lowest layer", async () => {
    const h = harness({ allowedNumbers: ["+14155550999"] });
    await expect(h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id })).rejects.toBeInstanceOf(NumberNotAllowedError);
    expect(h.outbox()).toEqual([]);
  });

  it("resendLast checks Dial before sending again", async () => {
    const h = harness();
    const first = await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    expect(await h.service.resendLast(h.booking.id)).toEqual({ status: "already_sent", ...first });
    expect(h.outbox()).toHaveLength(1);
    expect(await h.service.resendLast(h.booking.id, { force: true })).toMatchObject({ status: "resent" });
    expect(h.outbox()).toHaveLength(2);
  });

  it("after a send with an unknown outcome, resendLast finds it at Dial and does not send twice", async () => {
    const h = harness();
    const realSend = h.messaging.sendMessage;
    h.messaging.sendMessage = async (input) => {
      await realSend(input); // it reached Dial...
      throw new SendOutcomeUnknownError("timeout"); // ...but the response was lost
    };
    await expect(h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id })).rejects.toBeInstanceOf(SendOutcomeUnknownError);
    expect(h.events("message.send_failed")).toHaveLength(1);
    h.messaging.sendMessage = realSend;

    const result = await h.service.resendLast(h.booking.id);
    expect(result).toMatchObject({ status: "already_sent" });
    expect(h.outbox()).toHaveLength(1);
    expect(h.events("message.sent")[0]!.payload).toMatchObject({ reconciled: true });
  });
});

describe("one Dial account, two numbers", () => {
  it("ignores the owner line's copy of our own request, and still hears the owner's reply", async () => {
    const h = harness();
    await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
    // Dial reports every number's inbound texts to the account webhook, including the owner
    // line receiving what we just sent. That is not the owner speaking.
    await h.post(h.inbound(GOLDEN_COPY, { from: OUR_NUMBER, to: h.sal.phone_e164 }));
    await h.post(h.inbound("Y", { to: "+14155550999" }));
    await h.service.drain();
    expect(h.events("message.received")).toHaveLength(0);
    expect(getRow(h.db, "bookings", h.booking.id)!.status).toBe("pending");

    await h.post(h.inbound("Y"));
    await h.service.drain();
    expect(h.events("message.received")).toHaveLength(1);
    expect(getRow(h.db, "bookings", h.booking.id)!.status).toBe("confirmed");
  });
});
