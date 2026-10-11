import { z } from "zod";

/**
 * Dial API shapes, from docs.getdial.ai/openapi.json and @getdial/sdk 0.41
 * (checked 2026-10-11). FakeDial emits exactly these; the voice package parses them.
 */
export const DIAL_CALL_STATES = ["Queued", "Ringing", "In-Progress", "Terminated", "Unknown"] as const;
export const DIAL_TERMINATION_TYPES = ["completed", "busy", "no-answer", "failed", "canceled"] as const;

export const DialTranscriptTurn = z.object({
  speaker: z.enum(["agent", "user", "transfer_target"]),
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
});

export const DialCall = z
  .object({
    id: z.string(),
    phoneNumberId: z.string().optional(),
    from: z.string(),
    to: z.string(),
    direction: z.enum(["outbound", "inbound"]),
    status: z.object({
      state: z.enum(DIAL_CALL_STATES),
      terminationType: z.enum(DIAL_TERMINATION_TYPES).nullable(),
      label: z.string().optional(),
    }).passthrough(),
    duration: z.number().nullable().optional(),
    transcript: z.string().nullable(),
    transcriptTurns: z.array(DialTranscriptTurn).nullable(),
    createdAt: z.string(),
  })
  .passthrough();
export type DialCall = z.infer<typeof DialCall>;

/** POST /api/v1/calls. Send exactly one of fromNumber (id, E.164 or nickname; preferred) and fromNumberId (legacy). */
export const PlaceCallRequest = z.object({
  to: z.string(),
  fromNumber: z.string().optional(),
  fromNumberId: z.string().optional(),
  outboundInstruction: z.string(),
  language: z.string().optional(),
  maxCallDurationSeconds: z.number().int().min(60).max(3600).optional(),
  voiceGender: z.enum(["male", "female"]).optional(),
  transferTo: z.string().optional(),
});
export type PlaceCallRequest = z.infer<typeof PlaceCallRequest>;

const envelope = <T extends string, D extends z.ZodTypeAny>(type: T, data: D) =>
  z.object({
    id: z.string(),
    object: z.literal("event"),
    type: z.literal(type),
    version: z.number(),
    createdAt: z.string(),
    relatedObject: z.object({ id: z.string(), type: z.string(), url: z.string().nullable() }).nullable(),
    data,
  });

export const DialCallStatusChanged = envelope(
  "call.status_changed",
  z.object({
    callId: z.string(),
    direction: z.enum(["outbound", "inbound"]),
    from: z.string(),
    to: z.string(),
    status: z.object({ state: z.enum(DIAL_CALL_STATES), label: z.string().optional() }),
    previousState: z.enum(DIAL_CALL_STATES).nullable(),
    terminationType: z.enum(DIAL_TERMINATION_TYPES).nullable(),
  }),
);
export const DialCallEnded = envelope(
  "call.ended",
  z.object({
    callId: z.string(),
    from: z.string(),
    to: z.string(),
    direction: z.enum(["outbound", "inbound"]),
    durationSeconds: z.number().nullable(),
    status: z.enum(DIAL_TERMINATION_TYPES),
    canceled: z.boolean(),
    transcriptAvailable: z.boolean(),
  }),
);
/** Carries only the call id: fetch GET /calls/{id} for transcript and transcriptTurns. */
export const DialCallTranscribed = envelope("call.transcribed", z.object({ callId: z.string() }));
export const DialMessageReceived = envelope(
  "message.received",
  z.object({
    messageId: z.string(),
    from: z.string(),
    to: z.string().nullable(),
    channel: z.enum(["sms", "imessage", "rcs", "whatsapp", "unknown"]),
    body: z.string(),
    media: z.array(z.unknown()).default([]),
    /** On iMessage, a Tapback arrives with an empty body and this set (a name like "like" or an emoji). */
    reaction: z.string().nullable().optional(),
    replyToId: z.string().nullable().optional(),
    source: z.enum(["external", "internal"]).optional(),
  }),
);

/** Delivery and read receipts for messages we sent. */
export const DialMessageStatusChanged = envelope(
  "message.status_changed",
  z.object({ messageId: z.string(), changed: z.string().optional(), deliveryState: z.string().optional(), readState: z.string().optional() }).passthrough(),
);
export const DialWebhookPing = envelope("webhook.ping", z.object({}).passthrough());

export const DialEvent = z.discriminatedUnion("type", [
  DialCallStatusChanged,
  DialCallEnded,
  DialCallTranscribed,
  DialMessageReceived,
  DialMessageStatusChanged,
  DialWebhookPing,
]);
export type DialEvent = z.infer<typeof DialEvent>;

/**
 * Headers Dial adds to every Context MCP request during a call. X-Dial-User-Number is the
 * other party: the business on our outbound calls. On Dial's tool-discovery connection they
 * may be absent or arrive as literal templates such as "{{user_number}}".
 */
export const DIAL_HEADERS = {
  direction: "x-dial-direction",
  userNumber: "x-dial-user-number",
  agentNumber: "x-dial-agent-number",
} as const;
