import { formatMoney, SHOP_TIME_ZONE } from "./format";
import { currentCall, type AskView, type BookingView, type CallView, type DarwinView, type DashboardState, type TranscriptTurn } from "./state";

/**
 * The words /live puts on screen, as pure functions of DashboardState so they are
 * tested like the reducer. Nothing here invents a fact the events did not carry.
 */

export type PhoneScreen = "lock" | "incoming" | "call" | "ended" | "messages";

/**
 * What the owner's phone shows. A live call always wins; otherwise the text thread
 * once there is one (or the recording knows a text is about to land); otherwise the
 * end of the last call; otherwise the lock screen.
 */
export function phoneScreen(state: DashboardState, { textComing = false }: { textComing?: boolean } = {}): PhoneScreen {
  const call = currentCall(state);
  if (call && (call.state === "Queued" || call.state === "Ringing")) return "incoming";
  if (call?.state === "In-Progress") return "call";
  if (state.messages.length || textComing) return "messages";
  if (call) return "ended";
  return "lock";
}

/** The turns the owner has heard by `elapsedMs` into the call. */
export function captionsAt(turns: readonly TranscriptTurn[], elapsedMs: number): TranscriptTurn[] {
  return mergeTurns(turns.filter((t) => (t.startMs ?? 0) <= elapsedMs));
}

/** Most captions the phone keeps; a long call scrolls, it does not grow without end. */
export const MAX_CAPTIONS = 8;

/**
 * Real calls are messy: both sides talk over the disclosure, and speech-to-text splits a
 * sentence into fragments ("Yeah", "yeah,", "text me."). For captions, consecutive turns
 * by the same speaker become one line, turns are ordered by when they started (so an
 * overlap reads in the order it was said), and only the most recent lines are kept.
 */
export function mergeTurns(turns: readonly TranscriptTurn[], max = MAX_CAPTIONS): TranscriptTurn[] {
  const ordered = [...turns].sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
  const merged: TranscriptTurn[] = [];
  for (const turn of ordered) {
    const text = turn.text.trim();
    if (!text) continue;
    const last = merged.at(-1);
    if (last && last.speaker === turn.speaker) {
      merged[merged.length - 1] = { ...last, text: `${last.text} ${text}`, ...(turn.endMs !== undefined ? { endMs: turn.endMs } : {}) };
    } else merged.push({ ...turn, text });
  }
  return merged.slice(-max);
}

/** The owner text rail the events show: the first text's channel, else the rail consent switched a shop to. */
export function railOf(state: DashboardState): string | undefined {
  const rail = state.messages[0]?.channel ?? state.businessOrder.map((id) => state.businesses[id]?.rail).find(Boolean);
  return rail?.toLowerCase();
}

/** The phone's caption. On the dial rail a Dial number plays the shop's line; otherwise it is the owner's own phone. */
export function phoneLabel(rail: string | undefined): string {
  return rail === "dial" ? "Eddy's Auto line · Dial-to-Dial" : "Eddy's Auto · the owner's phone";
}

/** One line on what Darwin said, for the first story card. */
export function darwinSummary(d: DarwinView | undefined, reasons: readonly string[] = []): string | undefined {
  if (!d) return reasons.some((r) => /darwin not consulted/i.test(r)) ? "Darwin not consulted" : undefined;
  const recorded = d.provenance === "recorded" ? ", recorded" : d.cached ? ", cached" : "";
  switch (d.status) {
    case "error":
      return `Darwin unavailable${d.httpStatus !== undefined ? ` (HTTP ${d.httpStatus})` : ""}${recorded}`;
    case "no_match":
      return `Darwin: no agent covers this${recorded}`;
    case "needs_input":
      return d.question ? `Darwin asked: “${d.question}”` : `Darwin needs more detail${recorded}`;
    case "disabled":
      return "Darwin not consulted";
    case "completed": {
      const ready = d.agents.find((a) => a.id === d.candidateAgentId || a.canStartThread);
      if (ready) return `Darwin: ${ready.name ?? ready.id} can take it${recorded}`;
      if (!d.agents.length) return `Darwin: no agent covers this${recorded}`;
      return `Darwin: ${d.agents.length} agent${d.agents.length === 1 ? "" : "s"} listed, none can book${recorded}`;
    }
    default:
      return `Darwin answered “${d.rawStatus ?? "unknown"}”`;
  }
}

/** "Mon 12 to 5 PM" for a request window, in shop time; "Tue 10 AM to Thu 5 PM" across days. */
export function formatWindow(start: string | undefined, end: string | undefined): string | undefined {
  if (!start || Number.isNaN(Date.parse(start))) return undefined;
  const fmt = (iso: string, parts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString("en-US", { ...parts, timeZone: SHOP_TIME_ZONE });
  const day = (iso: string) => fmt(iso, { weekday: "short" });
  const time = (iso: string) => fmt(iso, { hour: "numeric", minute: "2-digit" }).replace(":00", "");
  if (!end || Number.isNaN(Date.parse(end))) return `${day(start)} ${time(start)}`;
  const date = (iso: string) => fmt(iso, { year: "numeric", month: "numeric", day: "numeric" });
  if (date(start) !== date(end)) return `${day(start)} ${time(start)} to ${day(end)} ${time(end)}`;
  const [a, b] = [time(start), time(end)];
  return `${day(start)} ${a.slice(-2) === b.slice(-2) ? a.slice(0, -3) : a} to ${b}`;
}

/** The request as a short list: service, budget, window, place. */
export function askFacts(ask: AskView | undefined): string[] {
  if (!ask) return [];
  const place = ask.location?.split(",")[0];
  return [ask.service, ask.budgetCents !== undefined ? `under ${formatMoney(ask.budgetCents)}` : undefined, formatWindow(ask.windowStart, ask.windowEnd), place].filter(
    (x): x is string => Boolean(x),
  );
}

/** Milliseconds since the owner picked up, on the given clock. */
export function callElapsedMs(call: CallView | undefined, nowMs: number): number {
  if (!call?.inProgressAt) return 0;
  const end = call.endedAt ? Date.parse(call.endedAt) : nowMs;
  return Math.max(0, end - Date.parse(call.inProgressAt));
}

export const FINAL_LINE = "Booked twice. One call. Agent-native forever.";

/**
 * The booking that answered the agent's current ask: the first one created at or after
 * it. Card 1 shows its route, so the second request (routed by text) never relabels
 * the first.
 */
export function bookingForAsk(state: DashboardState): BookingView | undefined {
  const ordered = state.bookingOrder.map((id) => state.bookings[id]!);
  if (!state.ask) return ordered[0];
  const asked = Date.parse(state.ask.at);
  return ordered.find((b) => Date.parse(b.createdAt) >= asked) ?? ordered.at(-1);
}
