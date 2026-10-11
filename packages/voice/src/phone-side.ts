import type { Hono } from "hono";
import { loadConfig } from "@platypus/shared/config";
import type { OwnerChannels, SideDeps } from "@platypus/shared/contracts";
import { listBusinesses, seed } from "@platypus/shared/db";
import { emitSeedEvents } from "@platypus/shared/events";
import { FakeDial } from "@platypus/shared/testing";
import { createCallService, createDialCalls, createFakeDialCalls, type CallService } from "./call/index";
import { contextMcpAllowedHosts, createContextMcpRoutes, resolveContextMcpCredentials } from "./context-mcp/index";
import { createFakeDialMessaging, createTextServiceFromEnv, type TextService } from "@platypus/text";
import { createVoiceTools } from "./tools/voice-tools";

export interface PhoneSideOptions {
  env?: NodeJS.ProcessEnv;
  /** Pacing of the fake call when no Dial key is present: 1 = real time. */
  fakeTimeScale?: number;
}

export interface PhoneSide {
  calls: CallService;
  text: TextService;
  mode: "dial" | "fake";
  owner: OwnerChannels;
  /** The in-process Dial stand-in when no Dial key is configured; null with real Dial. */
  fake: FakeDial | null;
  mount(app: Hono): void;
}

/**
 * Builds the phone side for one process: the real VoiceTools, the call service over real
 * Dial (DEMO_MODE=live with DIAL_API_KEY) or over FakeDial, whose scripted voice agent calls
 * those same real tools, and the text side. Nothing here places a call until asked.
 */
