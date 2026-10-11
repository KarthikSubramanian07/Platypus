import type { VoiceToolName } from "@platypus/shared/contracts";
import { failureCode, type VoiceToolFailureCode } from "../tools/errors";

/**
 * What the voice agent hears. Dial hands tool text to the voice model mid-call, and
 * it tends to read that text aloud, so a failure is one short sentence saying what
 * to do next and a success is just "OK.". Raw errors, SQL and stack traces never
 * reach the call.
 */
const SPOKEN: Record<VoiceToolFailureCode, string> = {
  unauthorized: "These tools only work on Platypus's live outbound call with this business, so do not retry and say the customer's agent will follow up.",
  not_outbound: "These tools only work on an outbound Platypus call, so do not retry and say the customer's agent will follow up.",
  wrong_business: "That business_id is not the business on this call, so retry once with the business_id from your instructions.",
  invalid_input: "Some details were missing or malformed, so check the tool's fields and try once more.",
  slot_unavailable: "That time is taken, so ask the owner for another time.",
  hold_not_active: "That hold expired, so call hold_slot again for the same time, then create_booking.",
  invalid_evidence: "The booking was not confirmed, so ask the owner to say yes again and call create_booking with their exact words.",
  confirm_requires_evidence: "The booking was not confirmed, so ask the owner to say yes again and call create_booking with their exact words.",
  invalid_transition: "That booking is already on the calendar, so do not book it again.",
  invalid_slot: "That time cannot be booked, so ask the owner for a start time that has not passed.",
  not_found: "No hold was found, so call hold_slot for the agreed time and use the hold_id it returns.",
  internal: "That did not go through on our side, so say the customer's agent will follow up to confirm.",
};

export function spokenError(error: unknown): string {
  return SPOKEN[failureCode(error)];
}

/**
 * The text of a successful tool call: "OK.", with nothing to read aloud. The full
 * output is in structuredContent; hold_slot also puts its hold_id in the text as
 * JSON, since create_booking needs it and a client may pass on only the text.
 */
export function describeResult(tool: VoiceToolName, output: Record<string, unknown>): string {
  return tool === "hold_slot" ? `OK.\n${JSON.stringify({ hold_id: output.hold_id })}` : "OK.";
}
