import type { Hono } from "hono";
import { loadConfig, parseAllowedNumbers } from "@platypus/shared/config";
import type { OwnerChannels, SideDeps } from "@platypus/shared/contracts";
import { classifyReply, type ClassifyResult, type ReplyContext } from "./classify";
import type { TextDeps } from "./deps";
import { createDialMessaging, type DialMessaging } from "./dial-messaging";
import { createEventsConsumer, type EventsConsumer } from "./events-consumer";
import { handleInbound, type InboundInput, type InboundOutcome } from "./inbound";
import { replyModelFromEnv } from "./model";
import { resendLast, sendBookingRequest, type ResendResult, type SendBookingResult } from "./outbound";
import { mountDialWebhook, toInboundInput, type DialEnvelope } from "./webhook";

/**
 * @platypus/text: the owner text channel on Dial. After one yes on the call, every
 * future request is a text the owner answers with one word.
 */
export const PACKAGE = "@platypus/text" as const;

export * from "./classify";
export * from "./copy";
export * from "./dial-messaging";
export * from "./events-consumer";
export * from "./keywords";
export * from "./model";
export * from "./money";
export * from "./phone";
export * from "./time";
export { handleInbound, MAX_CLARIFICATIONS, type InboundInput, type InboundOutcome } from "./inbound";
export { MAX_REQUESTS_PER_BUSINESS_PER_HOUR, OwnerRateLimitedError, RoutingUnavailableError, dialChannelFor, type ResendResult, type SendBookingResult } from "./outbound";
export { DialEnvelope, signDialPayload, storedChannel, toInboundInput, verifyDialSignature } from "./webhook";
export type { Clock, TextDeps } from "./deps";

export interface TextServiceDeps extends TextDeps {
  /** DIAL_WEBHOOK_SECRET. The webhook refuses everything without it. */
  webhookSecret?: string;
  /** DIAL_API_KEY, for the events-stream consumer. */
  dialApiKey?: string;
  dialBaseUrl?: string;
  /** Injectable fetch for the events consumer (tests). */
  eventsFetch?: typeof fetch;
  /**
   * Called (from the queue, after the 2xx) for every verified Dial event that is not
   * an inbound message: call.*, message.status_changed, webhook.ping. The voice
   * package consumes call events from the same webhook through this.
   */
  onDialEvent?: (envelope: DialEnvelope) => void | Promise<void>;
  /** Where processing errors go; they are also written to the event log. Defaults to console.error. */
  onError?: (error: Error, context: string) => void;
}

export interface TextService {
  /** Mounts POST /webhooks/dial. */
  routes(app: Hono): void;
  sendBookingRequest: OwnerChannels["sendBookingRequest"];
  handleInbound(input: InboundInput): Promise<InboundOutcome>;
  resendLast(bookingId: string, options?: { force?: boolean }): Promise<ResendResult>;
  /** Starts the POST /events/wait loop (the webhook's backup). Returns its handle; stop() ends it. */
  startEventsConsumer(options?: { timeoutSeconds?: number }): EventsConsumer;
  /** Enqueues a verified envelope from any source; dedupes on event id and message id. */
  ingest(envelope: DialEnvelope, source: "webhook" | "events"): void;
  /** Resolves when every queued event has been processed. */
  drain(): Promise<void>;
  classify(text: string, ctx: ReplyContext): Promise<ClassifyResult>;
}

/** Remembers the last N keys; enough to absorb Dial's retries and the webhook/stream overlap. */
class RecentKeys {
  private readonly keys = new Set<string>();
  constructor(private readonly limit = 5_000) {}
  /** True the first time a key is seen. */
  add(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > this.limit) this.keys.delete(this.keys.values().next().value!);
    return true;
  }
}

