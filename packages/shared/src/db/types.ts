/**
 * Row shapes for every table, in the same snake_case the SQL and the MCP
 * contracts use, so a value never changes name between the wire and the disk.
 * JSON columns are decoded and booleans are real booleans.
 */

export const CHANNEL_STATES = ["phone_only", "text_enabled", "paused", "unlisted"] as const;
export type ChannelState = (typeof CHANNEL_STATES)[number];

export const MESSAGE_CHANNELS = ["sms", "imessage", "whatsapp", "dial"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const BOOKING_STATUSES = [
  "quote_pending",
  "quoted",
  "pending",
  "countered",
  "confirmed",
  "rescheduled",
  "completed",
  "no_show",
  "disputed",
  "declined",
  "expired",
  "cancelled",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_ROUTES = ["darwin_act", "call", "text"] as const;
export type BookingRoute = (typeof BOOKING_ROUTES)[number];

export const HOLD_STATUSES = ["active", "converted", "released", "expired"] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export interface ServiceOffering {
  name: string;
  typical_price_cents: [number, number];
  duration_minutes: number;
}

export interface Business {
  id: string;
  slug: string;
  display_name: string;
  trade: string;
  phone_e164: string;
  phone_is_real: boolean;
  text_number_e164: string | null;
  short_code_prefix: string;
  services: ServiceOffering[];
  address: string | null;
  service_area: string | null;
  hours: Record<string, string>;
  timezone: string;
  channel_state: ChannelState;
  channel_pref: Exclude<MessageChannel, "sms"> | null;
  do_not_call: boolean;
  created_at: string;
  updated_at: string;
}

export type ConfirmationEvidence =
  | { kind: "call"; callId: string; quotedSentence: string }
  | { kind: "text"; messageId: string }
  | { kind: "rule"; ruleId: string };

export interface Booking {
  id: string;
  business_id: string;
  agent_id: string;
  platform_id: string | null;
  service: string;
  details: string | null;
  window_start: string | null;
  window_end: string | null;
  slot_start: string | null;
  slot_end: string | null;
  price_cents: number | null;
  status: BookingStatus;
  route: BookingRoute | null;
  short_code: string;
  quote_id: string | null;
  requested_by: string | null;
  notes: string | null;
  confirmation_evidence: ConfirmationEvidence | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Hold {
  id: string;
  business_id: string;
  booking_id: string | null;
  slot_start: string;
  slot_end: string;
  status: HoldStatus;
  expires_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TranscriptTurn {
  speaker: "agent" | "user" | "transfer_target";
  text: string;
  startMs: number;
  endMs: number;
}

export interface Call {
  id: string;
  business_id: string;
  booking_id: string | null;
  dial_call_id: string | null;
  direction: "outbound" | "inbound";
  to_e164: string;
  status: string;
  script_version: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  end_reason: string | null;
  transcript: string | null;
  transcript_turns: TranscriptTurn[] | null;
  mined: Record<string, unknown> | null;
  friction_score: number | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  business_id: string | null;
  booking_id: string | null;
  direction: "inbound" | "outbound";
  channel: MessageChannel;
  from_e164: string;
  to_e164: string;
  body: string;
  provider_message_id: string | null;
  status: string | null;
  reply_class: string | null;
  classification: Record<string, unknown> | null;
  created_at: string;
}

export interface Consent {
  id: string;
  business_id: string;
  channel: MessageChannel;
  source: "call" | "join_text";
  quoted_sentence: string | null;
  call_id: string | null;
  transcript_turn_ref: string | null;
  message_id: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface Rule {
  id: string;
  business_id: string;
  source_text: string;
  compiled_policy: Record<string, unknown>;
  status: "draft" | "active" | "paused" | "retired";
  version: number;
  confirmed_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: string;
  type: string;
  actor: string;
  business_id: string | null;
  booking_id: string | null;
  call_id: string | null;
  message_id: string | null;
  consent_id: string | null;
  hold_id: string | null;
  payload: Record<string, unknown>;
  reason: string | null;
  confidence: number;
  created_at: string;
}

export interface TableRows {
  businesses: Business;
  bookings: Booking;
  holds: Hold;
  calls: Call;
  messages: Message;
  consents: Consent;
  rules: Rule;
  events: EventRow;
}
export type TableName = keyof TableRows;
