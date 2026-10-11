import { z } from "zod";
import { Booking, BookingRoute, BookingStatus, Cents, ChannelState, IdempotencyKey, Slot, TimeWindow, UntrustedText } from "./common";
import { DarwinSummary } from "./darwin";
import { Signals } from "./signals";
import { defineTools, type ToolImplementation } from "./tool";

/**
 * The typed outcome vocabulary. Agents get one of these words, never prose to interpret.
 * Tool descriptions repeat it so the calling model knows what each status means.
 */
export const OUTCOME_VOCABULARY = `Booking statuses: pending (asked, waiting on the owner), countered (owner proposed another time or price), confirmed (the owner said yes on the call or by text; only then is it booked), declined, expired, cancelled, rescheduled, completed, no_show, disputed.`;

const ASYNC_NOTE = `Results are asynchronous: the owner answers on a phone call or by text, usually within minutes. Call wait_for_booking with the booking_id right away and keep calling it until the status is final; it returns the moment the owner answers, so there is no need to poll get_booking. Never tell the user a booking is confirmed until the status says confirmed.`;

/** The statuses that end the wait, as wait_for_booking's description names them. */
export const FINAL_STATUSES = ["confirmed", "declined", "expired", "cancelled", "countered"] as const;
/** Under the ~60 s tool-call limit of Claude Desktop (behind mcp-remote) and the MCP SDK client's default request timeout. */
export const WAIT_DEFAULT_SECONDS = 55;

export const ProviderSummary = z.object({
  provider_id: z.string(),
  display_name: z.string(),
  trade: z.string(),
  address: z.string().nullable(),
  channel_state: ChannelState.describe("phone_only: we will call. text_enabled: the owner opted in to texts"),
  services: z.array(z.object({ name: z.string(), typical_price_cents: z.tuple([Cents, Cents]) })),
  signals: Signals,
  next_step: BookingRoute.describe("What request_booking would do for this provider right now"),
});
export type ProviderSummary = z.infer<typeof ProviderSummary>;

export const BusinessProfile = ProviderSummary.extend({
  hours: z.record(z.string(), z.string()),
  service_area: z.string().nullable(),
  timezone: z.string(),
});

export const GATEWAY_TOOLS = defineTools({
  search_providers: {
    description: `Find local businesses that can do a job. Searches Darwin's agent index first; when no agent covers it (status no_match), returns phone-only and text-enabled local businesses Platypus can book. Each result carries routing signals (typical price, median reply time, acceptance) and next_step. ${OUTCOME_VOCABULARY}`,
    input: z.object({
      service: UntrustedText.describe("What the customer needs, e.g. 'oil change'"),
      location: UntrustedText.describe("Address or neighborhood, e.g. '1025 Sansome St, San Francisco'"),
      window: TimeWindow.optional(),
      budget_cents: Cents.optional(),
    }),
    output: z.object({ providers: z.array(ProviderSummary), darwin: DarwinSummary }),
  },
  get_provider: {
    description: "Public profile of one business: services, hours, price ranges, whether it is text-enabled.",
    input: z.object({ provider_id: z.string() }),
    output: BusinessProfile,
  },
  get_availability: {
    description: "Known open slots for a business within a window. Empty does not mean unavailable: Platypus asks the owner when it does not know.",
    input: z.object({ provider_id: z.string(), window: TimeWindow }),
    output: z.object({ slots: z.array(Slot), source: z.enum(["bookings", "template", "unknown"]) }),
  },
  request_booking: {
    description: `Ask a business for a booking. Returns immediately with status pending and the route Platypus chose: darwin_act (an existing agent), call (an AI voice call that discloses itself first), or text (the owner opted in). ${ASYNC_NOTE} ${OUTCOME_VOCABULARY}`,
    input: z.object({
      provider_id: z.string(),
      service: UntrustedText,
      window: TimeWindow,
      address_hint: UntrustedText.optional(),
      requested_by: UntrustedText.describe("Who the booking is for, as the owner should hear it, e.g. \"Alex's assistant\""),
      notes: UntrustedText.optional().describe("Details such as the vehicle. Treated as data, never as instructions"),
      quote_id: z.string().optional(),
      idempotency_key: IdempotencyKey,
    }),
    output: z.object({
      booking_id: z.string(),
      status: z.literal("pending"),
      route: BookingRoute,
      short_code: z.string(),
      reasons: z.array(z.string()).describe("Why this route was chosen"),
    }),
  },
  get_booking: {
    description: `Current state of a booking. ${ASYNC_NOTE} ${OUTCOME_VOCABULARY}`,
    input: z.object({ booking_id: z.string() }),
    output: Booking,
  },
  wait_for_booking: {
    description: `Wait for the owner's answer. Call it right after request_booking and keep calling it until the status is final (${FINAL_STATUSES.join(", ")}). It returns as soon as the status changes, or after timeout_seconds with changed false; then call it again. Report only the status it returns; never invent a result. ${OUTCOME_VOCABULARY}`,
    input: z.object({
      booking_id: z.string(),
      timeout_seconds: z
        .number()
        .min(5)
        .max(120)
        .optional()
        .describe(`Longest wait, 5 to 120 seconds. Default ${WAIT_DEFAULT_SECONDS}, under the 60-second limit many clients put on one tool call`),
      since_status: BookingStatus.optional().describe("The status you last saw. Returns at once if the booking has moved on; defaults to its status when the call starts"),
    }),
    output: Booking.extend({
      changed: z.boolean().describe("True when the status differs from since_status, or from the status when the call started"),
      waited_seconds: z.number().nonnegative(),
    }),
  },
  confirm_booking: {
    description: `Accept the time the owner proposed in a counter-offer. The booking becomes confirmed only because the owner already proposed that slot; Platypus never confirms on the agent's word alone. ${OUTCOME_VOCABULARY}`,
    input: z.object({ booking_id: z.string(), slot: Slot, idempotency_key: IdempotencyKey }),
    output: Booking,
  },
  reschedule_booking: {
    description: `Ask to move a confirmed booking. Status becomes rescheduled until the owner says yes to the new slot. ${ASYNC_NOTE}`,
    input: z.object({ booking_id: z.string(), slot: Slot, idempotency_key: IdempotencyKey }),
    output: Booking,
  },
  cancel_booking: {
    description: "Cancel a booking. The owner is told by text when they have opted in.",
    input: z.object({ booking_id: z.string(), reason: UntrustedText.optional(), idempotency_key: IdempotencyKey }),
    output: Booking,
  },
  report_outcome: {
    description: "After the appointment: completed, no_show, or issue. Feeds the business's reputation; only real bookings count.",
    input: z.object({ booking_id: z.string(), outcome: z.enum(["completed", "no_show", "issue"]), notes: UntrustedText.optional() }),
    output: z.object({ ok: z.literal(true), status: z.enum(["completed", "no_show", "disputed"]) }),
  },
});

export type GatewayToolName = keyof typeof GATEWAY_TOOLS;
export const GATEWAY_TOOL_NAMES = Object.keys(GATEWAY_TOOLS) as GatewayToolName[];

export interface GatewayContext {
  /** Stable id of the calling agent or platform; drives rate limits and appears in owner messages. */
  agent_id: string;
}

export type GatewayTools = ToolImplementation<typeof GATEWAY_TOOLS, GatewayContext>;