export function createTextService(deps: TextServiceDeps): TextService {
  const onError = deps.onError ?? ((error: Error, context: string) => console.error(`[text] ${context}:`, error.message));
  const seen = new RecentKeys();
  let tail: Promise<void> = Promise.resolve();

  /** One event at a time, in arrival order; SQLite is synchronous and this keeps reasoning simple. */
  const enqueue = (label: string, work: () => Promise<unknown>) => {
    tail = tail.then(() => new Promise<void>((resolve) => setImmediate(resolve))).then(async () => {
      try {
        await work();
      } catch (error) {
        onError(error as Error, label);
      }
    });
  };

  function ingest(envelope: DialEnvelope, source: "webhook" | "events"): void {
    if (!seen.add(`evt:${envelope.id}`)) return;
    if (envelope.type === "message.received") {
      const input = toInboundInput(envelope, { textChannel: deps.textChannel, ...(deps.ourNumber ? { ourNumber: deps.ourNumber } : {}) });
      if (!input) return;
      // Every number on the Dial account reports its inbound texts to the same webhook. On the
      // Dial-to-Dial rail that includes the owner line receiving our own requests, which is not
      // the owner speaking: only messages addressed to our number, from someone else, count.
      if (deps.ourNumber && (input.from === deps.ourNumber || (input.to && input.to !== deps.ourNumber))) return;
      if (!seen.add(`msg:${input.provider_message_id}`)) return;
      enqueue(`inbound from ${source}`, () => handleInbound(deps, input));
      return;
    }
    if (deps.onDialEvent) enqueue(`${envelope.type} from ${source}`, async () => deps.onDialEvent!(envelope));
  }

  return {
    routes(app) {
      mountDialWebhook(app, {
        secret: deps.webhookSecret,
        ingest,
        nowSeconds: () => Math.floor((deps.clock?.now() ?? new Date()).getTime() / 1000),
      });
    },
    sendBookingRequest: (input): Promise<SendBookingResult> => sendBookingRequest(deps, input),
    handleInbound: (input) => handleInbound(deps, input),
    resendLast: (bookingId, options) => resendLast(deps, bookingId, options),
    startEventsConsumer(options = {}) {
      if (!deps.dialApiKey) throw new Error("DIAL_API_KEY is required for the events consumer");
      const consumer = createEventsConsumer({
        apiKey: deps.dialApiKey,
        ingest,
        ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
        ...(deps.dialBaseUrl ? { baseUrl: deps.dialBaseUrl } : {}),
        ...(deps.eventsFetch ? { fetch: deps.eventsFetch } : {}),
        onError: (e) => onError(e, "events consumer"),
      });
      consumer.start();
      return consumer;
    },
    ingest,
    drain: async () => {
      let current: Promise<void>;
      do {
        current = tail;
        await current;
      } while (current !== tail);
    },
    classify: (text, ctx) => classifyReply(text, ctx, { model: deps.model ?? null }),
  };
}

/**
 * The live wiring from the environment: Dial over HTTP, Claude when ANTHROPIC_API_KEY
 * is set. DIAL_OWNER_NUMBERS lists owner numbers that are themselves Dial numbers
 * (the only ones "sms" may reach); CLASSIFIER_MODEL overrides the model.
 */
export function createTextServiceFromEnv(side: SideDeps, env: NodeJS.ProcessEnv = process.env, overrides: Partial<TextServiceDeps> = {}): TextService {
  const config = loadConfig(env);
  // On the Dial-to-Dial rail the owner line is itself a Dial number, so it may receive "sms".
  // On iMessage it is a real phone and must never be treated as one.
  const ownerLineIsDial = config.textChannel === "dial" ? parseAllowedNumbers(env.DIAL_OWNER_LINE) : [];
  const dialNumbers = [...new Set([...parseAllowedNumbers(env.DIAL_OWNER_NUMBERS), ...ownerLineIsDial])];
  let messaging: DialMessaging | undefined = overrides.messaging;
  if (!messaging) {
    if (!env.DIAL_API_KEY || !env.DIAL_FROM_NUMBER_ID) throw new Error("DIAL_API_KEY and DIAL_FROM_NUMBER_ID are required to text owners");
    messaging = createDialMessaging({ apiKey: env.DIAL_API_KEY, fromNumberId: env.DIAL_FROM_NUMBER_ID, allowedNumbers: config.allowedNumbers, dialNumbers });
  }
  return createTextService({
    db: side.db,
    bus: side.bus,
    messaging,
    textChannel: config.textChannel,
    allowedNumbers: config.allowedNumbers,
    dialNumbers,
    model: replyModelFromEnv(env),
    ...(env.DIAL_NUMBER ? { ourNumber: env.DIAL_NUMBER } : {}),
    ...(env.DIAL_OWNER_LINE ? { ownerLine: env.DIAL_OWNER_LINE.trim() } : {}),
    ...(env.DIAL_WEBHOOK_SECRET ? { webhookSecret: env.DIAL_WEBHOOK_SECRET } : {}),
    ...(env.DIAL_API_KEY ? { dialApiKey: env.DIAL_API_KEY } : {}),
    ...overrides,
  });
}
