import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/jetbrains-mono";
import "./live-story.css";
import { $, el, setText } from "./dom";
import { connectLive, CONNECTION_LABELS, requestReplay, resolveSource, type ConnectionState } from "./events";
import { GOLDEN_PATH, planRecording, recordedAt } from "./fixture";
import { formatClock, formatLatency, formatMoney, formatRail, formatSlot, formatTrade, SHOP_TIME_ZONE, type StreamEvent } from "./format";
import { darwinCaption, liveScene, pace, PAYOFF, quoteCaption, SCENES, screenAt, threadAt } from "./scenes";
import { confirmSeconds, currentCall, evidenceMessage, initialState, reduce, reduceAll, storyBookings, VOICE_TOOLS, type AskView, type BusinessView, type DarwinView, type DashboardState, type VoiceTool } from "./state";
import { askFacts, callElapsedMs, darwinSummary, phoneLabel, railOf } from "./story";

/**
 * /live-story: step 0 (the customer asks their own agent), the golden path's seven steps, then the payoff, moved along by the event stream. Every page
 * load starts at scene 1 and plays forward: the static build plays the recorded run, a live
 * page plays the backlog it connected to the same way, then carries on with live events.
 * When the story moves on the page scrolls to that scene by itself; the shop's line is pinned
 * beside the scenes (above them on narrow screens) and shows whichever one is in view.
 * Scrolling by hand (wheel, touch, keys, the scene list) pauses that until the next event
 * moves the story, or until "Follow live". Facts come from DashboardState, the same reducer
 * /live uses, and event text reaches the DOM through textContent only.
 */

const source = resolveSource(location.search, { PROD: import.meta.env.PROD, VITE_EVENTS_URL: import.meta.env.VITE_EVENTS_URL as string | undefined });
const RECORDING = source.mode === "recording";
const stillMotion = matchMedia("(prefers-reduced-motion: reduce)");
const body = document.body;
// Every load opens at the top, on scene 1: never where a reload or the last visit left off.
history.scrollRestoration = "manual";
scrollTo(0, 0);

let state: DashboardState = initialState();
/** Every event received in live mode, so a replay can start from the ones after it. */
const received: StreamEvent[] = [];
/** The first ask and Darwin's answer to it: the second request must not rewrite scenes 1 and 2. */
let firstAsk: AskView | undefined;
let firstDarwin: DarwinView | undefined;
/**
 * Live events waiting their turn. A live page holds the backlog until the server says it is
 * all sent, plays it from scene 1, and holds anything newer until that playback ends.
 */
let held: StreamEvent[] | undefined = RECORDING ? undefined : [];

/** shown: the scene the story is on. view: the scene across the middle of the viewport. */
const story = { shown: 0, shownAt: performance.now(), view: 0, following: true, timer: undefined as ReturnType<typeof setTimeout> | undefined };

// ---- Moving through the scenes ---------------------------------------------------------------

const sceneNodes = [...document.querySelectorAll<HTMLElement>(".scene")];

function goTo(scene: number, instant = stillMotion.matches): void {
  sceneNodes[scene]?.scrollIntoView({ behavior: instant ? "instant" : "smooth", block: "start" });
}

/** The viewer took the scroll: stop following until the next event moves the story. */
function takeOver(): void {
  if (!story.following) return;
  story.following = false;
  schedule();
}

function follow(): void {
  story.following = true;
  goTo(story.shown);
  schedule();
}

/** Steps the shown scene toward the one the events reached, one dwell at a time. */
function advance(): void {
  if (story.timer) clearTimeout(story.timer);
  story.timer = undefined;
  const target = liveScene(state);
  let next = pace(story.shown, target, performance.now() - story.shownAt);
  if (next.scene !== story.shown) {
    story.shown = next.scene;
    story.shownAt = performance.now();
    setText($("#announce"), caption(story.shown));
    if (story.following) goTo(story.shown);
    next = pace(story.shown, target, 0);
  }
  if (next.waitMs !== undefined) story.timer = setTimeout(advance, next.waitMs);
  schedule();
}

const stepNodes = SCENES.map((scene, i) => {
  const li = el("li", "step");
  const button = el("button", "");
  if (scene.step) button.append(el("span", "step-num", scene.step));
  button.append(el("span", "step-label", scene.label));
  button.type = "button";
  button.addEventListener("click", () => {
    if (i === story.shown) return follow();
    takeOver();
    goTo(i);
  });
  li.append(button);
  $("#steps").append(li);
  return li;
});

