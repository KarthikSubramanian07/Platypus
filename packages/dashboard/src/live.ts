import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/jetbrains-mono";
import "./live.css";
import { $, el, setText } from "./dom";
import { connectLive, CONNECTION_LABELS, requestKillCall, requestOwnerReply, requestReplay, resolveSource, type ConnectionState, type DemoResult } from "./events";
import { cuesAt, GOLDEN_PATH, planRecording, recordedAt, type PlannedCue } from "./fixture";
import {
  formatCallOffset,
  formatClock,
  formatConfidence,
  formatLatency,
  formatMoney,
  formatRail,
  formatSlot,
  formatTime,
  formatTrade,
  GOLDEN_STEPS,
  SHOP_TIME_ZONE,
  summarize,
  type StepKey,
  type StreamEvent,
} from "./format";
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
 * /live: the demo as a judge follows it. The owner's phone on the left (the call,
 * then the text thread), three story cards on the right, and everything technical
 * folded away below. Every region is a view of DashboardState, folded from the event
 * stream by the pure reduce(); event text reaches the DOM through textContent only.
 */

const source = resolveSource(location.search, { PROD: import.meta.env.PROD, VITE_EVENTS_URL: import.meta.env.VITE_EVENTS_URL as string | undefined });
const RECORDING = source.mode === "recording";

let state: DashboardState = initialState();
/** Every event received in live mode, so a failed replay request can be undone. */
const history: StreamEvent[] = [];

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
  resetTo(initialState());
  run.active = true;
  run.finished = false;
  run.epoch = Date.now();
  run.wallStart = performance.now();
  run.tag += 1;
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

// ---- Header and progress -------------------------------------------------------------------------

const body = document.body;
const conn = $("#conn");
const replayed = $("#replayed");
const killButton = $<HTMLButtonElement>("#kill");
const replayButton = $<HTMLButtonElement>("#replay");
const replayFinal = $<HTMLButtonElement>("#replay-final");
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

const beatNodes = GOLDEN_STEPS.map((step, i) => {
  const li = el("li", "beat");
  li.title = `${String(i + 1).padStart(2, "0")} ${step.label}`;
  $("#beats").append(li);
  return li;
});

function isFinal(): boolean {
  if (!state.reached.includes("confirmed")) return false;
  return RECORDING ? run.finished : true;
}

function renderProgress(): void {
  const final = isFinal();
  body.dataset.final = String(final);
  for (const [i, step] of GOLDEN_STEPS.entries()) {
    beatNodes[i]!.dataset.state = final || (state.reached.includes(step.key) && step.key !== state.currentStep) ? "done" : step.key === state.currentStep ? "current" : "todo";
  }
  const current = GOLDEN_STEPS.find((s) => s.key === state.currentStep);
  const index = current ? GOLDEN_STEPS.indexOf(current) + 1 : 0;
  const label = final ? "Done · 7 of 7" : current ? `${index} of ${GOLDEN_STEPS.length} · ${current.label}` : RECORDING ? "Recorded run" : "Waiting for the agent";
  setText($("#beat-label"), label);
  setText($("#beat-caption"), final ? FINAL_LINE : (current?.caption ?? "A customer's AI agent is about to ask Platypus for an oil change."));
  replayFinal.hidden = !(final && RECORDING);
  replayed.hidden = !state.replayed || RECORDING;
}

// ---- Story cards ------------------------------------------------------------------------------------

const STAGE_OF: Record<StepKey, number> = { ask: 1, darwin: 1, call: 2, tools: 2, consent: 2, text: 3, confirmed: 3 };

function cardState(card: number): "todo" | "active" | "done" | "final" {
  // At the end the payoff card stays open; the two before it fold to their results.
  if (isFinal()) return card === 3 ? "final" : "done";
  const stage = state.currentStep ? STAGE_OF[state.currentStep] : 0;
  return stage > card ? "done" : stage === card ? "active" : "todo";
}

const ROUTE_LABELS: Record<string, string> = { call: "Routed to a phone call", text: "Routed to a text", darwin_act: "Routed to a Darwin agent" };

