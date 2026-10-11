import { describe, expect, it, vi } from "vitest";
import { NumberNotAllowedError } from "@platypus/shared/safety";
import {
  composeBookingRequest,
  composeConfirmPrompt,
  composeCounterAck,
  composeReactionPrompt,
  composeReceipt,
  composeUndone,
  DECLINE_ACK_COPY,
  HELP_COPY,
  MAX_TEXT_LENGTH,
  NO_OPEN_JOB_COPY,
  NOTHING_TO_UNDO_COPY,
  pauseCopy,
  RESUME_COPY,
  STOP_COPY,
} from "./copy";
import { createDialMessaging, DialApiError, LookupUnavailableError, SendOutcomeUnknownError, SmsNotAllowedError } from "./dial-messaging";
import { createEventsConsumer } from "./events-consumer";
import { dialChannelFor } from "./outbound";

const OWNER = "+14155550101";

function fetchStub(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("createDialMessaging", () => {
  it("sends exactly the documented body with fromNumberId", async () => {
    const { fetch, calls } = fetchStub(json(201, { message: { id: "msg_1", from: "+15550100000" } }));
    const dial = createDialMessaging({ apiKey: "k", fromNumberId: "num_1", allowedNumbers: [OWNER], fetch });
    expect(await dial.sendMessage({ to: OWNER, body: "hi", channel: "imessage" })).toEqual({ id: "msg_1", from: "+15550100000" });
    expect(calls[0]!.url).toBe("https://api.getdial.ai/api/v1/messages");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ to: OWNER, channel: "imessage", body: "hi", fromNumberId: "num_1" });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("refuses numbers outside ALLOWED_NUMBERS before any request", async () => {
    const { fetch } = fetchStub(json(201, { message: { id: "x" } }));
    const dial = createDialMessaging({ apiKey: "k", fromNumberId: "num_1", allowedNumbers: [], fetch });
    await expect(dial.sendMessage({ to: OWNER, body: "hi", channel: "imessage" })).rejects.toBeInstanceOf(NumberNotAllowedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses sms to a number that is not on Dial before any request", async () => {
    const { fetch } = fetchStub(json(201, { message: { id: "x" } }));
    const dial = createDialMessaging({ apiKey: "k", fromNumberId: "num_1", allowedNumbers: [OWNER], fetch });
    await expect(dial.sendMessage({ to: OWNER, body: "hi", channel: "sms" })).rejects.toBeInstanceOf(SmsNotAllowedError);
    expect(fetch).not.toHaveBeenCalled();
    const dialToDial = createDialMessaging({ apiKey: "k", fromNumberId: "num_1", allowedNumbers: [OWNER], dialNumbers: [OWNER], fetch });
    await expect(dialToDial.sendMessage({ to: OWNER, body: "hi", channel: "sms" })).resolves.toEqual({ id: "x" });
  });

  it("separates 'not sent' (4xx) from 'unknown' (5xx, network)", async () => {
    const rejected = createDialMessaging({ apiKey: "k", fromNumberId: "n", allowedNumbers: [OWNER], fetch: fetchStub(json(400, { error: { message: "bad" } })).fetch });
    await expect(rejected.sendMessage({ to: OWNER, body: "hi", channel: "imessage" })).rejects.toBeInstanceOf(DialApiError);
    const flaky = createDialMessaging({ apiKey: "k", fromNumberId: "n", allowedNumbers: [OWNER], fetch: fetchStub(json(503, {})).fetch });
    await expect(flaky.sendMessage({ to: OWNER, body: "hi", channel: "imessage" })).rejects.toBeInstanceOf(SendOutcomeUnknownError);
    const offline = createDialMessaging({ apiKey: "k", fromNumberId: "n", allowedNumbers: [OWNER], fetch: fetchStub(new TypeError("fetch failed")).fetch });
    await expect(offline.sendMessage({ to: OWNER, body: "hi", channel: "imessage" })).rejects.toBeInstanceOf(SendOutcomeUnknownError);
  });

  it("reads lookup, and treats 502 and 429 as 'ask again', never as false", async () => {
    const ok = createDialMessaging({ apiKey: "k", fromNumberId: "n", allowedNumbers: [], fetch: fetchStub(json(200, { number: OWNER, supports: { imessage: true, whatsapp: false } })).fetch });
    expect(await ok.lookup(OWNER)).toEqual({ imessage: true, whatsapp: false });
    const down = createDialMessaging({ apiKey: "k", fromNumberId: "n", allowedNumbers: [], fetch: fetchStub(json(502, {})).fetch });
    await expect(down.lookup(OWNER)).rejects.toBeInstanceOf(LookupUnavailableError);
    const limited = createDialMessaging({ apiKey: "k", fromNumberId: "n", allowedNumbers: [], fetch: fetchStub(json(429, {}, { "retry-after": "7" })).fetch });
    await expect(limited.lookup(OWNER)).rejects.toMatchObject({ status: 429, retryAfterMs: 7000 });
  });

  it("lists outbound messages to a contact since a time", async () => {
    const { fetch, calls } = fetchStub(json(200, { messages: [{ id: "m1", from: "+1555", to: OWNER, body: "hi", direction: "outbound", channel: "unknown", createdAt: "2026-10-11T19:00:00Z" }] }));
    const dial = createDialMessaging({ apiKey: "k", fromNumberId: "n", allowedNumbers: [], fetch });
    const list = await dial.listMessages({ contact: OWNER, direction: "outbound", since: "2026-10-11T18:59:00.000Z" });
    expect(list).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.getdial.ai/api/v1/messages?contact=%2B14155550101&direction=outbound&since=2026-10-11T18%3A59%3A00.000Z`);
  });

  it("maps each rail to its Dial channel; only the dial rail is sms", () => {
    expect(dialChannelFor("imessage")).toBe("imessage");
    expect(dialChannelFor("whatsapp")).toBe("whatsapp");
    expect(dialChannelFor("dial")).toBe("sms");
  });
});

describe("events consumer", () => {
  it("backs off after errors, keeps polling through 408s, and stops cleanly", async () => {
    const envelope = { id: "evt_1", object: "event", type: "message.received", data: { messageId: "m1" } };
    const { fetch } = fetchStub(new TypeError("offline"), json(500, {}), json(200, { event: envelope }), json(408, {}));
    const ingest = vi.fn();
    const errors: Error[] = [];
    const consumer = createEventsConsumer({ apiKey: "k", fetch, ingest, initialBackoffMs: 5, maxBackoffMs: 20, onError: (e) => errors.push(e) });
    consumer.start();
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    await consumer.stop();
    expect(consumer.running).toBe(false);
    expect(errors).toHaveLength(2);
    expect(ingest.mock.calls[0]![0]).toMatchObject({ id: "evt_1", type: "message.received" });
  });
});

describe("owner copy", () => {
  const tz = "America/Los_Angeles";
  const golden = {
    service: "brake inspection",
    details: "2019 Civic",
    requested_by: "Alex's assistant",
    slot_start: "2026-10-13T17:00:00.000Z",
    window_start: "2026-10-13T17:00:00.000Z",
    window_end: "2026-10-16T00:00:00.000Z",
    short_code: "SAL-9S2",
  };

  it("matches spec B.7 for the golden path", () => {
    expect(composeBookingRequest(golden, tz)).toBe("New job via Platypus (AI-assisted): brake inspection, Tue 10am, 2019 Civic. From Alex's assistant. Reply Y, N, or a time.");
    expect(composeBookingRequest({ ...golden, slot_start: null }, tz)).toBe(
      "New job via Platypus (AI-assisted): brake inspection, Tue-Thu, Oct 13-15, 2019 Civic. From Alex's assistant. Reply Y, N, or a time.",
    );
  });

  it("stays under 300 characters and strips links, whatever the agent sends", () => {
    const long = "x".repeat(2000);
    const hostile = { ...golden, service: `brake job ${long}`, details: `see https://evil.example/pay ${long}`, requested_by: `Mallory ${long}` };
    const body = composeBookingRequest(hostile, tz);
    expect(body.length).toBeLessThan(MAX_TEXT_LENGTH);
    expect(body).not.toContain("https://");
    expect(body.endsWith("Reply Y, N, or a time.")).toBe(true);
  });

  it("keeps every message under 300 characters and never says 'Reply UNDO to cancel'", () => {
    const long = { ...golden, service: "y".repeat(500), details: "z".repeat(500) };
    const all = [
      STOP_COPY,
      HELP_COPY,
      RESUME_COPY,
      NOTHING_TO_UNDO_COPY,
      NO_OPEN_JOB_COPY,
      DECLINE_ACK_COPY,
      pauseCopy(null),
      pauseCopy(14),
      composeBookingRequest(long, tz),
      composeConfirmPrompt(long, tz),
      composeReactionPrompt(long, tz, "like"),
      composeReceipt(long, tz),
      composeUndone(long, tz),
      composeCounterAck(null, 30000, tz),
    ];
    for (const m of all) {
      expect(m.length, m).toBeLessThan(MAX_TEXT_LENGTH);
      expect(m).not.toMatch(/UNDO to cancel/i);
    }
    expect(STOP_COPY).toBe("You're unlisted and won't get more texts from Platypus. Text JOIN anytime to come back.");
    expect(HELP_COPY).toBe("Platypus: AI-assisted job requests for your shop. Reply STOP to opt out, PAUSE to pause. Msg&data rates may apply.");
  });
});
