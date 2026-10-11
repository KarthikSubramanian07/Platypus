import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/jetbrains-mono";
import "./live.css";
import { $, el, setText } from "./dom";
import { connectLive, CONNECTION_LABELS, requestKillCall, requestOwnerReply, requestReplay, resolveSource, withToken, type ConnectionState, type DemoResult } from "./events";
import { cuesAt, GOLDEN_PATH, planRecording, recordedAt, type PlannedCue } from "./fixture";
import { formatCallOffset, formatClock, formatConfidence, formatLatency, formatMoney, formatRail, formatSlot, formatTime, formatTrade, GOLDEN_STEPS, SHOP_TIME_ZONE, summarize, type StepKey, type StreamEvent } from "./format";
import {
  awaitingOwner,
  confirmSeconds,
  currentCall,
  evidenceMessage,
  initialState,
  readTranscript,
  reduce,
  reduceAll,
  storyBookings,
  supplyRows,
  VOICE_TOOLS,
  type BookingView,
  type DarwinView,
  type DashboardState,
  type MessageView,
  type TranscriptTurn,
  type VoiceTool,
} from "./state";
import { askFacts, bookingForAsk, callElapsedMs, captionsAt, darwinSummary, FINAL_LINE, mergeTurns, phoneScreen } from "./story";

/**
 * /live: the demo as judges watch it. The shop's line on the left (the call, then the
 * text thread); on the right one headline and the one thing that just changed; the
 * evidence folded away below. Every region is a view of DashboardState, folded from the
 * event stream by the pure reduce(); event text reaches the DOM through textContent only.
 *
 * Motion runs only for changes that arrive while the page is watching: CSS transitions
 * (switched off while a backlog, replay or fresh log is drawn) and live-only Web
 * Animations for things that appear. Nothing is queued up to play when drawing ends.
 */

const source = resolveSource(location.search, { PROD: import.meta.env.PROD, VITE_EVENTS_URL: import.meta.env.VITE_EVENTS_URL as string | undefined });
const RECORDING = source.mode === "recording";

let state: DashboardState = initialState();
/** Every event of the current log received in live mode, to undo a failed replay and to spot a fresh log. */
let history: StreamEvent[] = [];

// ---- The recorded run ------------------------------------------------------------------------

/** About 1.6x real time; the call itself plays at exactly this speed so captions stay in step. */
const PLAN = planRecording(GOLDEN_PATH, { speed: 1.6, maxGapMs: 2_400 });
/** How long the last beat stays on screen before the closing line. */
const FINAL_DELAY_MS = 2_600;

/** The recording knows each call's transcript in advance, so it can caption the call as it plays. */
const RECORDED_TURNS = new Map<string, TranscriptTurn[]>();
for (const e of GOLDEN_PATH) if (e.type === "call.transcribed" && e.refs.call_id) RECORDED_TURNS.set(e.refs.call_id, readTranscript(e.payload));

const run = { active: false, finished: false, epoch: Date.now(), wallStart: 0, tag: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };

function wallElapsed(): number {
  return performance.now() - run.wallStart;
}

/** The clock the call timer and captions read: the recording's own clock in recorded mode. */
function clockNow(): number {
  if (!RECORDING) return Date.now();
  if (!run.active && !run.finished) return run.epoch;
  return run.epoch + recordedAt(PLAN, wallElapsed());
}

function activeCues(): PlannedCue[] {
  return RECORDING && run.active ? cuesAt(PLAN, wallElapsed()) : [];
}

function playRecording(): void {
  if (run.timer) clearTimeout(run.timer);
  run.active = true;
  run.finished = false;
  run.epoch = Date.now();
  run.wallStart = performance.now();
  run.tag += 1;
  resetTo(initialState());
  const tag = run.tag;
  let i = 0;
  const step = () => {
    if (tag !== run.tag) return;
    const t = wallElapsed();
    while (i < PLAN.events.length && PLAN.events[i]!.wallMs <= t) {
      const { event, recordedMs } = PLAN.events[i]!;
      // Stamped on the recording's clock from now, so durations read true (the owner's reply still took 4 s).
      dispatch({ ...event, id: `${event.id}-r${tag}`, created_at: new Date(run.epoch + recordedMs).toISOString(), payload: { ...event.payload, replayed: true } });
      i += 1;
    }
    if (i < PLAN.events.length) run.timer = setTimeout(step, Math.max(0, PLAN.events[i]!.wallMs - t));
    else
      run.timer = setTimeout(() => {
        run.active = false;
        run.finished = true;
        schedule();
      }, FINAL_DELAY_MS);
  };
  step();
}

// ---- Motion ----------------------------------------------------------------------------------------

