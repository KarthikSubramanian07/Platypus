import type { Hono } from "hono";
import { loadConfig, type TextChannel } from "@platypus/shared/config";
import type { OwnerChannels, SideDeps } from "@platypus/shared/contracts";
import { listBusinesses, seed } from "@platypus/shared/db";
import { emitSeedEvents } from "@platypus/shared/events";
import { FakeDial } from "@platypus/shared/testing";
import { createCallService, createDialCalls, createFakeDialCalls, type CallService } from "./call/index";
import { contextMcpAllowedHosts, createContextMcpRoutes, resolveContextMcpCredentials } from "./context-mcp/index";
import { createVoiceTools } from "./tools/voice-tools";

/**
 * The text side of OwnerChannels, supplied by @platypus/text. Kept as a narrow
 * interface so the voice package does not depend on the text package's internals.
 */
export interface TextSide {
  routes(app: Hono): void;
  sendBookingRequest: OwnerChannels["sendBookingRequest"];
  resendLast?(bookingId?: string): Promise<unknown>;
  start?(): void;
  stop?(): void;
}

export interface PhoneSideOptions {
  env?: NodeJS.ProcessEnv;
  /** Builds the text side once the call service exists, so the shared Dial webhook can hand call events to it. */
  text?: (ctx: { onDialEvent: (envelope: unknown) => void; textChannel: TextChannel }) => TextSide;
  /** Pacing of the fake call when no Dial key is present: 1 = real time. */
  fakeTimeScale?: number;
}

export interface PhoneSide {
  calls: CallService;
  text: TextSide | null;
  mode: "dial" | "fake";
  owner: OwnerChannels;
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
  if (realDial) {
    mode = "dial";
    dialCalls = createDialCalls({ apiKey: env.DIAL_API_KEY!, fromNumberId, allowedNumbers: config.allowedNumbers });
  } else {
    mode = "fake";
    // Fakes never ring anything; the allow-list still applies, defaulting to the seeded numbers.
    const allowed = config.allowedNumbers.length ? config.allowedNumbers : listBusinesses(db).map((b) => b.phone_e164);
    const fake = new FakeDial({ allowedNumbers: allowed, voiceTools: tools, timeScale: options.fakeTimeScale ?? 1, autoReply: { body: "Y", afterMs: 4_000 } });
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

  const text = options.text?.({ onDialEvent: (envelope) => void calls.handleDialEvent(envelope), textChannel: config.textChannel }) ?? null;

  const owner: OwnerChannels = {
    startOnboardingCall: (input) => calls.startOnboardingCall(input),
    sendBookingRequest: async (input) =>
      text ? text.sendBookingRequest(input) : { needs_call: true, reason: "The text channel is not running in this process" },
  };

  function mount(app: Hono): void {
    const { secret, token } = resolveContextMcpCredentials(env);
    app.route("/", createContextMcpRoutes({ tools, secret, token, allowedHosts: contextMcpAllowedHosts(env.PUBLIC_BASE_URL) }));
    text?.routes(app);
    text?.start?.();

    // Demo controls for the stage and the video (docs/workstreams.md, phone side item 6).
    app.post("/demo/kill-call", async (c) => c.json(await calls.stopCall(undefined, "kill_switch")));
    app.post("/demo/replay-last-call", async (c) => c.json(await calls.replayLastCall({ timeScale: Number(c.req.query("timeScale") ?? 0) })));
    app.post("/demo/resend-last-text", async (c) =>
      text?.resendLast ? c.json({ ok: true, result: await text.resendLast(c.req.query("booking_id")) }) : c.json({ ok: false, reason: "text side not running" }, 409),
    );
    app.get("/demo/phone-side", (c) => c.json({ mode, textChannel: config.textChannel, liveCall: calls.liveCall()?.id ?? null }));
  }

  return { calls, text, mode, owner, mount };
}