function renderAskCard(): void {
  $("#card-ask").dataset.state = cardState(1);
  const ask = state.ask;
  setText($("#ask-who"), ask?.agentId ? `from ${ask.agentId}` : "");
  const quote = $("#ask-quote");
  setText(quote, ask?.utterance ? `“${ask.utterance}”` : ask ? "" : "Waiting for a customer's agent to ask for something.");
  quote.dataset.empty = String(!ask);
  quote.hidden = Boolean(ask && !ask.utterance);
  setText($("#ask-facts"), askFacts(ask).join("  ·  "));
  const booking = bookingForAsk(state);
  const darwin = $("#ask-darwin");
  const line = darwinSummary(state.darwin, booking?.reasons ?? []) ?? (ask ? "Asking Darwin first…" : "");
  setText(darwin, line);
  darwin.dataset.status = state.darwin?.status ?? (line ? "none" : "idle");
  const route = $("#ask-route");
  route.hidden = !booking?.route;
  setText(route, booking?.route ? (ROUTE_LABELS[booking.route] ?? `Routed by ${booking.route}`) : "");
  route.dataset.route = booking?.route ?? "";
}

const TOOL_LABELS: Record<VoiceTool, string> = {
  check_slot: "Checked the calendar",
  hold_slot: "Held the slot",
  create_booking: "Booked the job",
  record_consent: "Saved the yes to texts",
  set_text_number: "Saved the best cell",
};

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

function bookedCard(root: HTMLElement, b: BookingView | undefined, evidence: string): void {
  root.hidden = !b;
  if (!b) return;
  root.dataset.status = b.status;
  const top = el("p", "booked-top");
  top.append(el("span", "booked-code", b.shortCode ?? b.id.slice(-6)), el("span", "booked-status", b.status === "confirmed" ? "Confirmed" : b.status.replace(/_/g, " ")));
  const what = el("p", "booked-what", [b.service ? b.service.charAt(0).toUpperCase() + b.service.slice(1) : undefined, formatSlot(b.slotStart), formatMoney(b.priceCents)].filter(Boolean).join("  ·  "));
  const proof = el("p", "booked-evidence", evidence);
  if (b.fromTranscript) proof.append(el("span", "chip chip-quiet", "from transcript"));
  root.replaceChildren(top, what, proof);
}

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

function renderCallCard(): void {
  $("#card-call").dataset.state = cardState(2);
  const call = currentCall(state);
  const { byCall } = storyBookings(state);
  const business = call?.businessId ? state.businesses[call.businessId] : byCall?.businessId ? state.businesses[byCall.businessId] : undefined;
  setText($("#call-who"), business ? `to ${business.name}` : "");
  let lede = "When no agent covers the job, Platypus calls the shop. Its first sentence says it is an AI.";
  if (call) {
    const name = business?.name ?? "the shop";
    if (call.state === "Queued" || call.state === "Ringing") lede = `Ringing ${name}. The first sentence will say it is an AI.`;
    else if (call.state === "In-Progress") lede = `On the line with ${name}. It said it was an AI first, then booked while the owner talked.`;
    else if (call.canceled) lede = `The call to ${name} was ended early.`;
    else lede = `A ${formatClock(call.durationSeconds ?? callElapsedMs(call, clockNow()) / 1000)} call to ${name}. AI disclosed in the first sentence.`;
  }
  const ledeNode = $("#call-lede");
  setText(ledeNode, lede);
  ledeNode.dataset.empty = String(!call);
  const nextIdle = call?.state === "In-Progress" ? VOICE_TOOLS.find((t) => call.tools[t].state === "idle") : undefined;
  for (const [i, tool] of VOICE_TOOLS.entries()) {
    const slot = call?.tools[tool];
    const node = checkNodes[i]!;
    node.li.dataset.state = slot?.state ?? "idle";
    node.li.dataset.next = String(tool === nextIdle);
    setText(node.label, slot?.state === "failed" ? `${TOOL_LABELS[tool]}: failed${slot.error ? ` (${slot.error})` : ""}` : TOOL_LABELS[tool]);
  }
  bookedCard($("#call-booking"), byCall, byCall ? evidenceLine(byCall) : "");
  const consent = $("#consent");
  consent.hidden = !business?.consentQuote;
  if (business?.consentQuote) {
    setText($("#consent-quote"), `“${business.consentQuote}”`);
    const enabled = business.channel === "text_enabled";
    consent.dataset.flipped = String(enabled);
    setText($("#flip-to"), enabled ? `Text-enabled${business.rail ? ` · ${formatRail(business.rail)}` : ""}` : "Text-enabled");
  }
}

