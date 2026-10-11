/**
 * The non-negotiables as machine-checkable invariants over the append-only event log.
 * Each rule names the non-negotiables (context: README "Non-negotiables") it enforces.
 */

export const AUDIT_RULE_IDS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"] as const;
export type AuditRuleId = (typeof AUDIT_RULE_IDS)[number];

export interface AuditRule {
  id: AuditRuleId;
  /** One line, for the report. */
  title: string;
  /** The non-negotiables (1-9) this rule checks. */
  non_negotiables: readonly number[];
  /** What exactly is checked, in plain words. */
  checks: string;
}

export const AUDIT_RULES: Readonly<Record<AuditRuleId, AuditRule>> = {
  R1: {
    id: "R1",
    title: "A booking is confirmed only by the owner's yes",
    non_negotiables: [1],
    checks:
      "Every booking.confirmed carries evidence of kind call, text or rule. Call evidence: the booking was held (hold.placed) and agreed through the tools (booking.slot_agreed) on a live call with the same business, and the owner's words are quoted. Text evidence: an earlier message.received from the same business that reply.classified as accept. Never confirmed twice, never after declined, cancelled or expired.",
  },
  R2: {
    id: "R2",
    title: "Every call opens with the AI disclosure",
    non_negotiables: [2],
    checks:
      "The first agent turn of every call.transcribed starts with the hard-coded disclosure. A call that missed it must have been flagged with call.disclosure_missing; a call.disclosure_verified on a call that missed it is an error.",
  },
  R3: {
    id: "R3",
    title: "No message without consent",
    non_negotiables: [3],
    checks:
      "Every message.sent to a business follows a consent.recorded for that business that has not been revoked (consent.revoked) before the send. The one-time STOP confirmation and HELP replies are the only messages allowed without consent.",
  },
  R4: {
    id: "R4",
    title: "One live call per business, no blind retries, do-not-call honored",
    non_negotiables: [4],
    checks:
      "call.placed..call.ended windows never overlap for one business. No new call while an earlier placement is unknown and unreconciled (that would be a blind retry). No call after call.do_not_call for that business.",
  },
  R5: {
    id: "R5",
    title: "Every event is well formed and every transition is legal",
    non_negotiables: [7],
    checks:
      "Every event has a known actor, a confidence in [0, 1] and an id strictly greater than the one before it. State transitions carry a reason. Booking transitions follow TRANSITIONS from the booking state machine.",
  },
  R6: {
    id: "R6",
    title: "No sms to non-Dial numbers",
    non_negotiables: [8],
    checks: 'No message.sent with channel "sms" unless it is flagged dial_to_dial (a Dial number texting a Dial number).',
  },
  R7: {
    id: "R7",
    title: "No double booking",
    non_negotiables: [1],
    checks:
      "Active holds never overlap for one business (from hold.placed, converted, released and expired), a hold never overlaps a confirmed booking, and two confirmed bookings of one business never overlap.",
  },
  R8: {
    id: "R8",
    title: "A transcript is never a confirmation",
    non_negotiables: [1],
    checks:
      "A booking with transcript.mined or booking.transcript_candidate findings is confirmed only through the call tools (hold and slot agreed) or by text. Evidence derived from a transcript is never accepted.",
  },
};