const body = document.body;
const stillMotion = matchMedia("(prefers-reduced-motion: reduce)");
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

/** One entrance for anything that appears live: it rises, sharpens and fades in. Never while drawing a backlog. */
function enter(node: Element, from: Keyframe = { opacity: 0, transform: "translateY(10px)", filter: "blur(6px)" }, duration = 560): void {
  if (body.dataset.hydrating === "true" || stillMotion.matches) return;
  node.animate([from, { opacity: 1, transform: "none", filter: "none" }], { duration, easing: EASE_OUT });
}

/** Ends a drawing pass: render now, flush styles so nothing transitions from it, then let later changes move. */
function settle(): void {
  if (frame) {
    cancelAnimationFrame(frame);
    render();
  }
  body.getBoundingClientRect();
  body.dataset.hydrating = "false";
}

// ---- Header ------------------------------------------------------------------------------------------

const conn = $("#conn");
const replayed = $("#replayed");
const killButton = $<HTMLButtonElement>("#kill");
const replayButton = $<HTMLButtonElement>("#replay");
const notice = $("#notice");

function setConnection(next: ConnectionState): void {
  conn.dataset.state = next;
  setText(conn, CONNECTION_LABELS[next]);
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function say(message: string): void {
  setText(notice, message);
  notice.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.hidden = true), 4_500);
}

function failure(what: string, result: DemoResult): string {
  if (result.status === 404) return `${what}: this server has no demo controls (404).`;
  return result.status ? `${what} failed (HTTP ${result.status}).` : `${what} failed: the server did not answer.`;
}

// ---- The moment: progress and headline -------------------------------------------------------------

const beatNodes = GOLDEN_STEPS.map((step) => {
  const span = el("span");
  span.title = step.label;
  $("#beats").append(span);
  return span;
});

function isFinal(): boolean {
  if (state.currentStep !== "confirmed") return false;
  return RECORDING ? run.finished : true;
}

function formatSeconds(s: number): string {
  return s < 10 && s % 1 ? s.toFixed(1) : String(Math.round(s));
}

function businessOf(id: string | undefined) {
  return id ? state.businesses[id] : undefined;
}

/** The shop on screen: the one being called or texted, else the one the agent's request went to. */
function shopId(): string | undefined {
  return currentCall(state)?.businessId ?? state.messages.at(-1)?.businessId ?? bookingForAsk(state)?.businessId;
}

/** At most six words that name the moment; the page shows the rest. */
function headline(final: boolean): string {
  if (final) return FINAL_LINE;
  const call = currentCall(state);
  switch (state.currentStep) {
    case undefined:
      return RECORDING ? "An agent is about to ask." : "Waiting for an agent.";
    case "ask":
      return state.ask?.service ? `An agent asks: ${state.ask.service}.` : "An agent asks to book.";
    case "darwin":
      if (state.darwin?.status === "error") return "Darwin is unavailable.";
      return state.darwin?.agents.some((a) => a.id === state.darwin?.candidateAgentId || a.canStartThread) ? "An agent already covers it." : "No agent can take it.";
    case "call":
      if (call?.canceled) return "The call ended early.";
      return call?.state === "In-Progress" ? "First sentence: it is an AI." : "So Platypus calls the shop.";
    case "tools":
      return "Booked while the owner talks.";
    case "consent": {
      const quote = businessOf(call?.businessId)?.consentQuote;
      return quote ? `“${quote}”` : "The owner says: text me.";
    }
    case "text":
      return "Next job: one text, no call.";
    case "confirmed":
      return "The owner replies Y.";
  }
}

const headlineNode = $("#headline");
function renderProgress(): void {
  const final = isFinal();
  body.dataset.final = String(final);
  const index = GOLDEN_STEPS.findIndex((s) => s.key === state.currentStep);
  for (const [i, node] of beatNodes.entries()) node.dataset.state = final || i < index ? "done" : i === index ? "current" : "todo";
  $("#beats").setAttribute("aria-label", final ? "All seven steps done" : index >= 0 ? `Step ${index + 1} of 7: ${GOLDEN_STEPS[index]!.label}` : "Waiting for the first step");
  const text = headline(final);
  if (headlineNode.textContent !== text) {
    // A hyphenated word ("Agent-native") never breaks across lines.
    headlineNode.replaceChildren(...text.split(/(\S+-\S+)/).map((part, i) => (i % 2 ? el("span", "nowrap", part) : document.createTextNode(part))));
    enter(headlineNode);
  }
}

// ---- The acts: the request, the call, the text -------------------------------------------------------

