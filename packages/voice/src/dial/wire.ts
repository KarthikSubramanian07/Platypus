import { z } from "zod";

/**
 * Tolerant parsers for what Dial sends us. The shared contracts in
 * @platypus/shared/contracts/dial.ts describe the documented shapes; these accept
 * anything a newer Dial may add (new call states, channel "unknown", extra event
 * types, extra fields) so a vendor change never crashes a live call. Only the
 * fields this package reads are required.
 */

export const LIVE_STATES = ["Queued", "Ringing", "In-Progress"] as const;
export const isLiveState = (state: string | null | undefined): boolean => LIVE_STATES.includes(state as (typeof LIVE_STATES)[number]);

export const WireTranscriptTurn = z.looseObject({
  speaker: z.string(),
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
});

export const WireCall = z.looseObject({
  id: z.string(),
  from: z.string().nullish(),
  to: z.string().nullish(),
  direction: z.string().nullish(),
  phoneNumberId: z.string().nullish(),
  status: z.looseObject({
    state: z.string(),
    terminationType: z.string().nullish(),
    label: z.string().nullish(),
  }),
  duration: z.number().nullish(),
  transcript: z.string().nullish(),
  transcriptTurns: z.array(WireTranscriptTurn).nullish(),
  instruction: z.string().nullish(),
  createdAt: z.string().nullish(),
});
export type WireCall = z.infer<typeof WireCall>;

export const WireEnvelope = z.looseObject({
  id: z.string(),
  type: z.string(),
  createdAt: z.string().nullish(),
  data: z.record(z.string(), z.unknown()),
});
export type WireEnvelope = z.infer<typeof WireEnvelope>;

export const StatusChangedData = z.looseObject({
  callId: z.string(),
  direction: z.string().nullish(),
  to: z.string().nullish(),
  status: z.looseObject({ state: z.string(), label: z.string().nullish() }),
  previousState: z.string().nullish(),
  terminationType: z.string().nullish(),
});

export const CallEndedData = z.looseObject({
  callId: z.string(),
  direction: z.string().nullish(),
  to: z.string().nullish(),
  durationSeconds: z.number().nullish(),
  status: z.string(),
  canceled: z.boolean().nullish(),
  failureReason: z.string().nullish(),
  transcriptAvailable: z.boolean().nullish(),
});

export const CallTranscribedData = z.looseObject({ callId: z.string() });

/** The call object Dial wraps as {call: ...}; falls back to the bare object. */
export function unwrapCall(body: unknown): WireCall {
  const inner = body && typeof body === "object" && "call" in body ? (body as { call: unknown }).call : body;
  return WireCall.parse(inner);
}

export function unwrapCalls(body: unknown): WireCall[] {
  const inner = body && typeof body === "object" && "calls" in body ? (body as { calls: unknown }).calls : body;
  return z.array(WireCall).parse(inner);
}
