import { z } from "zod";
import { E164, IsoDateTime, MessageChannel, TextRail } from "./common";

/** One inbound owner message, normalized from a Dial webhook or the event stream. */
export const TextInbound = z.object({
  provider_message_id: z.string().describe("Dial message id; the dedupe key across webhook and stream"),
  from: E164,
  to: E164,
  channel: MessageChannel,
  body: z.string().max(4000),
  received_at: IsoDateTime,
});
export type TextInbound = z.infer<typeof TextInbound>;

/** One outbound owner message. Channel is the rail, never "sms" to a non-Dial number. */
export const TextOutbound = z.object({
  to: E164,
  body: z.string().min(1).max(300).describe("Plain, specific, answerable with one word; under 300 characters"),
  channel: TextRail,
});
export type TextOutbound = z.infer<typeof TextOutbound>;