// The scene under a line 70% down the viewport drives the phone and the scene list. On narrow
// screens the pinned phone covers the top half, so a mid-viewport line would read the scene
// before the one under the caption and the phone would lag a scene behind.
const watcher = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) if (entry.isIntersecting) story.view = Number((entry.target as HTMLElement).dataset.scene);
    schedule();
  },
  { rootMargin: "-70% 0px -30% 0px" },
);
for (const node of sceneNodes) watcher.observe(node);

// Anything the viewer does to scroll hands them the page. Programmatic scrolls fire none of these.
addEventListener("wheel", takeOver, { passive: true });
addEventListener("touchmove", takeOver, { passive: true });
addEventListener("pointerdown", (e) => {
  if (e.target === document.documentElement) takeOver(); // the scrollbar
});
const KEYS: Record<string, (view: number) => number> = {
  ArrowDown: (v) => v + 1,
  ArrowRight: (v) => v + 1,
  PageDown: (v) => v + 1,
  ArrowUp: (v) => v - 1,
  ArrowLeft: (v) => v - 1,
  PageUp: (v) => v - 1,
  Home: () => 0,
  End: () => PAYOFF,
};
addEventListener("keydown", (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const space = e.key === " " && !(e.target instanceof HTMLButtonElement);
  const move = space ? (v: number) => v + (e.shiftKey ? -1 : 1) : KEYS[e.key];
  if (!move) return;
  e.preventDefault();
  takeOver();
  goTo(Math.max(0, Math.min(PAYOFF, move(story.view))));
});
$("#follow").addEventListener("click", follow);

// ---- Words -------------------------------------------------------------------------------------

function shop(): BusinessView | undefined {
  const consented = state.businessOrder.map((id) => state.businesses[id]!).find((b) => b.consentQuote);
  const callShop = currentCall(state)?.businessId;
  return consented ?? (callShop ? state.businesses[callShop] : undefined);
}

/** The agent Darwin found that can take the job, if any: then the story leaves the golden path. */
function readyAgent(d: DarwinView | undefined) {
  return d?.agents.find((a) => a.canStartThread || a.id === d.candidateAgentId);
}

/** The scene's caption: fixed words, except where the events carry the exact ones. */
function caption(scene: number): string {
  if (scene === 2) return darwinCaption(firstDarwin);
  const quote = quoteCaption(shop()?.consentQuote);
  if (scene === 5 && quote) return quote;
  const { byText } = storyBookings(state);
  const reply = byText ? evidenceMessage(state, byText)?.body : undefined;
  if (scene === 7 && reply && reply.length <= 12) {
    const seconds = confirmSeconds(state, byText!);
    const said = /[.!?]$/.test(reply) ? reply : `${reply}.`;
    if (seconds === undefined) return `“${said}” Booked.`;
    const s = Math.max(1, Math.round(seconds));
    return `“${said}” Booked in ${s} second${s === 1 ? "" : "s"}.`;
  }
  return SCENES[scene]!.caption;
}

/** Darwin's answer in the search card, as strong as the status and no stronger. */
const DARWIN_RESULTS: Record<string, string> = {
  error: "No answer from Darwin.",
  disabled: "Darwin not consulted.",
  no_match: "No agent can book it.",
  needs_input: "Darwin needs more detail.",
};
const ROUTES: Record<string, string> = { call: "Routed to a phone call", text: "Routed to a text", darwin_act: "Routed to a Darwin agent" };
const TOOL_LABELS: Record<VoiceTool, string> = {
  check_slot: "Checked the calendar",
  hold_slot: "Held the slot",
  create_booking: "Booked the job",
  record_consent: "Saved the yes to texts",
  set_text_number: "Saved the text line",
};

// ---- Rendering the scenes ------------------------------------------------------------------------

function sceneState(i: number): "done" | "live" | "todo" {
  return i < story.shown ? "done" : i === story.shown ? "live" : "todo";
}

