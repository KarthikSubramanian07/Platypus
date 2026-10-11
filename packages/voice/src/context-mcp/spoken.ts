import type { VoiceToolName } from "@platypus/shared/contracts";
import { speakableTime } from "../tools/business-hours";
import { failureCode, type VoiceToolFailureCode } from "../tools/errors";

/**
 * What the voice agent hears. Dial hands tool text to the voice model mid-call, so
 * every message is one or two short sentences that say what happened and what to
 * do next. Raw errors, SQL and stack traces never reach the call.
 */
const SPOKEN: Record<VoiceToolFailureCode, string> = {
  unauthorized: "These tools only work on Platypus's live outbound call with this business. Do not retry; tell the owner the customer's agent will follow up.",
  not_outbound: "These tools only work on an outbound Platypus call. Do not retry; tell the caller the customer's agent will follow up.",
  wrong_business: "That business_id is not the business on this call. Use the business_id from your instructions and try once more.",
  invalid_input: "Some details were missing or malformed. Check the tool's fields and try once more.",
  slot_unavailable: "That time is taken. Offer the next open slot from check_slot.",
  hold_not_active: "That hold expired. Call hold_slot again for the same time, then create_booking.",
  invalid_evidence: "The booking could not be confirmed. Ask the owner to say yes again, then call create_booking with their exact words.",
  confirm_requires_evidence: "The booking could not be confirmed. Ask the owner to say yes again, then call create_booking with their exact words.",
  invalid_transition: "That booking is already settled. Do not book it again; tell the owner it is already on the calendar.",
  invalid_slot: "That time does not work as a slot. Ask the owner for a start time that has not passed, then call hold_slot.",
  not_found: "I could not find that hold. Call hold_slot for the agreed time first, then create_booking with the hold_id it returns.",
  internal: "That did not go through on our side. Apologize briefly and say the customer's agent will follow up to confirm.",
};

export function spokenError(error: unknown): string {
  return SPOKEN[failureCode(error)];
}

export interface DescribeOptions {
  /** Zone for times read aloud. Every seeded business is in America/Los_Angeles. */
  timeZone: string;
}

/** One speakable sentence for a successful tool call. */
export function describeResult(tool: VoiceToolName, input: unknown, output: Record<string, unknown>, { timeZone }: DescribeOptions): string {
  switch (tool) {
    case "check_slot": {
      const slots = (output.slots as { start: string }[] | undefined) ?? [];
      if (slots.length === 0) return "No open times in that window. Ask the owner what time works, then call hold_slot with it.";
      const first = slots[0]!;
      const sameDay = (s: { start: string }) => speakableTime(s.start, timeZone).split(",")[0] === speakableTime(first.start, timeZone).split(",")[0];
      const rest = slots.slice(1, 4).map((s) => (sameDay(s) ? speakableTime(s.start, timeZone, false) : speakableTime(s.start, timeZone)));
      return `Open: ${[speakableTime(first.start, timeZone), ...rest].join("; ")}. Times the owner names are fine too if free; hold one with hold_slot.`;
    }
    case "hold_slot": {
      const slot = (input as { slot?: { start?: string } } | undefined)?.slot;
      const when = slot?.start ? speakableTime(slot.start, timeZone) : "that time";
      return `Held ${when} for 10 minutes. Once the owner agrees the price and says yes, call create_booking.`;
    }
    case "create_booking":
      return `Booked and confirmed. Reference ${String(output.short_code)}. Then ask whether we can text next time.`;
    case "record_consent":
      return "Saved: the owner agreed to texts. Ask for the best cell to text, and repeat it back.";
    case "set_text_number":
      return "Text number saved. Thank the owner and end the call.";
  }
}