type Act = "ask" | "call" | "text";
const ACT_OF: Record<StepKey, Act> = { ask: "ask", darwin: "ask", call: "call", tools: "call", consent: "call", text: "text", confirmed: "text" };
const ROUTE_LABELS: Record<string, string> = { call: "Routed to a phone call", text: "Routed to a text", darwin_act: "Routed to a Darwin agent" };
const TOOL_LABELS: Record<VoiceTool, string> = {
  check_slot: "Checked the calendar",
  hold_slot: "Held the slot",
  create_booking: "Booked the job",
  record_consent: "Saved the yes to texts",
  set_text_number: "Saved the best cell",
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderAct(): void {
  const act: Act = isFinal() ? "text" : state.currentStep ? ACT_OF[state.currentStep] : "ask";
  for (const name of ["ask", "call", "text"] as const) $(`#act-${name}`).dataset.on = String(name === act);
}

function renderAsk(): void {
  const ask = state.ask;
  const facts = askFacts(ask);
  setText($("#ask-what"), ask?.utterance ? `“${ask.utterance}”` : facts[0] ? capitalize(facts[0]) : "");
  setText($("#ask-facts"), (ask?.utterance ? facts : facts.slice(1)).join("  ·  "));
  setText($("#ask-who"), ask?.agentId ? `from ${ask.agentId}` : "");
  const booking = bookingForAsk(state);
  const darwin = $("#ask-darwin");
  const line = ask ? (darwinSummary(state.darwin, booking?.reasons ?? []) ?? "Asking Darwin first") : undefined;
  darwin.hidden = !line;
  setText(darwin, line ?? "");
  const route = $("#ask-route");
  const label = booking?.route ? (ROUTE_LABELS[booking.route] ?? `Routed by ${booking.route}`) : "";
  if (label && route.hidden) enter(route, { opacity: 0, transform: "translateX(-8px)", filter: "blur(4px)" }, 420);
  route.hidden = !label;
  setText(route, label);
}

const checkNodes = VOICE_TOOLS.map((tool) => {
  const li = el("li", "check");
  li.dataset.state = "idle";
  const mark = el("span", "check-mark");
  mark.setAttribute("aria-hidden", "true");
  const label = el("span", "check-label", TOOL_LABELS[tool]);
  li.title = tool;
  li.append(mark, label);
  $("#checks").append(li);
  return { li, label };
});

function renderCall(): void {
  const call = currentCall(state);
  const nextIdle = call?.state === "In-Progress" ? VOICE_TOOLS.find((t) => call.tools[t].state === "idle") : undefined;
  for (const [i, tool] of VOICE_TOOLS.entries()) {
    const slot = call?.tools[tool];
    const node = checkNodes[i]!;
    node.li.dataset.state = slot?.state ?? "idle";
    node.li.dataset.next = String(tool === nextIdle);
    setText(node.label, slot?.state === "failed" ? `${TOOL_LABELS[tool]}: failed${slot.error ? ` (${slot.error})` : ""}` : TOOL_LABELS[tool]);
  }
  const business = businessOf(call?.businessId);
  const consent = $("#consent");
  consent.hidden = !business?.consentQuote;
  const enabled = business?.channel === "text_enabled";
  consent.dataset.flipped = String(Boolean(business?.consentQuote && enabled));
  setText($("#flip-to"), `Text-enabled${enabled && business?.rail ? ` · ${formatRail(business.rail)}` : ""}`);
}

const statNum = $("#stat-num");
function renderText(): void {
  const { byText } = storyBookings(state);
  const seconds = byText ? confirmSeconds(state, byText) : undefined;
  const value = seconds === undefined ? "" : formatSeconds(seconds);
  if (statNum.textContent !== value) {
    setText(statNum, value);
    if (value) enter(statNum, { opacity: 0, transform: "translateY(18px) scale(0.92)", filter: "blur(8px)" }, 720);
  }
  setText($("#stat-unit"), seconds === undefined ? "" : `second${seconds === 1 ? "" : "s"} from text to confirmed`);
  const sent = byText ? state.messages.find((m) => m.bookingId === byText.id && m.direction === "out") : undefined;
  const business = businessOf(byText?.businessId);
  const reply = byText ? evidenceMessage(state, byText)?.body : undefined;
  const line = !byText ? "" : sent ? `One ${formatRail(sent.channel ?? business?.rail) ?? "text"} to ${business?.numberMasked ?? "the owner's cell"}.${reply ? ` Answered “${reply}”.` : ""}` : "Sending one text to the owner.";
  setText($("#text-line"), line);
}

// ---- The bookings ----------------------------------------------------------------------------------------

function evidenceLine(b: BookingView): string {
  const kind = b.evidence?.kind;
  if (kind === "call") return `Confirmed by call${b.evidence?.quote ? ` · “${b.evidence.quote}”` : ""}`;
  if (kind === "text") {
    const reply = evidenceMessage(state, b)?.body;
    return `Confirmed by text${reply ? ` · “${reply}”` : ""}`;
  }
  if (kind === "rule") return "Confirmed by the owner's standing rule";
  if (b.status === "confirmed") return "Confirmed";
  if (b.status === "declined") return "The owner said no";
  return "Held while the owner decides";
}

const ledger = $("#ledger");
const rowNodes = new Map<string, { li: HTMLLIElement; code: HTMLElement; what: HTMLElement; proof: HTMLElement }>();
function renderLedger(): void {
  const { byCall, byText } = storyBookings(state);
  const shown = [byCall, byText].filter((b, i, all): b is BookingView => Boolean(b) && all.indexOf(b) === i);
  for (const [id, row] of rowNodes) {
    if (shown.some((b) => b.id === id)) continue;
    row.li.remove();
    rowNodes.delete(id);
  }
  for (const b of shown) {
    let row = rowNodes.get(b.id);
    if (!row) {
      row = { li: el("li", "row"), code: el("span", "row-code"), what: el("span", "row-what"), proof: el("span", "row-proof") };
      row.li.append(row.code, row.what, row.proof);
      ledger.append(row.li);
      rowNodes.set(b.id, row);
      enter(row.li);
    }
    const was = row.li.dataset.status;
    row.li.dataset.status = b.status;
    setText(row.code, b.shortCode ?? b.id.slice(-6));
    setText(row.what, [b.service ? capitalize(b.service) : undefined, formatSlot(b.slotStart), formatMoney(b.priceCents)].filter(Boolean).join("  ·  "));
    setText(row.proof, evidenceLine(b));
    if (was && was !== "confirmed" && b.status === "confirmed") enter(row.proof, { opacity: 0, transform: "translateY(6px)", filter: "blur(4px)" }, 480);
  }
}

// ---- The shop's line ----------------------------------------------------------------------------------

const phone = $("#phone");
const captionsRoot = $("#captions");
const bubblesRoot = $("#bubbles");
const thread = $("#thread");
const replies = $("#owner-replies");
const compose = $("#compose");
const composeText = $("#compose-text");

const SCREEN_LABELS: Record<string, string> = {
  lock: "The shop's line, a phone on Dial, locked before any call",
  incoming: "The shop's line: an incoming call from Platypus, AI assistant",
  call: "The shop's line, on the call with Platypus",
  ended: "The shop's line after the call",
  messages: "The shop's line: the text thread with Platypus",
};

function shopTime(ms: number, parts: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleString("en-US", { ...parts, timeZone: SHOP_TIME_ZONE });
}

let captionKey = "";
let captionCount = 0;
function renderCaptions(screen: string): void {
  const call = currentCall(state);
  const elapsed = callElapsedMs(call, clockNow());
  const known = call ? (call.transcript ?? (RECORDING ? RECORDED_TURNS.get(call.id) : undefined)) : undefined;
  // Recorded: reveal each turn when it was said. Live: the transcript lands after the call.
  const turns = !known ? [] : screen === "call" && RECORDING ? captionsAt(known, elapsed) : screen === "ended" || call?.transcript ? mergeTurns(known) : [];
  setText($("#captions-label"), screen === "ended" ? "Transcript" : "Live captions");
  const key = `${call?.id}|${turns.map((t) => t.text.length).join(",")}`;
  if (key === captionKey) return;
  const grew = key.startsWith(`${call?.id}|`) && captionKey.startsWith(`${call?.id}|`) && turns.length > captionCount;
  captionKey = key;
  captionCount = turns.length;
  captionsRoot.replaceChildren(
    ...turns.map((t) => {
      const li = el("li", "cap");
      li.dataset.speaker = t.speaker;
      li.append(el("span", "cap-who", t.speaker === "agent" ? "Platypus · AI" : "Owner"), el("span", "cap-text", t.text));
      return li;
    }),
  );
  if (grew && captionsRoot.lastElementChild) enter(captionsRoot.lastElementChild);
}

function renderCallScreen(screen: string): void {
  const call = currentCall(state);
  if (!call) return;
  const time = $("#call-time");
  if (screen === "ended") setText(time, call.canceled ? "Call ended early" : `Call ended · ${formatClock(call.durationSeconds ?? callElapsedMs(call, clockNow()) / 1000)}`);
  else setText(time, formatClock(callElapsedMs(call, clockNow()) / 1000));
  renderCaptions(screen);
}

const bubbleNodes = new Map<string, HTMLLIElement>();
let typingNode: HTMLLIElement | undefined;
const receipt = el("li", "receipt");
let repliedTo: string | undefined;

function threadMessages(): MessageView[] {
  const last = state.messages.at(-1);
  return last?.businessId ? state.messages.filter((m) => m.businessId === last.businessId) : state.messages;
}

function renderThread(typing: PlannedCue | undefined, composing: PlannedCue | undefined): void {
  const messages = threadMessages();
  const business = businessOf(messages.at(-1)?.businessId);
  const channel = (messages[0]?.channel ?? business?.rail ?? "imessage").toLowerCase();
  phone.dataset.rail = channel === "imessage" ? "imessage" : "sms";
  setText($("#im-service"), channel === "imessage" ? "iMessage" : channel === "whatsapp" ? "WhatsApp" : "Text Message");
  setText($("#im-when"), messages[0] ? `Today ${shopTime(Date.parse(messages[0].at), { hour: "numeric", minute: "2-digit" })}` : "Today");
  let changed = false;
  const ids = new Set(messages.map((m) => m.id));
  for (const [id, node] of bubbleNodes) {
    if (!ids.has(id)) {
      node.remove();
      bubbleNodes.delete(id);
      changed = true;
    }
  }
  if (typingNode && !typing) {
    typingNode.remove();
    typingNode = undefined;
    changed = true;
  }
  for (const m of messages) {
    if (bubbleNodes.has(m.id)) continue;
    // From the owner's side: Platypus's texts arrive (grey, left), the owner's replies go out (blue, right).
    const li = el("li", `bubble ${m.direction === "out" ? "b-them" : "b-me"}`);
    li.append(el("span", "bubble-text", m.body));
    bubblesRoot.append(li);
    bubbleNodes.set(m.id, li);
    // The owner's one-letter answer lands with a little more weight than a grey bubble.
    enter(li, { opacity: 0, transform: `translateY(12px) scale(${m.direction === "out" ? 0.94 : 0.6})`, filter: "blur(2px)" }, m.direction === "out" ? 460 : 620);
    changed = true;
  }
  // Tails go on the last bubble of each run, as in Messages.
  const nodes = messages.map((m) => bubbleNodes.get(m.id)!);
  for (const [i, node] of nodes.entries()) node.classList.toggle("tail", messages[i + 1]?.direction !== messages[i]!.direction);

  const lastMine = [...messages].reverse().find((m) => m.direction === "in");
  if (lastMine) {
    setText(receipt, lastMine.classification ? `Read ${shopTime(Date.parse(lastMine.at), { hour: "numeric", minute: "2-digit" })}` : "Delivered");
    const after = bubbleNodes.get(lastMine.id)!;
    if (after.nextSibling !== receipt) after.after(receipt);
  } else receipt.remove();

  if (typing && !typingNode) {
    typingNode = el("li", "bubble b-them tail typing");
    typingNode.setAttribute("aria-label", "Platypus is typing");
    typingNode.append(el("i"), el("i"), el("i"));
    bubblesRoot.append(typingNode);
    enter(typingNode, { opacity: 0, transform: "scale(0.7)", filter: "none" }, 320);
    changed = true;
  }

  compose.dataset.composing = String(Boolean(composing));
  setText(composeText, composing?.text ?? (channel === "imessage" ? "iMessage" : "Text Message"));

  const waiting = RECORDING ? undefined : awaitingOwner(state);
  replies.hidden = !waiting || waiting.id === repliedTo;
  if (changed) thread.scrollTo({ top: thread.scrollHeight, behavior: body.dataset.hydrating === "true" ? "auto" : "smooth" });
}

let screenNow = "";
function renderPhone(): void {
  const cues = activeCues();
  const typing = cues.find((c) => c.kind === "typing");
  const composing = cues.find((c) => c.kind === "composing");
  const screen = phoneScreen(state, { textComing: Boolean(typing) });
  if (screen !== screenNow) {
    screenNow = screen;
    phone.dataset.screen = screen;
    phone.setAttribute("aria-label", SCREEN_LABELS[screen]!);
    for (const scr of phone.querySelectorAll<HTMLElement>(".scr")) scr.setAttribute("aria-hidden", String(!scr.classList.contains(`scr-${screen}`)));
  }
  const now = RECORDING ? Date.now() : clockNow();
  setText($(".sb-time"), shopTime(now, { hour: "numeric", minute: "2-digit" }).replace(/ [AP]M$/, ""));
  setText($(".lock-time"), shopTime(now, { hour: "numeric", minute: "2-digit" }).replace(/ [AP]M$/, ""));
  setText($("#lock-date"), shopTime(now, { weekday: "long", month: "long", day: "numeric" }));
  if (screen === "call" || screen === "ended") renderCallScreen(screen);
  renderThread(typing, composing);
  // Honest about whose phone this is: the shop's line is a Dial number, called from another Dial number.
  const name = businessOf(shopId())?.name;
  setText($("#phone-note"), `${name ? `${name} line` : "The shop's line"} · ${RECORDING ? "recorded run" : "Dial-to-Dial"}`);
}

for (const button of replies.querySelectorAll<HTMLButtonElement>("button[data-reply]")) {
  button.addEventListener("click", async () => {
    const waiting = awaitingOwner(state);
    if (!waiting) return;
    const reply = button.dataset.reply === "N" ? "N" : "Y";
    for (const b of replies.querySelectorAll<HTMLButtonElement>("button")) b.disabled = true;
    const result = await requestOwnerReply(source.base, reply, source.token);
    for (const b of replies.querySelectorAll<HTMLButtonElement>("button")) b.disabled = false;
    if (result.ok) {
      repliedTo = waiting.id;
      say(result.unconfirmed ? `Sent ${reply} as the owner. It shows here when the server receives it.` : `Sent ${reply} as the owner.`);
    } else say(failure("Owner reply", result));
    schedule();
  });
}

/**
 * The phone is drawn at a real iPhone 16 Pro's size (408 × 854 points with its frame) and
 * scaled to fit: the whole device is always visible, on a projector or a phone.
 */
const fit = $("#phone-fit");
function fitPhone(): void {
  const stacked = innerWidth < 900;
  // Beside the story: the viewport minus the header, the stage's padding and the caption under the phone.
  const availH = stacked ? Math.max(480, innerHeight * 0.72) : innerHeight - 64 - 32 - 56;
  const availW = stacked ? innerWidth - 40 : innerWidth * 0.42;
  const scale = Math.max(0.4, Math.min(0.94, availH / 854, availW / 408));
  fit.style.setProperty("--s", scale.toFixed(4));
}
addEventListener("resize", fitPhone);

// The phone leans a few degrees toward the pointer. With reduced motion it holds still.
const phoneCol = $(".phone-col");
phoneCol.addEventListener("pointermove", (e) => {
  if (stillMotion.matches || e.pointerType !== "mouse") return;
  const r = fit.getBoundingClientRect();
  const clamp = (v: number) => Math.max(-1, Math.min(1, v)).toFixed(3);
  fit.style.setProperty("--tx", clamp(((e.clientX - r.left) / r.width) * 2 - 1));
  fit.style.setProperty("--ty", clamp(((e.clientY - r.top) / r.height) * 2 - 1));
});
phoneCol.addEventListener("pointerleave", () => {
  fit.style.removeProperty("--tx");
  fit.style.removeProperty("--ty");
});

// ---- Details: Darwin, transcript, businesses, supply, stream ---------------------------------------

function fact(label: string, value: string | undefined): HTMLElement | undefined {
  if (value === undefined) return undefined;
  const wrap = el("div", "fact");
  wrap.append(el("dt", "", label), el("dd", "", value));
  return wrap;
}

function darwinDetails(d: DarwinView): HTMLElement[] {
  const nodes: HTMLElement[] = [el("p", "panel-lede", darwinSummary(d) ?? d.status)];
  const facts = el("dl", "facts");
  for (const f of [
    fact("Status", d.rawStatus ?? d.status),
    fact("HTTP", d.httpStatus !== undefined ? String(d.httpStatus) : undefined),
    fact("Latency", formatLatency(d.latencyMs)),
    fact("Provenance", d.provenance ? `${d.provenance}${d.recordedAt ? ` · ${new Date(d.recordedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: SHOP_TIME_ZONE })}` : ""}` : undefined),
    fact("Outcome", d.outcome?.replace(/_/g, " ")),
    fact("Agents", d.status === "completed" || d.agents.length ? String(d.agents.length) : undefined),
  ])
    if (f) facts.append(f);
  nodes.push(facts);
  if (d.query) nodes.push(el("p", "mono-quote", d.query));
  if (d.question) nodes.push(el("p", "panel-note", `Darwin asked: ${d.question}`));
  if (d.noMatchReason) nodes.push(el("p", "panel-note", d.noMatchReason));
  if (d.configError) nodes.push(el("p", "panel-note", `Configuration problem: ${d.configError}`));
  if (d.agents.length) {
    const list = el("ol", "plain-list");
    for (const a of d.agents.slice(0, 4)) list.append(el("li", "", `#${a.rank} ${a.name ?? a.id} · ${a.readiness.replace(/_/g, " ")}${a.reasons[0] ? ` · ${a.reasons[0]}` : ""}`));
    nodes.push(list);
  }
  if (d.attempts.length > 1 || (d.attempts.length === 1 && !d.attempts[0]!.ok)) {
    const list = el("ol", "plain-list mono");
    for (const a of d.attempts) list.append(el("li", "", `${a.status ?? a.errorKind ?? "none"} · ${a.query ?? ""} · ${formatLatency(a.latencyMs) ?? ""}`));
    nodes.push(list);
  }
  return nodes;
}

