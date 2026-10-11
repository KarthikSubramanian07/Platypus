import type { StepKey } from "./format";
import { currentCall, storyBookings, type DarwinView, type DashboardState, type MessageView } from "./state";
import type { PhoneScreen } from "./story";

/**
 * /live-story's script: seven scenes, each moved to by an event. Pure functions of
 * DashboardState, so the page and its tests agree on which scene the events reached.
 */
export const SCENES = [
  { key: "ask", label: "Ask", caption: "A customer's agent asks." },
  { key: "darwin", label: "Darwin", caption: "Darwin first." },
  { key: "call", label: "Call", caption: "So Platypus calls the shop." },
  { key: "yes", label: "Yes", caption: "“Yeah, text me.”" },
  { key: "text", label: "Text", caption: "The next job? Just a text." },
  { key: "y", label: "Y", caption: "“Y.” Booked." },
  { key: "payoff", label: "Payoff", caption: "One call.\nEvery job after: Y." },
] as const;

export const PAYOFF = SCENES.length - 1;

/** Scene 2's caption, never stronger than Darwin's actual answer. */
export function darwinCaption(d: DarwinView | undefined): string {
  if (!d) return SCENES[1].caption;
  switch (d.status) {
    case "error":
      return "Darwin didn't answer. We call.";
    case "disabled":
      return "Darwin not asked. We call.";
    case "no_match":
      return "Darwin: no agent can book it.";
    case "needs_input":
      return "Darwin asked for more detail.";
    default:
      return d.agents.some((a) => a.canStartThread || a.id === d.candidateAgentId) ? "Darwin first. An agent is ready." : "Darwin: no agent ready.";
  }
}

/** A caption is read from across a room, on a projector: six words at most. */
export const MAX_CAPTION_WORDS = 6;

export const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** The shop's own yes as the "Yes" caption when it fits; a longer one stays in the call screen. */
export function quoteCaption(quote: string | undefined): string | undefined {
  const said = quote?.trim();
  return said && wordCount(said) <= MAX_CAPTION_WORDS ? `“${said}”` : undefined;
}

const SCENE_OF: Record<StepKey, number> = { ask: 0, darwin: 1, call: 2, tools: 2, consent: 3, text: 4, confirmed: 5 };

/** The furthest scene the events reached. The confirmed Y leads straight on to the payoff. */
export function liveScene(state: DashboardState): number {
  if (state.reached.includes("confirmed")) return PAYOFF;
  return Math.max(0, ...state.reached.map((step) => SCENE_OF[step]));
}

/**
 * Least time a scene stays before the story moves on. The ask, Darwin's answer and the
 * dial land within a second of each other; without a dwell they would read as one jump.
 */
export const DWELL_MS = [2_600, 2_600, 1_800, 2_200, 2_000, 3_200, 0] as const;

/**
 * One step of the story toward `target`, given how long the current scene has shown.
 * Backwards (a replay) jumps; forwards moves one scene at a time, each after its dwell.
 */
export function pace(shown: number, target: number, shownForMs: number): { scene: number; waitMs?: number } {
  if (target <= shown) return { scene: target };
  const wait = (DWELL_MS[shown] ?? 0) - shownForMs;
  return wait > 0 ? { scene: shown, waitMs: wait } : { scene: shown + 1 };
}

/** What the shop's line shows while a scene is on screen. */
export function screenAt(state: DashboardState, scene: number): PhoneScreen {
  if (scene >= 4) return "messages";
  const call = scene >= 2 ? currentCall(state) : undefined;
  if (!call) return "lock";
  if (call.state === "Queued" || call.state === "Ringing") return "incoming";
  return call.state === "In-Progress" ? "call" : "ended";
}

/** The text thread as of a scene: the request alone in "Just a text", the owner's reply from the Y on. */
export function threadAt(state: DashboardState, scene: number): MessageView[] {
  const shop = storyBookings(state).byText?.businessId ?? state.messages.at(-1)?.businessId;
  const thread = shop ? state.messages.filter((m) => m.businessId === shop) : state.messages;
  if (scene > 4) return thread;
  const firstReply = thread.findIndex((m) => m.direction === "in");
  return firstReply < 0 ? thread : thread.slice(0, firstReply);
}
