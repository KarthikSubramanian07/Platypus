import type { BookingStatus } from "../db/types";

/**
 * The booking state machine from spec B.5.4. Two additions, both recorded in
 * DECISIONS.md: `cancelled` is a real state (cancel_booking needs somewhere to
 * land), and pending/quote_pending/quoted/rescheduled may be cancelled by the
 * requesting agent.
 *
 * Entering `confirmed` is listed here for completeness, but transition() refuses
 * it: only confirm() may set it, and only with evidence (non-negotiable 1).
 */
export const TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  quote_pending: ["quoted", "declined", "expired", "cancelled"],
  quoted: ["pending", "expired", "cancelled"],
  pending: ["confirmed", "countered", "declined", "expired", "cancelled"],
  countered: ["confirmed", "cancelled", "expired"],
  confirmed: ["rescheduled", "cancelled", "completed", "no_show", "disputed"],
  rescheduled: ["confirmed", "cancelled"],
  completed: [],
  no_show: [],
  disputed: [],
  declined: [],
  expired: [],
  cancelled: [],
};

export const TERMINAL_STATUSES: readonly BookingStatus[] = (Object.keys(TRANSITIONS) as BookingStatus[]).filter(
  (s) => TRANSITIONS[s].length === 0,
);

/** States from which confirm() may run. */
export const CONFIRMABLE_STATUSES: readonly BookingStatus[] = (Object.keys(TRANSITIONS) as BookingStatus[]).filter((s) =>
  TRANSITIONS[s].includes("confirmed"),
);

/** States that occupy the calendar (used for double-booking checks). */
export const OCCUPYING_STATUSES: readonly BookingStatus[] = ["confirmed", "rescheduled"];

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