let lastDetails: unknown[] = [];
function renderDetails(): void {
  const keys = [state.darwin, state.calls, state.businesses, state.messages, state.bookings];
  if (keys.every((k, i) => k === lastDetails[i])) return;
  lastDetails = keys;
  const booking = bookingForAsk(state);
  $("#darwin").replaceChildren(
    ...(state.darwin ? darwinDetails(state.darwin) : [el("p", "panel-note", darwinSummary(undefined, booking?.reasons ?? []) ?? "Not searched yet.")]),
  );

  const call = currentCall(state);
  const transcript = call?.transcript;
  $("#transcript").replaceChildren(
    ...(transcript?.length
      ? transcript.map((t) => {
          const li = el("li", "turn");
          li.dataset.speaker = t.speaker;
          li.append(el("span", "turn-time", formatCallOffset(t.startMs)), el("span", "turn-who", t.speaker === "agent" ? "AI" : "Owner"), el("span", "turn-text", t.text));
          return li;
        })
      : [el("li", "panel-note", call ? "The transcript lands when the call ends." : "No call yet.")]),
  );

  const enabled = state.businessOrder.filter((id) => state.businesses[id]!.channel === "text_enabled").length;
  setText($("#biz-meta"), state.businessOrder.length ? `${enabled} of ${state.businessOrder.length} text-enabled` : "");
  $("#cards").replaceChildren(
    ...state.businessOrder.map((id) => {
      const b = state.businesses[id]!;
      const on = b.channel === "text_enabled";
      const li = el("li", "biz-card");
      li.dataset.channel = on ? "text_enabled" : "phone_only";
      li.append(el("span", "biz-trade", formatTrade(b.trade)), el("span", "biz-name", b.name), el("span", `chip ${on ? "chip-on" : "chip-quiet"}`, on ? `Text-enabled${b.rail ? ` · ${formatRail(b.rail)}` : ""}` : "Phone-only"));
      if (b.consentQuote) li.append(el("span", "biz-quote", `“${b.consentQuote}”`));
      return li;
    }),
  );

  $("#supply").replaceChildren(
    ...supplyRows(state).map((r) => {
      const tr = el("tr");
      const name = el("th", "supply-name");
      name.scope = "row";
      name.append(el("span", "", r.name), el("span", "supply-trade", formatTrade(r.trade)));
      const channel = el("td", "", r.channel === "text_enabled" ? (formatRail(r.rail) ?? "Text") : "Phone");
      const reply = el("td", "num", r.medianReplySeconds !== undefined ? `${formatSeconds(r.medianReplySeconds)} s` : "none");
      const price = el("td", "num", formatMoney(r.lastPriceCents) ?? "none");
      const optIn = el("td", "num", r.optIn.length ? r.optIn.map((v) => `${Math.round(v.rate * 100)}% ${v.version} (${v.consents}/${v.calls})`).join(", ") : "none");
      tr.append(name, channel, reply, price, optIn);
      return tr;
    }),
  );
}