function renderSteps(): void {
  for (const [i, li] of stepNodes.entries()) {
    li.dataset.state = sceneState(i);
    li.dataset.view = String(i === story.view);
    const button = li.firstElementChild as HTMLButtonElement;
    if (i === story.view) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
    const name = SCENES[i]!.step ? `Step ${SCENES[i]!.step}, ${SCENES[i]!.label}` : SCENES[i]!.label;
    button.title = i === story.shown ? `${name}: where the story is now` : name;
  }
}

let factsKey = "";
function renderAsk(): void {
  const ask = firstAsk;
  setText($("#ask-agent"), ask?.agentId ? `${ask.agentId} asks Platypus` : "A customer's agent");
  const quote = $("#ask-quote");
  setText(quote, ask?.utterance ? `“${ask.utterance}”` : ask ? "" : "Waiting for an agent to ask for something.");
  quote.dataset.empty = String(!ask);
  const facts = askFacts(ask);
  if (facts.join("|") !== factsKey) {
    factsKey = facts.join("|");
    $("#ask-facts").replaceChildren(...facts.map((f) => el("li", "", f)));
  }
}

function renderDarwin(): void {
  const d = firstDarwin;
  setText($("#darwin-latency"), d?.latencyMs ? (formatLatency(d.latencyMs) ?? "") : "");
  setText($("#darwin-query"), d?.query ?? "");
  const ready = readyAgent(d);
  setText($("#darwin-result"), !d ? "Not searched yet." : ready ? `${ready.name ?? ready.id} can take it.` : (DARWIN_RESULTS[d.status] ?? "No agent ready to book."));
  setText($("#darwin-line"), d ? (darwinSummary(d) ?? "") : "");
  const first = state.bookingOrder[0] ? state.bookings[state.bookingOrder[0]] : undefined;
  const route = $("#route");
  route.hidden = !first?.route;
  setText(route, first?.route ? (Object.hasOwn(ROUTES, first.route) ? ROUTES[first.route]! : `Routed by ${first.route}`) : "");
}

function renderShop(): void {
  const b = shop();
  const on = b?.channel === "text_enabled";
  const card = $("#shop");
  card.dataset.flipped = String(on);
  for (const node of card.querySelectorAll<HTMLElement>("[data-field]")) {
    setText(node, node.dataset.field === "name" ? (b?.name ?? "The shop") : formatTrade(b?.trade) || "Phone-only business");
  }
  setText($("#shop-rail"), `Text-enabled${b?.rail ? ` · ${formatRail(b.rail)}` : ""}`);
  setText($("#shop-cell"), b?.numberMasked ? `Best cell ${b.numberMasked}` : "");
  $("#shop-front").setAttribute("aria-hidden", String(on));
  $("#shop-back").setAttribute("aria-hidden", String(!on));
}

function renderPayoff(): void {
  const call = currentCall(state);
  const seconds = call?.durationSeconds ?? (call?.inProgressAt ? callElapsedMs(call, clockNow()) / 1000 : undefined);
  setText($("#pay-call"), seconds !== undefined ? `Call ${formatClock(seconds)}` : "Call");
  const { byText } = storyBookings(state);
  const confirm = byText ? confirmSeconds(state, byText) : undefined;
  setText($("#pay-y"), confirm !== undefined ? `${Math.max(1, Math.round(confirm))} s` : "");
  const booked = state.bookingOrder.filter((id) => state.bookings[id]!.status === "confirmed").length;
  const calls = Object.keys(state.calls).length;
  setText($("#pay-note"), booked ? `${booked} job${booked === 1 ? "" : "s"} booked, ${calls} call${calls === 1 ? "" : "s"}` : "");
}

/** The booking itself, as proof: code, price and slot, and the words that confirmed it. */
function renderProof(): void {
  const { byCall, byText } = storyBookings(state);
  const call = currentCall(state);
  for (const [i, tool] of VOICE_TOOLS.entries()) toolNodes[i]!.dataset.state = call?.tools[tool].state ?? "pending";
  for (const node of document.querySelectorAll<HTMLElement>("[data-proof]")) {
    const booking = node.dataset.proof === "text" ? byText : byCall;
    node.hidden = booking?.status !== "confirmed";
    if (!booking || node.hidden) continue;
    setText(node.firstElementChild!, [booking.shortCode, formatMoney(booking.priceCents), formatSlot(booking.slotStart)].filter(Boolean).join(" · "));
    const how = `Confirmed by ${booking.route === "text" ? "text" : "call"}`;
    setText(node.lastElementChild!, booking.evidence?.quote ? `${how}: “${booking.evidence.quote}”` : how);
  }
}

