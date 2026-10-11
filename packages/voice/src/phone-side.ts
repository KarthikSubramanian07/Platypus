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
    fake = new FakeDial({ allowedNumbers: fakeAllowed, voiceTools: tools, timeScale: options.fakeTimeScale ?? 1, autoReply: { body: "Y", afterMs: 4_000 } });
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
    ...(fake ? { messaging: createFakeDialMessaging(fake), allowedNumbers: fakeAllowed } : {}),
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
    app.get("/demo/phone-side", (c) => c.json({ mode, textChannel: config.textChannel, liveCall: calls.liveCall()?.id ?? null }));
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
