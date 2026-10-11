import type { DarwinLookup } from "@platypus/shared/darwin";
import type { BookingRoute, Business } from "@platypus/shared/db";

export interface RouteDecision {
  /** null means Platypus must not contact this business at all. */
  route: BookingRoute | null;
  reason: string;
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

  if (darwin?.outcome === "startable" && darwin.candidate) {
    if (canAct) return { route: "darwin_act", reason: `Darwin can start a thread with ${darwin.candidate.agentId}` };
  }

  if (business.channel_state === "paused" || business.channel_state === "unlisted") {
    return { route: null, reason: `business is ${business.channel_state}` };
  }
  if (business.channel_state === "text_enabled") {
    return { route: "text", reason: `${whyNotDarwin(darwin, canAct)}; owner opted in to texts` };
  }
  if (business.do_not_call) return { route: null, reason: "business is phone-only and marked do-not-call" };
  return { route: "call", reason: `${whyNotDarwin(darwin, canAct)}; business is phone-only` };
}

function whyNotDarwin(darwin: DarwinLookup | null, canAct: boolean): string {
  if (!darwin) return "Darwin not consulted";
  switch (darwin.outcome) {
    case "startable":
      return canAct ? "Darwin route available" : "Darwin has a startable agent but DARWIN_ACT_TOKEN is not set";
    case "listed_only":
      return "Darwin lists agents but none can start a thread";
    case "needs_input":
      return "Darwin needs more input";
    case "no_match":
      return "Darwin has no match";
    case "unavailable":
      return "Darwin unavailable";
  }
}