function formatSeconds(s: number): string {
  return s < 10 && s % 1 ? s.toFixed(1) : String(Math.round(s));
}

function renderTextCard(): void {
  $("#card-text").dataset.state = cardState(3);
  const { byText } = storyBookings(state);
  const business = byText?.businessId ? state.businesses[byText.businessId] : undefined;
  const lede = $("#text-lede");
  lede.dataset.empty = String(!byText);
  if (!byText) setText(lede, "After one yes, the next job goes out as one text. No call.");
  else {
    const sent = state.messages.find((m) => m.bookingId === byText.id && m.direction === "out");
    const rail = formatRail(sent?.channel ?? business?.rail);
    setText(lede, sent ? `No call. One ${rail ?? "text"} to ${business?.numberMasked ?? "the owner's cell"}, answered with one letter.` : "No call this time. Sending one text to the owner…");
  }
  bookedCard($("#text-booking"), byText, byText ? evidenceLine(byText) : "");
  const seconds = byText ? confirmSeconds(state, byText) : undefined;
  const stat = $("#text-stat");
  stat.hidden = seconds === undefined;
  if (seconds !== undefined) {
    stat.replaceChildren(el("b", "", formatSeconds(seconds)), document.createTextNode(` second${seconds === 1 ? "" : "s"} from text to confirmed`));
  }
}

// ---- The owner's phone ------------------------------------------------------------------------------

const phone = $("#phone");
const captionsRoot = $("#captions");
const bubblesRoot = $("#bubbles");
const thread = $("#thread");
const replies = $("#owner-replies");
const compose = $("#compose");
const composeText = $("#compose-text");

const SCREEN_LABELS: Record<string, string> = {
  lock: "The shop owner's phone, locked, before any call",
  incoming: "The shop owner's phone: an incoming call from Platypus, AI assistant",
  call: "The shop owner's phone, on the call with Platypus, with live captions",
  ended: "The shop owner's phone after the call",
  messages: "The shop owner's phone: the text thread with Platypus",
};

function shopTime(ms: number, parts: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleString("en-US", { ...parts, timeZone: SHOP_TIME_ZONE });
}

