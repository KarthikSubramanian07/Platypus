import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/jetbrains-mono";
import "./live-story.css";
import { $, el, setText } from "./dom";
import { connectLive, CONNECTION_LABELS, requestReplay, resolveSource, type ConnectionState } from "./events";
import { GOLDEN_PATH, planRecording, recordedAt } from "./fixture";
import { formatClock, formatLatency, formatRail, formatTrade, SHOP_TIME_ZONE, type StreamEvent } from "./format";
import { liveScene, pace, PAYOFF, SCENES, screenAt, threadAt } from "./scenes";
import { confirmSeconds, currentCall, evidenceMessage, initialState, reduce, reduceAll, storyBookings, VOICE_TOOLS, type AskView, type BusinessView, type DarwinView, type DashboardState, type VoiceTool } from "./state";
import { askFacts, callElapsedMs, darwinSummary } from "./story";

/**
 * /live-story: the golden path as seven scenes, moved along by the event stream. When an
 * event moves the story forward the page scrolls to that scene by itself; the shop's line is
 * pinned beside the scenes and shows whichever one is in view. Scrolling by hand (wheel,
 * touch, keys, the scene list) pauses that until the next event moves the story, or until
 * "Follow live". Facts come from DashboardState, the same reducer /live uses, and event
 * text reaches the DOM through textContent only.
 */

const source = resolveSource(location.search, { PROD: import.meta.env.PROD, VITE_EVENTS_URL: import.meta.env.VITE_EVENTS_URL as string | undefined });
const RECORDING = source.mode === "recording";
const stillMotion = matchMedia("(prefers-reduced-motion: reduce)");
const body = document.body;
history.scrollRestoration = "manual";

let state: DashboardState = initialState();
/** Every event received in live mode, so a replay can start from the ones after it. */
const received: StreamEvent[] = [];
/** The first ask and Darwin's answer to it: the second request must not rewrite scenes 1 and 2. */
let firstAsk: AskView | undefined;
let firstDarwin: DarwinView | undefined;
/** True while a live page loads the history it missed: the story jumps to where it is, no pacing. */
let catchingUp = !RECORDING;

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
  let next = catchingUp ? { scene: target } : pace(story.shown, target, performance.now() - story.shownAt);
  if (next.scene !== story.shown) {
    story.shown = next.scene;
    story.shownAt = performance.now();
    setText($("#announce"), caption(story.shown));
    if (story.following && !catchingUp) goTo(story.shown);
    if (!catchingUp) next = pace(story.shown, target, 0);
  }
  if (next.waitMs !== undefined) story.timer = setTimeout(advance, next.waitMs);
  schedule();
}

const stepNodes = SCENES.map((scene, i) => {
  const li = el("li", "step");
  const button = el("button", "", scene.label);
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

// The scene across the middle of the viewport drives the phone and the scene list.
const watcher = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) if (entry.isIntersecting) story.view = Number((entry.target as HTMLElement).dataset.scene);
    schedule();
  },
  { rootMargin: "-50% 0px -50% 0px" },
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
  if (scene === 1 && readyAgent(firstDarwin)) return "Darwin first. An agent is ready.";
  const quote = shop()?.consentQuote;
  if (scene === 3 && quote) return `“${quote}”`;
  const { byText } = storyBookings(state);
  const reply = byText ? evidenceMessage(state, byText)?.body : undefined;
  if (scene === 5 && reply && reply.length <= 12) {
    const seconds = confirmSeconds(state, byText!);
    const said = /[.!?]$/.test(reply) ? reply : `${reply}.`;
    if (seconds === undefined) return `“${said}” Booked.`;
    const s = Math.max(1, Math.round(seconds));
    return `“${said}” Booked in ${s} second${s === 1 ? "" : "s"}.`;
  }
  return SCENES[scene]!.caption;
}

const ROUTES: Record<string, string> = { call: "Routed to a phone call", text: "Routed to a text", darwin_act: "Routed to a Darwin agent" };
const TOOL_LABELS: Record<VoiceTool, string> = {
  check_slot: "Checked the calendar",
  hold_slot: "Held the slot",
  create_booking: "Booked the job",
  record_consent: "Saved the yes to texts",
  set_text_number: "Saved the best cell",
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
    button.title = i === story.shown ? `${SCENES[i]!.label}: where the story is now` : SCENES[i]!.label;
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
  setText($("#darwin-result"), !d ? "Not searched yet." : ready ? `${ready.name ?? ready.id} can take it.` : "No agent ready to book.");
  setText($("#darwin-line"), d ? (darwinSummary(d) ?? "") : "");
  const first = state.bookingOrder[0] ? state.bookings[state.bookingOrder[0]] : undefined;
  const route = $("#route");
  route.hidden = !first?.route;
  setText(route, first?.route ? (ROUTES[first.route] ?? `Routed by ${first.route}`) : "");
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
  renderPayoff();
}

// ---- The shop's line -----------------------------------------------------------------------------------

