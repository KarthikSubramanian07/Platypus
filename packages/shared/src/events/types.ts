export const EVENT_ACTORS = ["agent", "owner", "autopilot", "voice", "system"] as const;
export type EventActor = (typeof EVENT_ACTORS)[number];

export const ENTITY_REFS = ["business_id", "booking_id", "call_id", "message_id", "consent_id", "hold_id"] as const;
export type EntityRefName = (typeof ENTITY_REFS)[number];
export type EntityRefs = Partial<Record<EntityRefName, string>>;

/**
 * One entry in the append-only log. Every state transition in Platypus is one
 * of these, with who did it (actor), why (reason) and how sure we are (confidence).
 */
export interface PlatypusEvent<P extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  type: string;
  actor: EventActor;
  refs: EntityRefs;
  payload: P;
  reason: string | null;
  confidence: number;
  created_at: string;
}

export interface EmitInput<P extends Record<string, unknown> = Record<string, unknown>> {
  type: string;
  actor: EventActor;
  refs?: EntityRefs;
  payload?: P;
  reason?: string;
  /** 0..1. Deterministic facts (a row was written, a webhook arrived) are 1. */
  confidence?: number;
}
