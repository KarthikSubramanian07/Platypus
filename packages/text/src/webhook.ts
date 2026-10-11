import { createHmac, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { TextChannel } from "@platypus/shared/config";
import type { MessageChannel } from "@platypus/shared/db";
import type { InboundInput } from "./inbound";

/**
 * Dial webhooks: verify, acknowledge, then work. Dial counts any 2xx as delivered
 * and retries anything else (10-second timeout, 6 attempts), so the route answers
 * as soon as the signature checks out and hands the event to a queue. Replies to
 * the owner, which can take seconds on WhatsApp, are sent from that queue.
 */

export const SIGNATURE_TOLERANCE_SECONDS = 300;
/** The largest webhook body read. A call.transcribed event for a two-minute call is a few kilobytes. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;

/**
 * X-Dial-Signature: t=<unix seconds>,v1=<hex>. v1 is HMAC-SHA256 keyed with the whole
 * secret string, "whsec_" prefix included (UTF-8, not base64-decoded), over `${t}.${rawBody}`.
 */
export function signDialPayload(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

export function verifyDialSignature(secret: string, header: string | null | undefined, rawBody: string, nowSeconds: number, toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS): SignatureCheck {
  if (!header) return { ok: false, reason: "missing" };
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && v && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  if (t === null || v1.length === 0) return { ok: false, reason: "malformed" };
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return { ok: false, reason: "stale" };
  const expected = Buffer.from(signDialPayload(secret, t, rawBody), "hex");
  const match = v1.some((sig) => {
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return match ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** The common Dial event envelope. Unknown types are accepted (and acknowledged) so new event kinds never cause retries. */
export const DialEnvelope = z
  .object({
    id: z.string(),
    type: z.string(),
    createdAt: z.string().optional(),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
export type DialEnvelope = z.infer<typeof DialEnvelope>;

/** message.received data, parsed defensively: replyToId and reaction are documented but absent from the OpenAPI schema. */
export const MessageReceivedData = z.object({
  messageId: z.string(),
  from: z.string(),
  to: z.string().nullable().optional(),
  groupId: z.string().nullable().optional(),
  channel: z.string().default("unknown"),
  body: z.string().default(""),
  replyToId: z.string().nullable().optional(),
  reaction: z.string().nullable().optional(),
  source: z.string().optional(),
});

/** Maps Dial's channel to the messages table's: iMessage and WhatsApp as is, carrier texts as sms (or "dial" on the Dial-to-Dial rail). */
export function storedChannel(dialChannel: string, textChannel: TextChannel): MessageChannel {
  if (dialChannel === "imessage" || dialChannel === "whatsapp") return dialChannel;
  return textChannel === "dial" ? "dial" : "sms";
}

/** A message.received envelope as handleInbound's input, or null for messages we do not handle (group threads). */
export function toInboundInput(envelope: DialEnvelope, options: { textChannel: TextChannel; ourNumber?: string }): InboundInput | null {
  const parsed = MessageReceivedData.safeParse(envelope.data);
  if (!parsed.success) return null;
  const d = parsed.data;
  if (d.groupId) return null;
  return {
    provider_message_id: d.messageId,
    from: d.from,
    to: d.to ?? options.ourNumber ?? "",
    channel: storedChannel(d.channel, options.textChannel),
    body: d.body.slice(0, 4000),
    received_at: envelope.createdAt ?? new Date().toISOString(),
    reaction: d.reaction ?? null,
    reply_to_id: d.replyToId ?? null,
    dial_channel: d.channel,
  };
}

export interface WebhookOptions {
  /** DIAL_WEBHOOK_SECRET ("whsec_..."). Without it the route refuses every request: nothing unsigned is trusted. */
  secret: string | undefined;
  /** Called after verification, before the 200. Must only enqueue; never do the work inline. */
  ingest: (envelope: DialEnvelope, source: "webhook") => void;
  nowSeconds?: () => number;
  path?: string;
}

export function mountDialWebhook(app: Hono, options: WebhookOptions): void {
  const path = options.path ?? "/webhooks/dial";
  // Read before the signature can be checked, so the size is capped first: no unsigned body may fill memory.
  app.use(path, bodyLimit({ maxSize: MAX_WEBHOOK_BYTES, onError: (c) => c.json({ error: "body too large" }, 413) }));
  app.post(path, async (c) => {
    if (!options.secret) return c.json({ error: "webhook secret not configured" }, 503);
    const raw = await c.req.text();
    const nowSeconds = options.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
    const check = verifyDialSignature(options.secret, c.req.header("x-dial-signature"), raw, nowSeconds);
    if (!check.ok) return c.json({ error: `invalid signature (${check.reason})` }, 401);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return c.json({ error: "body is not JSON" }, 400);
    }
    const envelope = DialEnvelope.safeParse(json);
    if (!envelope.success) return c.json({ ok: true, ignored: "not an event envelope" });
    // Dedupe on the id inside the signed body. The X-Dial-Event-Id header is not covered by the
    // signature, so a replayed request with a fresh header must not count as a new event.
    options.ingest(envelope.data, "webhook");
    return c.json({ ok: true });
  });
}