let captionKey = "";
function renderCaptions(screen: string): void {
  const call = currentCall(state);
  const elapsed = callElapsedMs(call, clockNow());
  const known = call ? (call.transcript ?? (RECORDING ? RECORDED_TURNS.get(call.id) : undefined)) : undefined;
  // Recorded: reveal each turn when it was said. Live: the transcript lands after the call.
  const turns = !known ? [] : screen === "call" && RECORDING ? captionsAt(known, elapsed) : screen === "ended" || call?.transcript ? mergeTurns(known) : [];
  const tools = call && !turns.length ? VOICE_TOOLS.filter((t) => call.tools[t].state !== "idle") : [];
  const key = `${call?.id}|${turns.length}|${tools.map((t) => call?.tools[t].state).join(",")}`;
  setText($("#captions-label"), turns.length ? (screen === "ended" ? "Transcript" : "Live captions") : tools.length ? "Platypus is booking" : screen === "ended" ? "Call ended" : "Live captions");
  if (key === captionKey) return;
  captionKey = key;
  if (turns.length) {
    captionsRoot.replaceChildren(
      ...turns.map((t) => {
        const li = el("li", "cap");
        li.dataset.speaker = t.speaker;
        li.append(el("span", "cap-who", t.speaker === "agent" ? "Platypus · AI" : "You"), el("span", "cap-text", t.text));
        return li;
      }),
    );
  } else {
    captionsRoot.replaceChildren(
      ...tools.map((t) => {
        const li = el("li", "cap cap-tool");
        li.dataset.state = call!.tools[t].state;
        li.append(el("span", "cap-text", call!.tools[t].state === "failed" ? `${TOOL_LABELS[t]}: failed` : TOOL_LABELS[t]));
        return li;
      }),
    );
  }
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
  const business = messages.at(-1)?.businessId ? state.businesses[messages.at(-1)!.businessId!] : undefined;
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
  for (const m of messages) {
    if (bubbleNodes.has(m.id)) continue;
    // From the owner's side: Platypus's texts arrive (grey, left), the owner's replies go out (blue, right).
    const li = el("li", `bubble ${m.direction === "out" ? "b-them" : "b-me"}`);
    li.append(el("span", "bubble-text", m.body));
    bubblesRoot.append(li);
    bubbleNodes.set(m.id, li);
    changed = true;
  }
  // Tails go on the last bubble of each run, as in Messages.
  const nodes = messages.map((m) => bubbleNodes.get(m.id)!);
  for (const [i, node] of nodes.entries()) node.classList.toggle("tail", messages[i + 1]?.direction !== messages[i]!.direction);

  const lastMine = [...messages].reverse().find((m) => m.direction === "in");
  if (lastMine) {
    const read = lastMine.classification ? `Read ${shopTime(Date.parse(lastMine.at), { hour: "numeric", minute: "2-digit" })}` : "Delivered";
    setText(receipt, read);
    const after = bubbleNodes.get(lastMine.id)!;
    if (after.nextSibling !== receipt) after.after(receipt);
  } else receipt.remove();

  if (typing && !typingNode) {
    typingNode = el("li", "bubble b-them tail typing");
    typingNode.setAttribute("aria-label", "Platypus is typing");
    typingNode.append(el("i"), el("i"), el("i"));
    bubblesRoot.append(typingNode);
    changed = true;
  } else if (!typing && typingNode) {
    typingNode.remove();
    typingNode = undefined;
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

function failure(what: string, result: DemoResult): string {
  if (result.status === 404) return `${what}: this server has no demo controls (404).`;
  return result.status ? `${what} failed (HTTP ${result.status}).` : `${what} failed: the server did not answer.`;
}

/**
 * The phone is drawn at a real iPhone's size (402 × 860 points with its frame) and
 * scaled to fit: the whole device is always visible, on a projector or a phone.
 */
const fit = $("#phone-fit");
function fitPhone(): void {
  const stacked = innerWidth < 700;
  const top = fit.getBoundingClientRect().top + scrollY;
  // Stacked on a phone, the device fits below the header and progress, with a floor so it stays legible.
  const availH = Math.max(stacked ? 520 : 0, innerHeight - top - (stacked ? 16 : 28));
  const availW = stacked ? innerWidth - 40 : innerWidth * 0.44;
  const scale = Math.max(0.4, Math.min(0.94, availH / 860, availW / 402));
  fit.style.setProperty("--s", scale.toFixed(4));
}
addEventListener("resize", fitPhone);

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
  renderAskCard();
  renderCallCard();
  renderTextCard();
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

/** Clears every region and draws `next` from scratch, without replaying transitions. */
function resetTo(next: DashboardState): void {
  body.dataset.hydrating = "true";
  state = next;
  for (const map of [bubbleNodes, streamNodes]) map.clear();
  bubblesRoot.replaceChildren();
  streamRoot.replaceChildren();
  captionsRoot.replaceChildren();
  typingNode = undefined;
  captionKey = "";
  screenNow = "";
  lastDetails = [];
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => (body.dataset.hydrating = "false")));
}

// The phone's clock, call timer, captions and cues move between events too.
setInterval(() => {
  if (!frame) renderPhone();
  if (RECORDING && run.active) renderCallCard();
}, 200);

// ---- Data source ---------------------------------------------------------------------------------------------

async function onReplay(): Promise<void> {
  replayButton.disabled = replayFinal.disabled = true;
  try {
    if (RECORDING) {
      scrollTo({ top: 0, behavior: "smooth" });
      playRecording();
    } else {
      const cutoff = history.length;
      if (await requestReplay(source.base, source.token)) resetTo(reduceAll(history.slice(cutoff)));
      else say("Replay is only available on a fakes server (DEMO_MODE=fakes).");
    }
  } finally {
    setTimeout(() => (replayButton.disabled = replayFinal.disabled = false), 1_200);
  }
}
replayButton.addEventListener("click", () => void onReplay());
replayFinal.addEventListener("click", () => void onReplay());

fitPhone();
void document.fonts?.ready.then(fitPhone);
render();
if (RECORDING) {
  setConnection("recording");
  conn.title = "No server behind this page: it plays the golden path recorded against the test fakes.";
  body.dataset.hydrating = "false";
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
  // Until the server says the backlog is done, updates land without animation.
  const settle = setTimeout(() => (body.dataset.hydrating = "false"), 2_500);
  connectLive(source.base, {
    onEvent: dispatch,
    onState: setConnection,
    onReady: () => {
      clearTimeout(settle);
      requestAnimationFrame(() => requestAnimationFrame(() => (body.dataset.hydrating = "false")));
    },
  }, { token: source.token });
}
