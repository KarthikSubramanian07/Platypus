import type { VoiceToolName } from "../contracts/voice";
import { addMinutes, localDate, zonedTime } from "./time";

export interface ScriptState {
  business_id: string;
  called_number: string;
  slots?: { start: string; end: string }[];
  hold_id?: string;
  booking_id?: string;
  short_code?: string;
  consent_id?: string;
}

export type CallScriptStep =
  | { kind: "turn"; atMs: number; speaker: "agent" | "user"; text: string; durationMs: number }
  | { kind: "tool"; atMs: number; tool: VoiceToolName; input: (s: ScriptState) => unknown; save?: (output: never, s: ScriptState) => void };

/** The disclosure is hard-coded: it is the first thing said on every call (non-negotiable 2). */
export const DISCLOSURE = "Hi, this is an AI assistant calling on behalf of a customer's agent through Platypus.";

export interface GoldenCallOptions {
  now: Date;
  businessName?: string;
  ownerName?: string;
  timeZone?: string;
}

/**
 * The demo call from the Demo Script, beat for beat, with the mid-call tool calls
 * where the voice agent makes them. About 70 seconds end to end.
 */
export function goldenCallScript({ now, businessName = "Sal's Auto", ownerName = "Eddy", timeZone = "America/Los_Angeles" }: GoldenCallOptions): CallScriptStep[] {
  const tomorrow = localDate(now, timeZone, 1);
  const windowStart = zonedTime(tomorrow, 12, 0, timeZone).toISOString();
  const windowEnd = zonedTime(tomorrow, 17, 0, timeZone).toISOString();
  const twoPm = zonedTime(tomorrow, 14, 0, timeZone);
  return [
    { kind: "turn", atMs: 1_200, speaker: "agent", text: `${DISCLOSURE} Is this ${businessName}?`, durationMs: 5_200 },
    { kind: "turn", atMs: 7_000, speaker: "user", text: "It is.", durationMs: 800 },
    { kind: "turn", atMs: 8_600, speaker: "agent", text: "A customer needs an oil change tomorrow afternoon. Do you have an opening, and what's the price?", durationMs: 5_400 },
    { kind: "turn", atMs: 15_100, speaker: "user", text: "Two o'clock works. Eighty-nine bucks.", durationMs: 2_400 },
    {
      kind: "tool",
      atMs: 18_000,
      tool: "check_slot",
      input: (s) => ({ business_id: s.business_id, window: { start: windowStart, end: windowEnd } }),
      save: (o: { slots: ScriptState["slots"] }, s) => {
        s.slots = o.slots;
      },
    },
    {
      kind: "tool",
      atMs: 19_500,
      tool: "hold_slot",
      input: (s) => ({ business_id: s.business_id, slot: { start: twoPm.toISOString(), end: addMinutes(twoPm, 45).toISOString() } }),
      save: (o: { hold_id: string }, s) => {
        s.hold_id = o.hold_id;
      },
    },
    { kind: "turn", atMs: 20_200, speaker: "agent", text: "Tomorrow at 2pm for eighty-nine dollars. I'll book that. Can I confirm it's a 2019 Civic?", durationMs: 5_600 },
    { kind: "turn", atMs: 26_600, speaker: "user", text: "Yep, booked.", durationMs: 1_100 },
    {
      kind: "tool",
      atMs: 28_400,
      tool: "create_booking",
      input: (s) => ({ hold_id: s.hold_id, price_cents: 8900, verbal_confirmation: "Yep, booked." }),
      save: (o: { booking_id: string; short_code: string }, s) => {
        s.booking_id = o.booking_id;
        s.short_code = o.short_code;
      },
    },
    {
      kind: "turn",
      atMs: 29_300,
      speaker: "agent",
      text: "Booked. Last thing. Next time a customer's agent needs you, can I text you instead of calling? Just a yes or no.",
      durationMs: 6_800,
    },
    { kind: "turn", atMs: 37_400, speaker: "user", text: "Yeah, text me.", durationMs: 1_200 },
    {
      kind: "tool",
      atMs: 39_100,
      tool: "record_consent",
      input: (s) => ({ business_id: s.business_id, channel: "sms", quote: "Yeah, text me." }),
      save: (o: { consent_id: string }, s) => {
        s.consent_id = o.consent_id;
      },
    },
    { kind: "turn", atMs: 39_800, speaker: "agent", text: "Perfect. What's the best cell to text?", durationMs: 2_300 },
    { kind: "turn", atMs: 43_000, speaker: "user", text: "This one.", durationMs: 900 },
    { kind: "tool", atMs: 44_500, tool: "set_text_number", input: (s) => ({ business_id: s.business_id, e164: s.called_number }) },
    { kind: "turn", atMs: 45_100, speaker: "agent", text: `Got it, this number. Thanks, ${ownerName}.`, durationMs: 2_400 },
  ];
}

export const GOLDEN_CALL_END_MS = 49_000;
