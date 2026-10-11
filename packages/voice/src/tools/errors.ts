import { BookingError } from "@platypus/shared/booking";
import { VoiceAuthorizationError } from "@platypus/shared/contracts";

/** The tool input did not match the contract. Carries a short field summary, never the raw input. */
export class VoiceToolInputError extends Error {
  constructor(public readonly fields: string[]) {
    super(`Invalid input: ${fields.join(", ") || "unreadable arguments"}`);
    this.name = "VoiceToolInputError";
  }
}

export type VoiceToolFailureCode =
  | "unauthorized"
  | "wrong_business"
  | "not_outbound"
  | "invalid_input"
  | BookingError["code"]
  | "internal";

/**
 * A stable code for every way a tool can fail. It goes into the voice.tool_called
 * event and picks the sentence the voice agent hears (see spokenError).
 */
export function failureCode(error: unknown): VoiceToolFailureCode {
  if (error instanceof VoiceAuthorizationError) {
    if (/different business/i.test(error.message)) return "wrong_business";
    if (/outbound/i.test(error.message)) return "not_outbound";
    return "unauthorized";
  }
  if (error instanceof BookingError) return error.code;
  if (error instanceof VoiceToolInputError) return "invalid_input";
  return "internal";
}
