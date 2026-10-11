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
