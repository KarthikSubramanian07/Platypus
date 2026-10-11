import { isStartable, type DarwinLookup } from "@platypus/shared/darwin";
import type { BookingRoute, Business } from "@platypus/shared/db";

export interface RouteDecision {
  /** null means Platypus must not contact this business at all. */
  route: BookingRoute | null;
  /** request_booking's `reasons` and booking.pending's `routing_reasons`. */
  reasons: string[];
}

/**
 * The request_booking route decision. Darwin Act is used only when Darwin itself
 * says a result is usable (ready, can start a thread, setup declared; see isStartable)
 * and Platypus holds a pilot credential. Every other case is Platypus's own rail:
 * text if the owner opted in, otherwise a call.
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

/** Ready and able to start, but with no declared setup: Darwin's guide reads that as unknown. */
function whyNotListed(darwin: DarwinLookup): string {
  return darwin.search?.response.agents.some((a) => a.readiness === "ready" && a.canStartThread)
    ? "Darwin has a ready agent, but its setup requirements are unknown"
    : "Darwin returned no ready agent";
}

/** null when Darwin Act should take the booking. */
function whyNotDarwin(darwin: DarwinLookup | null, canAct: boolean): string | null {
  if (!darwin) return "Darwin not consulted (DARWIN_ENABLED=false)";
  switch (darwin.outcome) {
    case "startable":
      // A candidate that fails Darwin's own checks is only listed.
      if (!darwin.candidate || !isStartable(darwin.candidate)) return whyNotListed(darwin);
      return canAct ? null : "Darwin has a ready agent but Darwin Act is not enabled";
    case "listed_only":
      return whyNotListed(darwin);
    case "needs_input":
      return "Darwin asked for more input";
    case "no_match":
      return "Darwin has no match";
    case "unavailable":
      return "Darwin unavailable";
  }
}
