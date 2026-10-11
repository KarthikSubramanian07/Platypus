import { isE164 } from "@platypus/shared/config";
import { DIAL_HEADERS, type VoiceToolContext } from "@platypus/shared/contracts";

/** Dial's discovery connection can send unexpanded templates such as "{{user_number}}". */
const TEMPLATE = /\{\{.*\}\}/;

function header(headers: Headers | undefined, name: string): string | undefined {
  const value = headers?.get(name)?.trim();
  if (!value || TEMPLATE.test(value)) return undefined;
  return value;
}

/**
 * Reads Dial's per-request identity from the X-Dial-* headers.
 *
 * X-Dial-User-Number is the other party: on an outbound call, the business we
 * called. Returns null when the number is absent, a literal template, or not
 * E.164, or when the direction is not "inbound" or "outbound". That is normal
 * on Dial's tool-discovery connection; tools/list works without it and every
 * tools/call is refused.
 */
export function readDialContext(headers: Headers | undefined): VoiceToolContext | null {
  const caller = header(headers, DIAL_HEADERS.userNumber);
  const direction = header(headers, DIAL_HEADERS.direction)?.toLowerCase();
  if (!caller || !isE164(caller)) return null;
  if (direction !== "outbound" && direction !== "inbound") return null;
  const agent = header(headers, DIAL_HEADERS.agentNumber);
  return { caller_number: caller, direction, ...(agent ? { agent_number: agent } : {}) };
}