const streamRoot = $("#stream");
const streamNodes = new Map<string, HTMLLIElement>();
function renderStream(): void {
  const keep = new Set(state.events.map((e) => e.id));
  for (const [id, node] of streamNodes) {
    if (!keep.has(id)) {
      node.remove();
      streamNodes.delete(id);
    }
  }
  for (const event of state.events) {
    if (streamNodes.has(event.id)) continue;
    const li = el("li", "ev");
    li.dataset.actor = event.actor;
    li.append(el("time", "ev-time", formatTime(event.created_at)), el("span", "ev-actor", event.actor), el("span", "ev-type", event.type), el("span", "ev-detail", summarize(event)), el("span", "ev-conf", formatConfidence(event.confidence)));
    li.title = event.reason ?? "";
    streamRoot.prepend(li);
    streamNodes.set(event.id, li);
  }
  const count = `${state.eventCount} event${state.eventCount === 1 ? "" : "s"}`;
  setText($("#stream-meta"), count);
  setText($("#more-meta"), count);
}

// ---- Kill switch ----------------------------------------------------------------------------------------

let killArmed: ReturnType<typeof setTimeout> | undefined;
function renderKill(): void {
  replayed.hidden = !state.replayed || RECORDING;
  if (RECORDING) return;
  const call = currentCall(state);
  const live = Boolean(call && call.state !== "Terminated");
  killButton.hidden = !live;
  if (!live && killArmed) disarmKill();
}