function renderScenes(): void {
  for (const [i, node] of sceneNodes.entries()) {
    node.dataset.state = sceneState(i);
    const cap = $(`#cap-${i}`);
    const text = caption(i);
    setText(cap, text);
    cap.dataset.quote = String(text.startsWith("“"));
  }
  renderAsk();
  renderDarwin();
  renderShop();
  renderProof();
  renderPayoff();
}

// ---- The shop's line -----------------------------------------------------------------------------------

const phone = $("#phone");
const stage = $("#stage");
const SCREEN_LABELS: Record<string, string> = {
  agent: "The customer's phone, asking their agent",
  lock: "The shop's line, locked",
  incoming: "The shop's line: an incoming call from Platypus, AI assistant",
  call: "The shop's line, on the call with Platypus while it books",
  ended: "The shop's line after the call",
  messages: "The shop's line: the text thread with Platypus",
};

const toolNodes = VOICE_TOOLS.map((tool) => {
  const li = el("li", "tool", TOOL_LABELS[tool]);
  $("#tools").append(li);
  return li;
});

function shopTime(ms: number, parts: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleString("en-US", { ...parts, timeZone: SHOP_TIME_ZONE });
}

function renderCall(scene: number, screen: string): void {
  const call = currentCall(state);
  if (!call) return;
  const elapsed = formatClock((call.durationSeconds ?? callElapsedMs(call, clockNow()) / 1000) || 0);
  setText($("#call-time"), screen === "ended" ? (call.canceled ? "Call ended early" : `Call ended · ${elapsed}`) : elapsed);
  const b = shop();
  const said = $("#call-said");
  said.hidden = !(scene >= 5 && b?.consentQuote);
  setText($("#call-said-who"), b?.name ?? "The shop");
  setText($("#call-said-text"), b?.consentQuote ? `“${b.consentQuote}”` : "");
}

const bubbleNodes = new Map<string, HTMLLIElement>();
const receipt = el("li", "receipt");
/** The thread as of `scene`; texts that arrive with it rise in by `f`, the arrival's scroll progress. */
function renderThread(scene: number, f: number): void {
  const messages = threadAt(state, scene);
  // Before the text scene the thread is not on screen, so its first text rises in with the scene.
  const before = new Set(scene > 6 ? threadAt(state, scene - 1).map((m) => m.id) : []);
  const channel = (messages[0]?.channel ?? shop()?.rail ?? "sms").toLowerCase();
  phone.dataset.rail = channel === "imessage" ? "imessage" : "sms";
  setText($("#im-service"), channel === "imessage" ? "iMessage" : channel === "whatsapp" ? "WhatsApp" : `Text Message${channel === "dial" ? " · Dial" : ""}`);
  setText($("#im-field"), channel === "imessage" ? "iMessage" : "Text Message");
  setText($("#im-when"), messages[0] ? `Today ${shopTime(Date.parse(messages[0].at), { hour: "numeric", minute: "2-digit" })}` : "Today");
  const keep = new Set(messages.map((m) => m.id));
  for (const [id, node] of bubbleNodes) {
    if (keep.has(id)) continue;
    node.remove();
    bubbleNodes.delete(id);
  }
  const list = $("#bubbles");
  for (const [i, m] of messages.entries()) {
    let node = bubbleNodes.get(m.id);
    if (!node) {
      // From the shop's side: Platypus's texts arrive on the left, the owner's replies go out on the right.
      node = el("li", `bubble ${m.direction === "out" ? "b-them" : "b-me"}`, m.body);
      bubbleNodes.set(m.id, node);
      list.append(node);
    }
    node.classList.toggle("tail", messages[i + 1]?.direction !== m.direction);
    node.style.setProperty("--f", before.has(m.id) ? "1" : f.toFixed(3));
  }
  const lastReply = messages.findLast((m) => m.direction === "in");
  if (lastReply) {
    setText(receipt, `Delivered ${shopTime(Date.parse(lastReply.at), { hour: "numeric", minute: "2-digit" })}`);
    bubbleNodes.get(lastReply.id)!.after(receipt);
  } else receipt.remove();
}

