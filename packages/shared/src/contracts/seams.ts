import type { Hono } from "hono";
import type { Db } from "../db/repo";
import type { EventBus } from "../events/bus";

/**
 * The only places the phone side and the agent side meet in code (docs/workstreams.md).
 * Each side implements its half against these types and never edits the other's package;
 * `pnpm dev` plugs both into one process, so one database and one event bus serve everything.
 */

export interface SideDeps {
  db: Db;
  bus: EventBus;
}

/**
 * How the gateway reaches an owner after request_booking picks a route. The phone side
 * implements it for real (call script, Dial, number lookup, consent check, message copy);
 * the agent side fakes it over FakeDial. Both return once the work has started: progress
 * arrives as events, and only the phone side ever confirms a booking.
 */
export interface OwnerChannels {
  /** Route "call": place the one onboarding call for a pending booking. Never retries blindly. */
  startOnboardingCall(input: { booking_id: string; business_id: string }): Promise<{ call_id: string }>;
  /** Route "text": send the request to an owner who opted in, or say why a call is needed instead. */
  sendBookingRequest(
    input: { booking_id: string; business_id: string },
  ): Promise<{ message_id: string } | { needs_call: true; reason: string }>;
}

/** Exported by @platypus/voice (packages/voice/src/index.ts). Owner: phone side. */
export interface PhoneSide {
  /** Dial webhooks, the Context MCP server and every other phone-side route. */
  mount(app: Hono, deps: SideDeps): void;
  createOwnerChannels(deps: SideDeps): OwnerChannels;
}

/** Exported by @platypus/gateway (packages/gateway/src/index.ts). Owner: agent side. */
export interface AgentSide {
  /** The gateway MCP server over streamable HTTP at /mcp. `owner` is absent until DIAL_IMPL=real. */
  mount(app: Hono, deps: SideDeps & { owner?: OwnerChannels }): void;
}