function disarmKill(): void {
  if (killArmed) clearTimeout(killArmed);
  killArmed = undefined;
  killButton.dataset.armed = "false";
  setText(killButton, "Kill call");
}

killButton.addEventListener("click", async () => {
  if (!killArmed) {
    // Two clicks, so a stray one never ends a live call.
    killButton.dataset.armed = "true";
    setText(killButton, "Click again to end the call");
    killArmed = setTimeout(disarmKill, 3_000);
    return;
  }
  disarmKill();
  killButton.disabled = true;
  const result = await requestKillCall(source.base, source.token);
  killButton.disabled = false;
  say(result.ok ? (result.unconfirmed ? "Kill switch sent. Watch the phone for the call to end." : "Kill switch sent. The call ends in a moment.") : failure("Kill switch", result));
  renderKill();
});

// ---- Render loop ------------------------------------------------------------------------------------------

let frame = 0;
function render(): void {
  frame = 0;
  renderProgress();
  renderAct();
  renderAsk();
  renderCall();
  renderText();
  renderLedger();
  renderPhone();
  renderKill();
  renderDetails();
  renderStream();
}

function schedule(): void {
  if (!frame) frame = requestAnimationFrame(render);
}

function dispatch(event: StreamEvent): void {
  if (!RECORDING) history.push(event);
  const next = reduce(state, event);
  if (next === state) return;
  state = next;
  schedule();
}