const phone = $("#phone");
const stage = $("#stage");
const SCREEN_LABELS: Record<string, string> = {
  lock: "The shop's line, locked",
  incoming: "The shop's line: an incoming call from Platypus, AI assistant",
  call: "The shop's line, on the call with Platypus while it books",
  ended: "The shop's line after the call",
  messages: "The shop's line: the text thread with Platypus",
};
/** Scenes whose own visual leads; the phone steps back for them. */
const ASIDE = new Set([0, 1, 3, PAYOFF]);

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
  for (const [i, tool] of VOICE_TOOLS.entries()) toolNodes[i]!.dataset.state = call.tools[tool].state;
  const b = shop();
  const said = $("#call-said");
  said.hidden = !(scene >= 3 && b?.consentQuote);
  setText($("#call-said-who"), b?.name ?? "The shop");
  setText($("#call-said-text"), b?.consentQuote ? `“${b.consentQuote}”` : "");
}

const bubbleNodes = new Map<string, HTMLLIElement>();
const receipt = el("li", "receipt");
function renderThread(scene: number): void {
  const messages = threadAt(state, scene);
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

function renderPhone(): void {
  // The phone never runs ahead of the story: scrolled past the live scene, it holds there.
  const scene = Math.min(story.view, story.shown);
  const screen = screenAt(state, scene);
  if (phone.dataset.screen !== screen) {
    phone.dataset.screen = screen;
    phone.setAttribute("aria-label", SCREEN_LABELS[screen]!);
  }
  stage.dataset.focus = ASIDE.has(story.view) ? "aside" : "phone";
  const now = Date.now();
  const clock = shopTime(now, { hour: "numeric", minute: "2-digit" }).replace(/ [AP]M$/, "");
  setText($("#sb-time"), clock);
  setText($("#lock-time"), clock);
  setText($("#lock-date"), shopTime(now, { weekday: "long", month: "long", day: "numeric" }));
  if (screen === "call" || screen === "ended") renderCall(scene, screen);
  renderThread(scene);
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

let frame = 0;
function render(): void {
  frame = 0;
  renderSteps();
  renderScenes();
  renderPhone();
  $("#follow").hidden = story.following;
  setText($("#follow-label"), RECORDING ? "Follow the run" : "Follow live");
  $("#replayed").hidden = RECORDING || !state.replayed;
}

function schedule(): void {
  if (!frame) frame = requestAnimationFrame(render);
}

// The phone's clock and the call timer move between events.
setInterval(schedule, 500);

function dispatch(event: StreamEvent): void {
  if (!RECORDING) received.push(event);
  const next = reduce(state, event);
  if (next === state) return;
  const before = liveScene(state);
  const waiting = !state.reached.length;
  state = next;
  firstAsk ??= state.ask;
  firstDarwin ??= state.darwin;
  // Scene 1 waited empty until now: its dwell starts when the ask lands, not when the page opened.
  if (waiting && state.reached.length && story.shown === 0) story.shownAt = performance.now();
  // An event that moves the story hands the scroll back to it, even after the viewer took over.
  const moved = liveScene(state) > before || (waiting && state.reached.length > 0);
  if (moved && !story.following) {
    story.following = true;
    if (!catchingUp) goTo(story.shown);
  }
  advance();
}

/** Starts the story over from `next`, drawn without transitions, then paced from scene 1. */
function resetTo(next: DashboardState): void {
  body.dataset.hydrating = "true";
  state = next;
  firstAsk = next.ask;
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
const PLAN = planRecording(GOLDEN_PATH, { speed: 1.6, maxGapMs: 2_400 });
const run = { tag: 0, epoch: 0, start: 0 };

/** The call timer's clock: the recording's own in recorded mode, the wall's when live. */
function clockNow(): number {
  return RECORDING && run.start ? run.epoch + recordedAt(PLAN, performance.now() - run.start) : Date.now();
}

function playRecording(): void {
  const tag = ++run.tag;
  resetTo(initialState());
  run.epoch = Date.now();
  run.start = performance.now();
  let i = 0;
  const step = () => {
    if (tag !== run.tag) return;
    const t = performance.now() - run.start;
    for (; i < PLAN.events.length && PLAN.events[i]!.wallMs <= t; i++) {
      const { event, recordedMs } = PLAN.events[i]!;
      dispatch({ ...event, id: `${event.id}-r${tag}`, created_at: new Date(run.epoch + recordedMs).toISOString(), payload: { ...event.payload, replayed: true } });
    }
    if (i < PLAN.events.length) setTimeout(step, PLAN.events[i]!.wallMs - t);
  };
  step();
}

// ---- Replay and the data source ------------------------------------------------------------------------------

const replayButton = $<HTMLButtonElement>("#replay");
replayButton.addEventListener("click", async () => {
  replayButton.disabled = true;
  try {
    if (RECORDING) playRecording();
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
  const start = () => setTimeout(playRecording, 700);
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
  // Until the server says the history is replayed, the story jumps straight to where the events are.
  const settle = () => {
    if (!catchingUp) return;
    catchingUp = false;
    goTo(story.shown, true);
    requestAnimationFrame(() => requestAnimationFrame(() => (body.dataset.hydrating = "false")));
    advance();
  };
  const fallback = setTimeout(settle, 2_500);
  connectLive(
    source.base,
    {
      onEvent: dispatch,
      onState: setConnection,
      onReady: () => {
        clearTimeout(fallback);
        requestAnimationFrame(settle);
      },
    },
    { token: source.token },
  );
}
