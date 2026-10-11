import { z } from "zod";
import { Cents } from "./common";

export const CLASSIFICATION_CLASSES = [
  "accept",
  "decline",
  "counter",
  "question",
  "rule_edit",
  "availability_update",
  "stop",
  "help",
  "pause",
  "unrelated",
] as const;

/** What an owner's reply means. Below the confidence threshold the text package asks the owner instead of guessing. */
export const Classification = z.object({
  class: z.enum(CLASSIFICATION_CLASSES),
  confidence: z.number().min(0).max(1),
  extracted: z
    .object({
      time: z.string().optional().describe("A time the owner proposed, as said (\"2pm\", \"tomorrow 3\") or ISO-8601"),
      price_cents: Cents.optional(),
    })
    .optional(),
});
export type Classification = z.infer<typeof Classification>;
