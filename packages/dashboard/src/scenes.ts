import type { StepKey } from "./format";
import { currentCall, storyBookings, type DarwinView, type DashboardState, type MessageView } from "./state";
import type { PhoneScreen } from "./story";

/**
 * /live-story's script: the golden path's seven steps, after a step 0 where the customer asks
 * their own agent, then the payoff. Each scene is moved to by an event. Pure functions of
 * DashboardState, so the page and its tests agree on which scene the events reached.
 */
export const SCENES = [
  { key: "agent", step: "0", label: "You ask", caption: "You ask your agent." },
  { key: "ask", step: "1", label: "Agent asks", caption: "Your agent asks Platypus." },
  { key: "darwin", step: "2", label: "Darwin", caption: "Darwin first." },
  { key: "call", step: "3", label: "Rings", caption: "So Platypus calls the shop." },
  { key: "tools", step: "4", label: "Books", caption: "It books while they talk." },
  { key: "yes", step: "5", label: "Yes", caption: "“Yeah, text me.”" },
  { key: "text", step: "6", label: "Text", caption: "The next job? Just a text." },
  { key: "y", step: "7", label: "Y", caption: "“Y.” Booked." },
  { key: "payoff", step: "", label: "Payoff", caption: "One call.\nEvery job after: Y." },
] as const;

export const PAYOFF = SCENES.length - 1;

/** Scene 2's caption, never stronger than Darwin's actual answer. */
export function darwinCaption(d: DarwinView | undefined): string {
  if (!d) return SCENES[2].caption;
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

/** Scene 0 has no event of its own: it holds the customer's words until their agent's ask arrives. */
const SCENE_OF: Record<StepKey, number> = { ask: 1, darwin: 2, call: 3, tools: 4, consent: 5, text: 6, confirmed: 7 };

/**
 * The furthest scene the events reached. The confirmed Y leads straight on to the payoff.
 * Booking starts the moment the shop answers: the first tools fire long before create_booking.
 */
export function liveScene(state: DashboardState): number {
  if (state.reached.includes("confirmed")) return PAYOFF;
  const call = currentCall(state);
  const answered = call !== undefined && call.state !== "Queued" && call.state !== "Ringing";
  return Math.max(0, answered ? SCENE_OF.tools : 0, ...state.reached.map((step) => SCENE_OF[step]));
}

/**
 * Least time a scene stays before the story moves on. The ask, Darwin's answer and the
 * dial land within a second of each other; without a dwell they would read as one jump.
 */
export const DWELL_MS = [3_400, 2_400, 2_600, 2_000, 2_400, 2_200, 2_000, 3_200, 0] as const;

/**
 * One step of the story toward `target`, given how long the current scene has shown.
 * Backwards (a replay) jumps; forwards moves one scene at a time, each after its dwell.
 */
export function pace(shown: number, target: number, shownForMs: number): { scene: number; waitMs?: number } {
  if (target <= shown) return { scene: target };
  const wait = (DWELL_MS[shown] ?? 0) - shownForMs;
  return wait > 0 ? { scene: shown, waitMs: wait } : { scene: shown + 1 };
}

/**
 * What the phone shows while a scene is on screen. In scene 0 it is the customer's phone with
 * their agent open; from scene 1 on it is the shop's line. The ring scene always shows the
 * ring, even when the story is catching up to a call that has already been answered.
 */
export function screenAt(state: DashboardState, scene: number): PhoneScreen {
  if (scene === 0) return "agent";
  if (scene >= 6) return "messages";
  const call = scene >= 3 ? currentCall(state) : undefined;
  if (!call) return "lock";
  if (scene === 3 || call.state === "Queued" || call.state === "Ringing") return "incoming";
  return call.state === "In-Progress" ? "call" : "ended";
}

/** The text thread as of a scene: the request alone in "Just a text", the owner's reply from the Y on. */
export function threadAt(state: DashboardState, scene: number): MessageView[] {
  const shop = storyBookings(state).byText?.businessId ?? state.messages.at(-1)?.businessId;
  const thread = shop ? state.messages.filter((m) => m.businessId === shop) : state.messages;
  if (scene > 6) return thread;
  const firstReply = thread.findIndex((m) => m.direction === "in");
  return firstReply < 0 ? thread : thread.slice(0, firstReply);
}