/** Draws `next` from scratch without motion; anything that arrives after it moves as usual. */
function resetTo(next: DashboardState): void {
  body.dataset.hydrating = "true";
  state = next;
  for (const map of [bubbleNodes, streamNodes, rowNodes]) map.clear();
  for (const root of [bubblesRoot, streamRoot, captionsRoot, ledger]) root.replaceChildren();
  typingNode = undefined;
  captionKey = "";
  screenNow = "";
  lastDetails = [];
  render();
  settle();
}

// The phone's clock, call timer, captions and cues move between events too.
setInterval(() => {
  if (!frame) renderPhone();
}, 200);

// ---- Data source ---------------------------------------------------------------------------------------------

/**
 * A restarted gateway in fakes mode begins a fresh log. A reconnecting stream only asks for
 * events after the last id it saw (and behind the dev proxy a dead stream can look open for
 * half a minute), so the old run would stay on screen under the new one. So every few seconds,
 * and after every reconnect, compare the log's first event with ours; when it changed, clear
 * the page and read the new log from its start.
 */
const FRESH_LOG_POLL_MS = 3_000;
let checking = false;
async function checkForFreshLog(): Promise<void> {
  const ours = history[0]?.id;
  if (!ours || checking) return;
  checking = true;
  try {
    const response = await fetch(withToken(`${source.base}/events?limit=1`, source.token));
    if (!response.ok) return;
    const page = (await response.json()) as { events?: { id?: unknown }[] };
    const first = page.events?.[0]?.id;
    if (first === ours || history[0]?.id !== ours) return;
    history = [];
    resetTo(initialState());
    say("The server started a fresh event log. Showing the new run.");
    connect();
  } catch {
    // The server is down or restarting; the next poll tries again.
  } finally {
    checking = false;
  }
}