/** Fits the whole device in the stage, on a projector or in a 1280 x 720 screen share. */
const fit = $("#phone-fit");
function fitPhone(): void {
  const note = stage.querySelector<HTMLElement>(".stage-note");
  const style = getComputedStyle(stage);
  const room = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - (note?.offsetHeight ?? 0) - parseFloat(style.rowGap || "0") - 30;
  const width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  fit.style.setProperty("--s", Math.max(0.25, Math.min(0.96, room / 854, width / 430)).toFixed(4));
}
addEventListener("resize", fitPhone);

// ---- Scroll as the story's timeline --------------------------------------------------------------------
// The visuals are scrubbed by the scroll, frame by frame: hand scrolling and the page's own smooth
// scroll to the next scene both play them, so nothing runs on a timer of its own.

const storyEl = $(".story");
const SCREEN_NODES: Record<string, HTMLElement> = { agent: $(".scr-agent"), lock: $(".scr-lock"), incoming: $(".scr-incoming"), call: $(".scr-call"), ended: $(".scr-call"), messages: $(".scr-messages") };

/** Where the scroll is in the story: 2 is scene 3 at rest, 2.5 is halfway on to scene 4. */
function scrollStory(): number {
  const margin = parseFloat(getComputedStyle(sceneNodes[0]!).scrollMarginTop) || 0;
  const tops = sceneNodes.map((node) => node.getBoundingClientRect().top - margin);
  let i = 0;
  while (i < tops.length - 1 && tops[i + 1]! <= 0.5) i++;
  const span = (tops[i + 1] ?? 0) - tops[i]!;
  const at = span > 0 ? i + Math.min(1, Math.max(0, -tops[i]! / span)) : i;
  // Reduced motion: no in-between frames, each scene's state as it lands.
  return stillMotion.matches ? Math.round(at) : at;
}

addEventListener("scroll", schedule, { passive: true });

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function renderPhone(): void {
  // The phone never runs ahead of the story: scrolled past the live scene, it holds there.
  const at = Math.min(scrollStory(), story.shown);
  const from = Math.floor(at);
  const f = at - from;
  const scene = f > 0 ? from + 1 : from;
  const leaving = screenAt(state, from);
  const arriving = screenAt(state, scene);
  const screen = f < 0.5 ? leaving : arriving;
  if (phone.dataset.screen !== screen) {
    phone.dataset.screen = screen;
    phone.setAttribute("aria-label", SCREEN_LABELS[screen]!);
  }
  // The next screen comes in as the scroll moves on: a crossfade that settles from a slight zoom.
  for (const node of new Set(Object.values(SCREEN_NODES))) {
    const isOut = SCREEN_NODES[leaving] === node;
    const isIn = SCREEN_NODES[arriving] === node;
    const opacity = isOut && isIn ? 1 : isIn ? f : isOut ? 1 - f : 0;
    node.style.opacity = opacity.toFixed(3);
    node.style.transform = isIn && !isOut ? `scale(${(1.05 - 0.05 * f).toFixed(4)})` : "";
  }
  // Scrubbed by the same progress: the shop's card turns over into the yes, the Ys line up in the
  // payoff, and the phone turns from a three-quarter stance to face the reader as the texts begin.
  storyEl.style.setProperty("--k-yes", clamp01(at - 4).toFixed(3));
  storyEl.style.setProperty("--k-payoff", clamp01(at - (PAYOFF - 1)).toFixed(3));
  fit.style.setProperty("--ry", `${(-13 + 11 * clamp01(at - 5)).toFixed(2)}deg`);
  fit.style.setProperty("--rx", `${(3 - 2 * clamp01(at - 5)).toFixed(2)}deg`);
  if (leaving === "agent" || arriving === "agent") renderAgent();
  const now = Date.now();
  const clock = shopTime(now, { hour: "numeric", minute: "2-digit" }).replace(/ [AP]M$/, "");
  setText($("#sb-time"), clock);
  setText($("#lock-time"), clock);
  setText($("#lock-date"), shopTime(now, { weekday: "long", month: "long", day: "numeric" }));
  if ([leaving, arriving].some((s) => s === "call" || s === "ended")) renderCall(scene, arriving === "ended" ? arriving : leaving);
  renderThread(scene, f > 0 ? f : 1);
}

// ---- Header, render loop ------------------------------------------------------------------------------

