import { z } from "zod";
import { Cents } from "./common";

/** Routing signals for one business. Never fabricated: absent when unknown. */
export const Signals = z.object({
  typical_price_cents: Cents.optional(),
  median_reply_seconds: z.number().nonnegative().optional(),
  acceptance_rate: z.number().min(0).max(1).optional(),
  source: z.enum(["local"]).describe("Where the numbers came from: computed from the local event log"),
});
export type Signals = z.infer<typeof Signals>;
