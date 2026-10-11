import { z } from "zod";
import { getBusiness, getLiveCallForNumber, type Db } from "../db/repo";
import type { Call } from "../db/types";
import { Cents, E164, IsoDateTime, MessageChannel, Slot, TimeWindow } from "./common";
import { defineTools, type ToolImplementation } from "./tool";

/**
 * Tools the Dial voice agent calls during a live call through Context MCP.
 * Short descriptions on purpose: the voice model reads them mid-conversation.
 */
export const VOICE_TOOLS = defineTools({
  check_slot: {
    description: "Find open times for this business in a window. Call before offering or accepting a time.",
    input: z.object({ business_id: z.string(), window: TimeWindow }),
    output: z.object({ slots: z.array(Slot) }),
  },
  hold_slot: {
    description: "Hold the time the owner said for 10 minutes so nobody else takes it.",
    input: z.object({ business_id: z.string(), slot: Slot }),
    output: z.object({ hold_id: z.string(), expires_at: IsoDateTime }),
  },
  create_booking: {
    description:
      "Book the held time at the owner's price once the owner says yes. verbal_confirmation is the owner's exact words, e.g. 'Yep, booked.'",
    input: z.object({ hold_id: z.string(), price_cents: Cents, verbal_confirmation: z.string().min(1).max(500) }),
    output: z.object({ booking_id: z.string(), short_code: z.string() }),
  },
  record_consent: {
    description: "The owner agreed to be texted next time. quote is their exact words, e.g. 'Yeah, text me.'",
    input: z.object({ business_id: z.string(), channel: MessageChannel, quote: z.string().min(1).max(500) }),
    output: z.object({ consent_id: z.string() }),
  },
  set_text_number: {
    description: "Store the best cell to text. If the owner says 'this one', pass the number you are calling.",
    input: z.object({ business_id: z.string(), e164: E164 }),
    output: z.object({ ok: z.literal(true) }),
  },
});

export type VoiceToolName = keyof typeof VOICE_TOOLS;
export const VOICE_TOOL_NAMES = Object.keys(VOICE_TOOLS) as VoiceToolName[];

/** Per-request identity, from the X-Dial-* headers Dial adds to every Context MCP request. */
export interface VoiceToolContext {
  caller_number: string;
  direction: "outbound" | "inbound";
  agent_number?: string;
}

export type VoiceTools = ToolImplementation<typeof VOICE_TOOLS, VoiceToolContext>;

export class VoiceAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceAuthorizationError";
  }
}

/**
 * Context MCP connections are account-wide, so every request is authorized on its
 * own: there must be a live call with X-Dial-User-Number, and it must be with the
 * business the tool names. Returns the live call. Both the fake and the real
 * gateway call this before doing anything.
 */
export function authorizeVoiceRequest(db: Db, ctx: VoiceToolContext, businessId: string | undefined): Call {
  if (!ctx.caller_number) throw new VoiceAuthorizationError("Missing X-Dial-User-Number");
  const call = getLiveCallForNumber(db, ctx.caller_number);
  if (!call) throw new VoiceAuthorizationError("No live call with this number");
  if (businessId !== undefined && call.business_id !== businessId) {
    throw new VoiceAuthorizationError("The live call is with a different business");
  }
  if (!getBusiness(db, call.business_id)) throw new VoiceAuthorizationError("Unknown business on the live call");
  return call;
}