const conn = $("#conn");
function setConnection(next: ConnectionState): void {
  conn.dataset.state = next;
  setText(conn, CONNECTION_LABELS[next]);
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function say(message: string): void {
  const notice = $("#notice");
  setText(notice, message);
  notice.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.hidden = true), 4_500);
}

/** The recording's rail is known before its consent plays, so the phone can say it from the start. */
const RECORDED_RAIL = railOf(reduceAll(GOLDEN_PATH));
const stageNote = stage.querySelector<HTMLElement>(".stage-note");

const DIAL_NOTE = stageNote?.textContent ?? "";
const AGENT_NOTE = "Your phone, with your agent open.";

/**
 * The note under the phone: step 0 says whose phone it is; after that, the Dial-to-Dial note
 * only when the events' rail is dial, since a real phone is simply the owner's phone.
 */
function renderRail(): void {
  const rail = RECORDING ? RECORDED_RAIL : railOf(state);
  setText($("#lock-hint"), phoneLabel(rail));
  if (!stageNote) return;
  const onAgent = phone.dataset.screen === "agent";
  setText(stageNote, onAgent ? AGENT_NOTE : DIAL_NOTE);
  const hide = !onAgent && rail !== "dial";
  if (stageNote.hidden !== hide) {
    stageNote.hidden = hide;
    fitPhone();
  }
}

/**
 * Step 0, on the customer's phone: their words type themselves into the agent, then the agent
 * says it is asking Platypus. The words are the real ask from the event stream.
 */
const TYPE_MS = 1_700;
const typing = { start: undefined as number | undefined };
function renderAgent(): void {
  const words = firstAsk?.utterance ?? "";
  if (words && typing.start === undefined) typing.start = performance.now();
  const elapsed = typing.start === undefined ? 0 : performance.now() - typing.start;
  const instant = stillMotion.matches;
  const shown = instant ? words.length : Math.min(words.length, Math.floor((elapsed / TYPE_MS) * words.length));
  const done = words.length > 0 && shown >= words.length;
  setText($("#ag-ask-text"), words.slice(0, shown));
  $("#ag-ask").dataset.typing = String(!done);
  $("#ag-reply").hidden = !(done && (instant || elapsed > TYPE_MS + 450));
  $("#ag-tool").hidden = !(done && (instant || elapsed > TYPE_MS + 1_100));
  if (words && !instant && elapsed < TYPE_MS + 1_200) schedule();
}

let frame = 0;
function render(): void {
  frame = 0;
  renderSteps();
  renderScenes();
  renderPhone();
  renderRail();
  $("#follow").hidden = story.following;
  setText($("#follow-label"), RECORDING ? "Follow the run" : "Follow live");
  $("#replayed").hidden = RECORDING || !state.replayed;
}

function schedule(): void {
  if (!frame) frame = requestAnimationFrame(render);
}

// The phone's clock and the call timer move between events.
setInterval(schedule, 500);

/** A live event: held while the backlog plays, dispatched once the story has caught up. */
function arrive(event: StreamEvent): void {
  if (held) held.push(event);
  else dispatch(event);
}

function dispatch(event: StreamEvent): void {
  if (!RECORDING) received.push(event);
  const next = reduce(state, event);
  if (next === state) return;
  const before = liveScene(state);
  const waiting = !state.reached.length;
  state = next;
  // Only a search is the ask scene 1 tells; a bare request_booking would freeze a thinner one.
  if (state.ask?.tool === "search_providers") firstAsk ??= state.ask;
  firstDarwin ??= state.darwin;
  // Scene 1 waited empty until now: its dwell starts when the ask lands, not when the page opened.
  if (waiting && state.reached.length && story.shown === 0) story.shownAt = performance.now();
  // An event that moves the story hands the scroll back to it, even after the viewer took over.
  const moved = liveScene(state) > before || (waiting && state.reached.length > 0);
  if (moved && !story.following) {
    story.following = true;
    goTo(story.shown);
  }
  advance();
}

