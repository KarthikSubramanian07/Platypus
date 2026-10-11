import type { DarwinLookup } from "@platypus/shared/darwin";
import type { BookingRoute, Business } from "@platypus/shared/db";

export interface RouteDecision {
  /** null means Platypus must not contact this business at all. */
  route: BookingRoute | null;
  /** request_booking's `reasons` and booking.pending's `routing_reasons`. */
  reasons: string[];
}

/**
 * The request_booking route decision. Darwin Act is used only when Darwin itself
 * says a result can start a thread and Platypus holds a pilot credential; every
 * other case is Platypus's own rail: text if the owner opted in, otherwise a call.
 */
export function decideBookingRoute(input: {
  business: Pick<Business, "channel_state" | "do_not_call">;
  darwin: DarwinLookup | null;
  canAct: boolean;
}): RouteDecision {
  const { business, darwin, canAct } = input;
  const darwinReason = whyNotDarwin(darwin, canAct);
  if (darwinReason === null) return { route: "darwin_act", reasons: [`Darwin can start a thread with ${darwin!.candidate!.agentId}`] };

  if (business.channel_state === "paused" || business.channel_state === "unlisted") {
    return { route: null, reasons: [darwinReason, `business is ${business.channel_state}`] };
  }
  if (business.channel_state === "text_enabled") return { route: "text", reasons: [darwinReason, "owner opted in to texts"] };
  if (business.do_not_call) return { route: null, reasons: [darwinReason, "no text consent on record", "business is marked do-not-call"] };
  return { route: "call", reasons: [darwinReason, "no text consent on record"] };
}

/** null when Darwin Act should take the booking. */
function whyNotDarwin(darwin: DarwinLookup | null, canAct: boolean): string | null {
  if (!darwin) return "Darwin not consulted";
  switch (darwin.outcome) {
    case "startable":
      return canAct && darwin.candidate ? null : "Darwin has a ready agent but DARWIN_ACT_TOKEN is not set";
    case "listed_only":
      return "Darwin returned no ready agent";
    case "needs_input":
      return "Darwin asked for more input";
    case "no_match":
      return "Darwin has no match";
    case "unavailable":
      return "Darwin unavailable";
  }
}
