/** Minimal view of a Platypus event, as it arrives on /events/stream. */
export interface StreamEvent {
  id: string;
  type: string;
  actor: string;
  refs: Record<string, string>;
  payload: Record<string, unknown>;
  reason: string | null;
  confidence: number;
  created_at: string;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** The one-line detail shown under an event type: the most telling payload field. */
export function summarize(event: StreamEvent): string {
  const p = event.payload;
  const pick = (k: string) => (p[k] === undefined || p[k] === null ? undefined : String(p[k]));
  if (event.type === "voice.tool_called") return `${pick("tool")}${p.ok === false ? " (failed)" : ""}`;
  if (event.type === "agent.tool_called") return pick("tool") ?? "";
  if (event.type.startsWith("booking.")) return [pick("short_code"), pick("route"), pick("from") && `${pick("from")} to ${pick("to")}`].filter(Boolean).join(" · ");
  if (event.type === "darwin.searched") return `status ${pick("status")}${pick("http_status") ? ` (HTTP ${pick("http_status")})` : ""}`;
  if (event.type === "call.status_changed") return `${pick("from")} to ${pick("to")}`;
  if (event.type === "consent.recorded") return `"${pick("quoted_sentence")}"`;
  if (event.type.startsWith("message.")) return pick("body") ?? "";
  if (event.type === "business.listed") return pick("display_name") ?? "";
  return "";
}

/** The golden path as the audience follows it. Each step lights up when its event arrives. */
export const GOLDEN_STEPS = [
  { key: "ask", label: "Agent asks", caption: "A customer's agent asks Platypus for an oil change." },
  { key: "darwin", label: "Darwin search", caption: "Darwin is searched first, in case an agent already covers the job." },
  { key: "call", label: "Phone rings", caption: "No agent, no consent on record: Platypus calls the shop, and discloses it is an AI first." },
  { key: "tools", label: "Books mid-call", caption: "While the owner talks, the voice agent checks, holds and books the slot through Platypus tools." },
  { key: "consent", label: "“Yeah, text me.”", caption: "The owner agrees to texts. Consent is stored with the exact sentence and the call." },
  { key: "text", label: "Next job by text", caption: "Second request: no call. One text to the owner's cell." },
  { key: "confirmed", label: "Y confirms", caption: "The owner replies Y. Confirmed in seconds, because the owner said yes." },
] as const;

export type StepKey = (typeof GOLDEN_STEPS)[number]["key"];

/** Which golden-path step an event completes, if any. */
export function stepFor(event: StreamEvent): StepKey | undefined {
  const tool = event.payload.tool;
  if (event.type === "agent.tool_called" && tool === "search_providers") return "ask";
  if (event.type === "darwin.searched") return "darwin";
  if (event.type === "call.placed") return "call";
  if (event.type === "voice.tool_called" && tool === "create_booking" && event.payload.ok !== false) return "tools";
  if (event.type === "consent.recorded") return "consent";
  if (event.type === "message.sent") return "text";
  if (event.type === "booking.confirmed" && (event.payload.evidence as { kind?: string } | undefined)?.kind === "text") return "confirmed";
  return undefined;
}

/** Shops are in San Francisco, so slots are shown in the shop's time, not the viewer's. */
export const SHOP_TIME_ZONE = "America/Los_Angeles";

/** "$89", "$89.50"; undefined for a missing price. */
export function formatMoney(cents: number | null | undefined): string | undefined {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return undefined;
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars.toLocaleString("en-US") : dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A booking slot in shop time: "Mon 2:00 PM". */
export function formatSlot(iso: string | null | undefined, timeZone = SHOP_TIME_ZONE): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone });
}

/** A clock for durations: 7 -> "0:07", 125 -> "2:05". */
export function formatClock(totalSeconds: number): string {
  const s = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Transcript timing from the start of the call: 15100 -> "0:15". */
export function formatCallOffset(ms: number | undefined): string {
  return ms === undefined || !Number.isFinite(ms) ? "" : formatClock(ms / 1000);
}

/** Latency as people read it: 830 -> "830 ms", 8700 -> "8.70 s". */
export function formatLatency(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

const RAILS: Record<string, string> = { imessage: "iMessage", whatsapp: "WhatsApp", dial: "Dial", sms: "SMS" };

/** The owner's text rail as its product name. */
export function formatRail(rail: string | undefined): string | undefined {
  if (!rail) return undefined;
  return RAILS[rail.toLowerCase()] ?? rail;
}

/** "auto_repair" -> "Auto repair". */
export function formatTrade(trade: string | undefined): string {
  if (!trade) return "";
  const words = trade.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Two-letter initials for an avatar: "Sal's Auto" -> "SA". */
export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/**
 * Time-saved estimates shown on the page. Transparent assumptions, not measurements:
 * calling around costs 15 to 25 minutes of attention per booking (20 used here); with
 * Platypus it is 0.8 minutes (setup amortized, typing, review, and a correction on about
 * 1 in 5). For the owner, a 3 to 5 minute booking call (4 used) becomes a 5 to 10 second
 * text reply (10 used, the conservative end).
 */
export const TIME_SAVED = {
  customerBeforeMin: 20,
  customerAfterMin: 0.8,
  ownerCallMin: 4,
  ownerReplyMin: 10 / 60,
} as const;

/** Hours a customer gets back in a year, booking this many times a month. */
export function customerHoursPerYear(bookingsPerMonth: number): number {
  return Math.round((bookingsPerMonth * 12 * (TIME_SAVED.customerBeforeMin - TIME_SAVED.customerAfterMin)) / 60);
}

/** Hours an owner gets back in a year, receiving this many agent bookings a week. */
export function ownerHoursPerYear(bookingsPerWeek: number): number {
  return Math.round((bookingsPerWeek * 52 * (TIME_SAVED.ownerCallMin - TIME_SAVED.ownerReplyMin)) / 60);
}