/** Starts the story over from `next`, drawn without transitions, then paced from scene 1. */
function resetTo(next: DashboardState): void {
  body.dataset.hydrating = "true";
  state = next;
  firstAsk = next.ask?.tool === "search_providers" ? next.ask : undefined;
  typing.start = undefined;
  firstDarwin = next.darwin;
  story.shown = 0;
  story.shownAt = performance.now();
  story.following = true;
  for (const node of bubbleNodes.values()) node.remove();
  bubbleNodes.clear();
  render();
  goTo(0, true);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      body.dataset.hydrating = "false";
      advance();
    }),
  );
}

// ---- The recorded run (static deploys) --------------------------------------------------------------------

/** About 1.6x real time; the call plays at exactly this speed so its timer reads true. */
const plan = (events: readonly StreamEvent[]) => planRecording(events, { speed: 1.6, maxGapMs: 2_400 });
const run = { tag: 0, plan: plan([]), epoch: 0, start: 0, playing: false, autoplay: undefined as ReturnType<typeof setTimeout> | undefined };

/** The call timer's clock: the playback's own while a run plays (and after a recording), the wall's when live. */
function clockNow(): number {
  return (RECORDING || run.playing) && run.start ? run.epoch + recordedAt(run.plan, performance.now() - run.start) : Date.now();
}

/**
 * Plays `events` from scene 1 at the recording's pace. The recording is re-stamped to now so
 * it reads as today's run; a live backlog keeps its own times. `done` runs after the last one.
 */
function play(events: readonly StreamEvent[], restamp: boolean, done?: () => void): void {
  clearTimeout(run.autoplay);
  const tag = ++run.tag;
  resetTo(initialState());
  run.plan = plan(events);
  run.epoch = restamp ? Date.now() : Date.parse(events[0]?.created_at ?? "") || Date.now();
  run.start = performance.now();
  run.playing = true;
  let i = 0;
  const step = () => {
    if (tag !== run.tag) return;
    const t = performance.now() - run.start;
    for (; i < run.plan.events.length && run.plan.events[i]!.wallMs <= t; i++) {
      const { event, recordedMs } = run.plan.events[i]!;
      dispatch(restamp ? { ...event, id: `${event.id}-r${tag}`, created_at: new Date(run.epoch + recordedMs).toISOString(), payload: { ...event.payload, replayed: true } } : event);
    }
    if (i < run.plan.events.length) return void setTimeout(step, run.plan.events[i]!.wallMs - t);
    run.playing = false;
    done?.();
  };
  step();
}

const playRecording = () => play(GOLDEN_PATH, true);

// ---- Replay and the data source ------------------------------------------------------------------------------

const replayButton = $<HTMLButtonElement>("#replay");
replayButton.addEventListener("click", async () => {
  replayButton.disabled = true;
  try {
    if (RECORDING) playRecording();
    else if (held) say("Still playing the run so far.");
    else {
      // The server re-emits the golden-path fixture; the story restarts from the first of those events.
      const cutoff = received.length;
      if (await requestReplay(source.base, source.token)) resetTo(reduceAll(received.slice(cutoff)));
      else say("Replay needs a fakes server (DEMO_MODE=fakes).");
    }
  } finally {
    setTimeout(() => (replayButton.disabled = false), 1_200);
  }
});

fitPhone();
void document.fonts?.ready.then(fitPhone);
render();

if (RECORDING) {
  setConnection("recording");
  conn.title = "No server behind this page: it plays the golden path recorded against the test fakes.";
  body.dataset.hydrating = "false";
  // Autoplay once the page is actually visible, so nobody misses the first scene.
  const start = () => (run.autoplay = setTimeout(playRecording, 700));
  if (document.visibilityState === "visible") start();
  else {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onVisible);
      start();
    };
    document.addEventListener("visibilitychange", onVisible);
  }
} else {
  // Once the server says the backlog is sent, the story plays it from scene 1, then goes live.
  let settled = false;
  const goLive = () => {
    const rest = held ?? [];
    held = undefined;
    for (const event of rest) dispatch(event);
  };
  const settle = () => {
    if (settled) return;
    settled = true;
    const backlog = held ?? [];
    held = [];
    body.dataset.hydrating = "false";
    if (backlog.length) play(backlog, false, goLive);
    else goLive();
  };
  const fallback = setTimeout(settle, 2_500);
  connectLive(
    source.base,
    {
      onEvent: arrive,
      onState: setConnection,
      onReady: () => {
        clearTimeout(fallback);
        requestAnimationFrame(settle);
      },
    },
    { token: source.token },
  );
}