export function createPhoneSide(deps: SideDeps, options: PhoneSideOptions = {}): PhoneSide {
  const env = options.env ?? process.env;
  const config = loadConfig(env);
  const { db, bus } = deps;
  if (listBusinesses(db).length === 0) seed(db, { allowedNumbers: config.allowedNumbers, onSeeded: emitSeedEvents(db, { bus }) });

  const tools = createVoiceTools({ db, bus, textChannel: config.textChannel });
  const realDial = config.demoMode === "live" && Boolean(env.DIAL_API_KEY);
  const fromNumberId = env.DIAL_FROM_NUMBER_ID ?? "num_fake";

  let mode: PhoneSide["mode"];
  let dialCalls;
  let fake: FakeDial | undefined;
  let fakeAllowed: string[] = [];
  if (realDial) {
    mode = "dial";
    dialCalls = createDialCalls({ apiKey: env.DIAL_API_KEY!, fromNumberId, allowedNumbers: config.allowedNumbers });
  } else {
    mode = "fake";
    // Fakes never ring anything; the allow-list still applies, defaulting to the seeded numbers.
    fakeAllowed = config.allowedNumbers.length ? config.allowedNumbers : listBusinesses(db).map((b) => b.phone_e164);
    // On the Dial-to-Dial rail every simulated owner phone counts as a Dial line.
    const fakeDialLines = config.textChannel === "dial" ? fakeAllowed : [];
    fake = new FakeDial({ allowedNumbers: fakeAllowed, dialNumbers: fakeDialLines, voiceTools: tools, timeScale: options.fakeTimeScale ?? 1, autoReply: { body: "Y", afterMs: 4_000 } });
    dialCalls = createFakeDialCalls(fake, { fromNumberId });
  }

  const calls = createCallService({
    db,
    bus,
    calls: dialCalls,
    fromNumberId,
    demoMode: config.demoMode === "live",
    textChannel: config.textChannel,
    ...(env.DIAL_NUMBER ? { callbackNumber: env.DIAL_NUMBER } : {}),
  });

  // One Dial webhook serves both packages: text handles messages and hands every other verified event to the call service.
  const text = createTextServiceFromEnv(deps, env, {
    onDialEvent: (envelope) => void calls.handleDialEvent(envelope),
    ...(fake
      ? { messaging: createFakeDialMessaging(fake), allowedNumbers: fakeAllowed, ...(config.textChannel === "dial" ? { dialNumbers: fakeAllowed } : {}) }
      : {}),
  });
  // FakeDial delivers the owner's scripted replies in-process instead of through a webhook.
  fake?.on((envelope) => {
    if (envelope.type === "message.received") text.ingest(envelope as Parameters<TextService["ingest"]>[0], "events");
  });

  const owner: OwnerChannels = {
    startOnboardingCall: (input) => calls.startOnboardingCall(input),
    sendBookingRequest: (input) => text.sendBookingRequest(input),
  };

  function mount(app: Hono): void {
    const { secret, token } = resolveContextMcpCredentials(env);
    app.route("/", createContextMcpRoutes({ tools, secret, token, allowedHosts: contextMcpAllowedHosts(env.PUBLIC_BASE_URL) }));
    text.routes(app);
    // The events stream is the second consumer, so a dropped tunnel does not lose a reply (same dedupe as the webhook).
    if (realDial && env.DIAL_EVENTS_CONSUMER !== "off") text.startEventsConsumer().start();

    // Demo controls for the stage and the video (docs/workstreams.md, phone side item 6).
    app.post("/demo/kill-call", async (c) => c.json(await calls.stopCall(undefined, "kill_switch")));
    app.post("/demo/replay-last-call", async (c) => c.json(await calls.replayLastCall({ timeScale: Number(c.req.query("timeScale") ?? 0) })));
    app.post("/demo/resend-last-text", async (c) =>
      c.json(await text.resendLast(c.req.query("booking_id") ?? lastTextBooking())),
    );
    // The owner's side of the Dial-to-Dial rail: the dashboard's owner phone replies from here.
    app.post("/demo/owner-reply", async (c) => {
      const body = String(((await c.req.json().catch(() => ({}))) as { body?: unknown }).body ?? "").trim().slice(0, 300);
      if (!body) return c.json({ ok: false, reason: "body is required" }, 400);
      return c.json(await ownerReply(body));
    });
    app.get("/demo/phone-side", (c) => c.json({ mode, textChannel: config.textChannel, liveCall: calls.liveCall()?.id ?? null }));
  }

  /**
   * Sends the owner's reply. Fakes: FakeDial delivers it in-process from the shop's texting
   * number. Real Dial: only on the Dial-to-Dial rail, from DIAL_OWNER_LINE_ID to our own number
   * (DIAL_NUMBER), so it can never reach anyone outside the team's Dial account.
   */
  async function ownerReply(body: string): Promise<{ ok: boolean; reason?: string; id?: string }> {
    const shop = listBusinesses(db).find((b) => b.slug === "sals-auto");
    if (!shop) return { ok: false, reason: "the demo shop is not seeded" };
    if (fake) {
      const from = config.textChannel === "dial" && env.DIAL_OWNER_LINE ? env.DIAL_OWNER_LINE : (shop.text_number_e164 ?? shop.phone_e164);
      return { ok: true, id: fake.receive({ from, body, channel: config.textChannel === "dial" ? "sms" : config.textChannel }).id };
    }
    if (config.textChannel !== "dial" || !env.DIAL_OWNER_LINE_ID || !env.DIAL_NUMBER) {
      return { ok: false, reason: "owner replies from the dashboard need TEXT_CHANNEL=dial, DIAL_OWNER_LINE_ID and DIAL_NUMBER; otherwise reply from the owner's phone" };
    }
    const res = await fetch("https://api.getdial.ai/api/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${env.DIAL_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ to: env.DIAL_NUMBER, fromNumberId: env.DIAL_OWNER_LINE_ID, channel: "sms", body }),
    });
    if (!res.ok) return { ok: false, reason: `Dial answered ${res.status}` };
    const { message } = (await res.json()) as { message?: { id?: string } };
    return { ok: true, ...(message?.id ? { id: message.id } : {}) };
  }

  /** The booking of the most recent owner text, for "resend last text" on stage. */
  function lastTextBooking(): string {
    const row = db.prepare("SELECT booking_id FROM messages WHERE direction = 'outbound' AND booking_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get() as
      | { booking_id: string }
      | undefined;
    return row?.booking_id ?? "";
  }

  return { calls, text, mode, owner, mount, fake: fake ?? null };
}