let disconnect: (() => void) | undefined;
/** Opens the stream from the start of the log. Its backlog is drawn without motion; "ready" says the rest is live. */
function connect(): void {
  disconnect?.();
  body.dataset.hydrating = "true";
  const backstop = setTimeout(settle, 2_500);
  let connections = 0;
  disconnect = connectLive(
    source.base,
    {
      onEvent: dispatch,
      onState: setConnection,
      onReady: () => {
        connections += 1;
        if (connections > 1) return void checkForFreshLog();
        clearTimeout(backstop);
        settle();
      },
    },
    { token: source.token },
  );
}

async function onReplay(): Promise<void> {
  replayButton.disabled = true;
  try {
    if (RECORDING) {
      scrollTo({ top: 0, behavior: "smooth" });
      playRecording();
      return;
    }
    // Clear first, so the replayed run plays from the lock screen; undo if the server says no.
    const before = history;
    resetTo(initialState());
    if (!(await requestReplay(source.base, source.token))) {
      resetTo(reduceAll(before));
      say("Replay is only available on a fakes server (DEMO_MODE=fakes).");
    }
  } finally {
    setTimeout(() => (replayButton.disabled = false), 1_200);
  }
}
replayButton.addEventListener("click", () => void onReplay());

fitPhone();
void document.fonts?.ready.then(fitPhone);
render();
if (RECORDING) {
  setConnection("recording");
  conn.title = "No server behind this page: it plays the golden path recorded against the test fakes.";
  settle();
  // Autoplay once the page is actually visible, so nobody misses the first beat.
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
  connect();
  setInterval(() => {
    if (document.visibilityState === "visible") void checkForFreshLog();
  }, FRESH_LOG_POLL_MS);
}
