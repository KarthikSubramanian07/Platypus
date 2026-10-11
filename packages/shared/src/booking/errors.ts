import type { BookingStatus } from "../db/types";

export class BookingError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "invalid_transition"
      | "confirm_requires_evidence"
      | "invalid_evidence"
      | "slot_unavailable"
      | "hold_not_active"
      | "invalid_slot",
    message: string,
  ) {
    super(message);
    this.name = "BookingError";
  }
}

export class InvalidTransitionError extends BookingError {
  constructor(
    public readonly from: BookingStatus,
    public readonly to: BookingStatus,
  ) {
    super("invalid_transition", `A booking cannot move from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}
