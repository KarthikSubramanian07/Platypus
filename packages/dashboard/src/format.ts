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
