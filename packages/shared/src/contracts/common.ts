import { z } from "zod";
import { BOOKING_ROUTES, BOOKING_STATUSES, CHANNEL_STATES, MESSAGE_CHANNELS } from "../db/types";
import { UNTRUSTED_TEXT_MAX } from "../safety";

export const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "E.164 phone number, e.g. +14155550123");
export const IsoDateTime = z.iso.datetime({ offset: true }).describe("ISO-8601 date-time");
export const Cents = z.number().int().nonnegative().describe("Amount in US cents");

/** Agent- or owner-supplied free text. Sanitize with sanitizeUntrustedText before storing or prompting. */
export const UntrustedText = z.string().max(UNTRUSTED_TEXT_MAX * 4);

export const TimeWindow = z
  .object({ start: IsoDateTime, end: IsoDateTime })
  .describe("A time range the customer can make, e.g. tomorrow 12:00 to 17:00 local time, as ISO-8601");
export type TimeWindow = z.infer<typeof TimeWindow>;

export const Slot = z.object({ start: IsoDateTime, end: IsoDateTime }).describe("A concrete appointment time");
export type Slot = z.infer<typeof Slot>;

export const BookingStatus = z.enum(BOOKING_STATUSES);
export const BookingRoute = z
  .enum(BOOKING_ROUTES)
  .describe("darwin_act: an existing agent handles it. call: Platypus phones the business. text: the business has opted in to texts");
export const ChannelState = z.enum(CHANNEL_STATES);
export const MessageChannel = z.enum(MESSAGE_CHANNELS);
export const TextRail = z.enum(["imessage", "whatsapp", "dial"]);

export const IdempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .describe("Unique per logical write. Retrying with the same key returns the original result and never books twice");

export const ConfirmationEvidence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("call"), callId: z.string(), quotedSentence: z.string().min(1) }),
  z.object({ kind: z.literal("text"), messageId: z.string() }),
  z.object({ kind: z.literal("rule"), ruleId: z.string() }),
]);

/** The public view of a booking: what an agent receives from get_booking. */
export const Booking = z.object({
  booking_id: z.string(),
  provider_id: z.string(),
  provider_name: z.string(),
  service: z.string(),
  status: BookingStatus,
  route: BookingRoute.nullable(),
  short_code: z.string().describe("Reference code the owner and customer can quote, e.g. SAL-4K2"),
  window: TimeWindow.nullable(),
  slot: Slot.nullable(),
  price_cents: Cents.nullable(),
  confirmed_by: z.enum(["call", "text", "rule"]).nullable().describe("How the owner said yes; null until confirmed"),
  updated_at: IsoDateTime,
});
export type BookingView = z.infer<typeof Booking>;
