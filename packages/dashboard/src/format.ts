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
  if (event.type === "darwin.searched") return summarizeDarwin(p, pick);
  if (event.type === "call.status_changed") return `${pick("from")} to ${pick("to")}`;
  if (event.type === "consent.recorded") return `"${pick("quoted_sentence")}"`;
  if (event.type.startsWith("message.")) return pick("body") ?? "";
  if (event.type === "business.listed") return pick("display_name") ?? "";
  return "";
}

/** Darwin's answer in the words the demo uses. Says "cached" whenever it is not a new search. */
function summarizeDarwin(p: Record<string, unknown>, pick: (k: string) => string | undefined): string {
  const agents = Array.isArray(p.agents) ? (p.agents as Array<{ can_start_thread?: unknown }>) : [];
  const ready = agents.filter((a) => a.can_start_thread === true).length;
  const suffix = [p.cached === true && "cached", p.timed_out === true && "timed out"].filter(Boolean).join(", ");
  const tail = suffix ? ` (${suffix})` : "";
  if (pick("outcome") === "listed_only" || (pick("status") === "completed" && agents.length > 0 && ready === 0)) {
    return `no ready agent · ${agents.length} listed, none can start${tail}`;
  }
  if (pick("outcome") === "startable" || ready > 0) return `ready agent found${tail}`;
  if (pick("status") === "needs_input") return `Darwin asked for more input${tail}`;
  if (pick("status") === "no_match") return `no match${tail}`;
  if (pick("status") === "disabled") return "Darwin switched off";
  return `status ${pick("status")}${pick("http_status") ? ` (HTTP ${pick("http_status")})` : ""}${tail}`;
}
