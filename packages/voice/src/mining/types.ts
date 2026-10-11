export const FINDING_KINDS = [
  "price",
  "slot_time",
  "lead_time",
  "hours",
  "consent_sentence",
  "owner_name",
  "text_number",
  "do_not_call",
  "voicemail",
  "asked_if_ai",
  "wrong_number",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/**
 * One fact the owner said, with the words that prove it. A finding is evidence
 * for the dashboard and for routing; it is never a confirmation (non-negotiable 1).
 *
 * value: price = cents; slot_time = "HH:MM" 24-hour; lead_time = minutes;
 * consent_sentence = "yes" | "no" | "unclear"; text_number = "this_line" or a
 * masked number; flags (do_not_call, voicemail, asked_if_ai, wrong_number) = true.
 */
export interface Finding {
  kind: FindingKind;
  value: string | number | boolean;
  quote: string;
  turnIndex: number;
  confidence: number;
  method: "deterministic" | "claude";
}
