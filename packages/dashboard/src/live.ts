import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/jetbrains-mono";
import "./live.css";
import { $, el, setText } from "./dom";
import { connectLive, CONNECTION_LABELS, requestKillCall, requestReplay, resolveSource, type ConnectionState } from "./events";
import { GOLDEN_PATH, playRecording } from "./fixture";
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
  initials,
  SHOP_TIME_ZONE,
  summarize,
  type StreamEvent,
} from "./format";
import {
  bookingForCall,
  currentCall,
  evidenceMessage,
  initialState,
  reduce,
  reduceAll,
  supplyRows,
  VOICE_TOOLS,
  type BookingView,
  type BusinessView,
  type CallView,
  type DarwinView,
  type DashboardState,
  type MessageView,
  type VoiceTool,
} from "./state";

/**
 * /live: the operator dashboard on screen during the demo. Every region is a
 * view of DashboardState, which is folded from the event stream by reduce().
 * Regions update in place, keyed by entity id, so transitions (a tool lighting,
 * a card flipping) play once when their event lands, and not again on the next one.
 */

const source = resolveSource(location.search, { PROD: import.meta.env.PROD, VITE_EVENTS_URL: import.meta.env.VITE_EVENTS_URL as string | undefined });
const RECORDING = source.mode === "recording";

let state: DashboardState = initialState();
/** Every event received in live mode, so a failed replay request can be undone. */
const history: StreamEvent[] = [];

// ---- Header ------------------------------------------------------------------------------

const body = document.body;
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
  noticeTimer = setTimeout(() => (notice.hidden = true), 4_000);
}

// ---- Golden-path beats ---------------------------------------------------------------------

const beats = $("#beats");
const beatNodes = GOLDEN_STEPS.map((step, i) => {
  const li = el("li", "beat-seg");
  li.title = `${String(i + 1).padStart(2, "0")} ${step.label}`;
  beats.append(li);
  return li;
});

function renderBeats(): void {
  for (const [i, step] of GOLDEN_STEPS.entries()) {
    const node = beatNodes[i]!;
    node.dataset.state = step.key === state.currentStep ? "current" : state.reached.includes(step.key) ? "done" : "todo";
  }
  const current = GOLDEN_STEPS.find((s) => s.key === state.currentStep);
  const index = current ? GOLDEN_STEPS.indexOf(current) + 1 : 0;
  setText($("#beat-label"), current ? `${String(index).padStart(2, "0")} / ${String(GOLDEN_STEPS.length).padStart(2, "0")} · ${current.label}` : "Waiting for the agent");
  setText($("#beat-caption"), current?.caption ?? "Nothing has happened yet. The first event is a customer's agent asking for something.");
}

// ---- (b) Darwin --------------------------------------------------------------------------------

const DARWIN_HEADLINES: Record<string, string> = {
  completed: "Agents found",
  needs_input: "Darwin needs input",
  no_match: "No agent covers this",
  error: "Darwin unavailable",
  disabled: "Darwin is switched off",
  unknown: "Unrecognized status",
};

function fact(label: string, value: string | undefined, className = ""): HTMLElement | undefined {
  if (value === undefined) return undefined;
  const wrap = el("div", `fact ${className}`.trim());
  wrap.append(el("dt", "", label), el("dd", "", value));
  return wrap;
}

function renderAsk(): HTMLElement | undefined {
  const ask = state.ask;
  if (!ask) return undefined;
  const box = el("div", "ask");
  box.append(el("p", "eyebrow-sm", ask.agentId ? `${ask.agentId} asked` : "The agent asked"));
  if (ask.utterance) box.append(el("p", "ask-quote", `“${ask.utterance}”`));
  const window = ask.windowStart ? [formatSlot(ask.windowStart), ask.windowEnd ? formatSlot(ask.windowEnd)?.replace(/^\w+ /, "") : undefined].filter(Boolean).join(" to ") : undefined;
  const chips = [ask.service, ask.budgetCents !== undefined ? `under ${formatMoney(ask.budgetCents)}` : undefined, window, ask.location].filter((x): x is string => Boolean(x));
  if (chips.length) {
    const row = el("p", "ask-chips");
    for (const chip of chips) row.append(el("span", "chip", chip));
    box.append(row);
  }
  return box;
}

function renderDarwinResult(d: DarwinView): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  const head = el("div", "darwin-head");
  head.dataset.status = d.status;
  const title = el("p", "darwin-status");
  title.append(el("i", "status-dot"), document.createTextNode(d.status === "completed" && d.agents.length ? `${d.agents.length} agent${d.agents.length === 1 ? "" : "s"} found` : DARWIN_HEADLINES[d.status]!));
  head.append(title);
  const badges = el("p", "badges");
  badges.append(el("span", "badge badge-mono", d.rawStatus ?? d.status));
  if (d.provenance === "recorded") {
    const when = d.recordedAt ? new Date(d.recordedAt) : undefined;
    const label = when && !Number.isNaN(when.getTime()) ? `recorded · ${when.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: SHOP_TIME_ZONE })}` : "recorded";
    const b = el("span", "badge badge-recorded", label);
    b.title = "A real Darwin response, recorded from api.darwin.so and replayed here. Not a new search.";
    badges.append(b);
  } else if (d.provenance) badges.append(el("span", "badge", d.provenance));
  if (d.cached) {
    const b = el("span", "badge badge-cached", "cached");
    b.title = "The last live answer for the same search, not a new request";
    badges.append(b);
  }
  head.append(badges);
  nodes.push(head);

  const facts = el("dl", "facts");
  for (const f of [
    fact("HTTP", d.httpStatus !== undefined ? String(d.httpStatus) : undefined, d.httpStatus !== undefined && d.httpStatus >= 400 ? "fact-bad" : ""),
    fact("Latency", formatLatency(d.latencyMs)),
    fact("Outcome", d.outcome?.replace(/_/g, " ")),
    fact("Agents", d.status === "completed" || d.agents.length ? String(d.agents.length) : undefined),
  ])
    if (f) facts.append(f);
  if (facts.childElementCount) nodes.push(facts);

  if (d.query) {
    const q = el("p", "darwin-query");
    q.append(el("span", "eyebrow-sm", "Query sent"), el("span", "mono-quote", d.query));
    nodes.push(q);
  }
  if (d.question) nodes.push(el("blockquote", "darwin-say", d.question));
  if (d.noMatchReason) nodes.push(el("blockquote", "darwin-say", d.noMatchReason));
  if (d.configError) nodes.push(el("p", "darwin-warn", `Configuration problem: ${d.configError}`));

  if (d.agents.length) {
    const agents = el("ol", "agents");
    for (const a of d.agents.slice(0, 4)) {
      const li = el("li", "agent");
      li.dataset.readiness = a.readiness;
      const top = el("div", "agent-top");
      top.append(el("span", "agent-rank", `#${a.rank}`), el("span", "agent-name", a.name ?? a.id), el("span", "readiness", a.readiness.replace(/_/g, " ")));
      li.append(top);
      if (a.id === d.candidateAgentId || a.canStartThread) li.append(el("span", "agent-start", "can start a thread"));
      if (a.reasons[0]) li.append(el("p", "agent-reason", a.reasons[0]));
      agents.append(li);
    }
    nodes.push(agents);
  }

  if (d.attempts.length > 1 || (d.attempts.length === 1 && !d.attempts[0]!.ok)) {
    const ladder = el("ol", "ladder");
    ladder.setAttribute("aria-label", "Search ladder");
    for (const a of d.attempts) {
      const li = el("li", "rung");
      li.dataset.ok = String(a.ok);
      li.append(el("span", "rung-status", a.status !== undefined ? String(a.status) : (a.errorKind ?? "none")), el("span", "rung-query", a.query ?? ""), el("span", "rung-ms", formatLatency(a.latencyMs) ?? ""));
      ladder.append(li);
    }
    nodes.push(ladder);
  }
  return nodes;
}

function renderRouting(): HTMLElement | undefined {
  const r = state.routing;
  if (!r) return undefined;
  const box = el("div", "route");
  const head = el("p", "route-head");
  head.append(el("span", "eyebrow-sm", "Route"), el("span", `route-chip route-${r.route ?? "unknown"}`, r.route ? `by ${r.route}` : "pending"));
  if (r.shortCode) head.append(el("span", "route-code", r.shortCode));
  box.append(head);
  if (r.reasons.length) {
    const ul = el("ul", "route-reasons");
    for (const reason of r.reasons) ul.append(el("li", "", reason));
    box.append(ul);
  }
  return box;
}

let lastDarwin: unknown[] = [];
function renderDarwin(): void {
  const keys = [state.darwin, state.ask, state.routing];
  if (keys.every((k, i) => k === lastDarwin[i])) return;
  lastDarwin = keys;
  const root = $("#darwin");
  const nodes: (HTMLElement | undefined)[] = [renderAsk()];
  if (state.darwin) nodes.push(...renderDarwinResult(state.darwin));
  else {
    const empty = el("div", "darwin-head");
    empty.dataset.status = "idle";
    const title = el("p", "darwin-status");
    title.append(el("i", "status-dot"), document.createTextNode("Not searched yet"));
    empty.append(title, el("p", "hint", "Darwin is asked first, in case an agent already covers the job."));
    nodes.push(empty);
  }
  nodes.push(renderRouting());
  root.replaceChildren(...nodes.filter((n): n is HTMLElement => n !== undefined));
  setText($("#darwin-meta"), state.darwin ? formatTime(state.darwin.at) : "");
}

// ---- (c) Call ------------------------------------------------------------------------------------

const TOOL_LABELS: Record<VoiceTool, string> = {
  check_slot: "Checks the calendar",
  hold_slot: "Holds the slot",
  create_booking: "Books the job",
  record_consent: "Stores the yes to texts",
  set_text_number: "Saves the best cell",
};
const CALL_STATES = [
  { key: "Queued", label: "Queued" },
  { key: "Ringing", label: "Ringing" },
  { key: "In-Progress", label: "In progress" },
  { key: "Terminated", label: "Ended" },
] as const;

const callRoot = $("#call");
const callView = (() => {
  const top = el("div", "call-top");
  const who = el("div", "call-who");
  const eyebrow = el("p", "eyebrow-sm", "No call yet");
  const name = el("p", "call-name", "Waiting for a call");
  who.append(eyebrow, name);
  const clock = el("div", "call-clock");
  const timer = el("span", "timer", "0:00");
  const cap = el("span", "timer-cap", "");
  clock.append(timer, cap);
  top.append(who, clock);

  const capBar = el("div", "cap-bar");
  const capFill = el("i", "");
  capBar.append(capFill);

  const states = el("ol", "call-states");
  const stateNodes = CALL_STATES.map((s) => {
    const li = el("li", "call-state", s.label);
    states.append(li);
    return li;
  });

  const tools = el("ol", "tools");
  tools.setAttribute("aria-label", "Mid-call booking tools");
  const toolNodes = VOICE_TOOLS.map((tool, i) => {
    const li = el("li", "tool");
    li.dataset.state = "idle";
    const node = el("span", "tool-node");
    node.setAttribute("aria-hidden", "true");
    const text = el("span", "tool-text");
    text.append(el("span", "tool-name", tool), el("span", "tool-label", TOOL_LABELS[tool]));
    const at = el("span", "tool-at", String(i + 1).padStart(2, "0"));
    li.append(node, text, at);
    tools.append(li);
    return { li, at, label: text.lastElementChild as HTMLElement };
  });

  const facts = el("div", "call-facts");
  const transcriptHead = el("p", "eyebrow-sm transcript-head", "Transcript");
  const transcript = el("ol", "transcript");
  callRoot.append(top, capBar, states, tools, facts, transcriptHead, transcript);
  return { eyebrow, name, timer, cap, capFill, stateNodes, toolNodes, facts, transcript, transcriptHead };
})();

/** Seconds on the call clock: live while in progress, Dial's duration once it ended. */
function callSeconds(call: CallView, now = Date.now()): number {
  if (call.durationSeconds !== undefined) return call.durationSeconds;
  if (!call.inProgressAt) return 0;
  const end = call.endedAt ? Date.parse(call.endedAt) : now;
  return Math.max(0, (end - Date.parse(call.inProgressAt)) / 1000);
}

function tickTimer(): void {
  const call = currentCall(state);
  if (!call) return;
  const seconds = callSeconds(call);
  setText(callView.timer, formatClock(seconds));
  const max = call.maxSeconds ?? 120;
  callView.capFill.style.transform = `scaleX(${Math.min(1, seconds / max)})`;
  callView.capFill.parentElement!.dataset.warn = String(seconds / max > 0.8);
}

let lastCall: unknown[] = [];
function renderCall(): void {
  const call = currentCall(state);
  const booking = bookingForCall(state, call);
  const business = call?.businessId ? state.businesses[call.businessId] : undefined;
  const keys = [call, booking, business?.name];
  if (keys.every((k, i) => k === lastCall[i])) return;
  lastCall = keys;
  const v = callView;
  callRoot.dataset.state = call?.state ?? "none";
  if (!call) return;

  const live = call.state !== "Terminated";
  callRoot.dataset.phase = live ? "live" : "ended";
  setText(v.eyebrow, live ? (call.state === "In-Progress" ? "On the call with" : "Calling") : call.canceled ? "Call ended early" : "Last call");
  setText(v.name, business?.name ?? "Unknown business");
  setText(v.cap, `of ${formatClock(call.maxSeconds ?? 120)}`);
  setText($("#call-meta"), [call.dialCallId, call.scriptVersion].filter(Boolean).join(" · "));

  const reachedIndex = CALL_STATES.findIndex((s) => s.key === call.state);
  for (const [i, node] of v.stateNodes.entries()) {
    node.dataset.state = i < reachedIndex ? "done" : i === reachedIndex ? "current" : "todo";
  }

  const start = call.inProgressAt ?? call.placedAt;
  const nextIdle = call.state === "In-Progress" ? VOICE_TOOLS.find((t) => call.tools[t].state === "idle") : undefined;
  for (const [i, tool] of VOICE_TOOLS.entries()) {
    const slot = call.tools[tool];
    const { li, at, label } = v.toolNodes[i]!;
    li.dataset.state = slot.state;
    li.dataset.next = String(tool === nextIdle);
    setText(label, slot.state === "failed" ? `Failed${slot.error ? `: ${slot.error}` : ""}` : TOOL_LABELS[tool]);
    setText(at, slot.at ? `+${Math.max(0, (Date.parse(slot.at) - Date.parse(start)) / 1000).toFixed(1)}s` : String(i + 1).padStart(2, "0"));
  }

  const facts: HTMLElement[] = [];
  if (booking) {
    const code = el("span", "fact-code", booking.shortCode ?? "booking");
    facts.push(code);
    const price = formatMoney(booking.priceCents);
    if (price) facts.push(el("span", "fact-price", price));
    const slot = formatSlot(booking.slotStart);
    if (slot) facts.push(el("span", "fact-slot", slot));
    facts.push(el("span", `status-chip status-${booking.status}`, booking.status.replace(/_/g, " ")));
    if (booking.fromTranscript) facts.push(el("span", "badge badge-transcript", "from transcript"));
    if (booking.evidence?.quote) facts.push(el("span", "fact-quote", `“${booking.evidence.quote}”`));
  }
  v.facts.replaceChildren(...facts);
  v.facts.hidden = facts.length === 0;

  if (!call.transcript) {
    v.transcript.replaceChildren(el("li", "transcript-empty", live ? "The transcript lands when the call ends." : "No transcript for this call."));
  } else if (v.transcript.dataset.callId !== call.id || v.transcript.childElementCount !== call.transcript.length) {
    v.transcript.replaceChildren(
      ...call.transcript.map((turn) => {
        const li = el("li", "turn");
        li.dataset.speaker = turn.speaker;
        li.append(el("span", "turn-time", formatCallOffset(turn.startMs)), el("span", "turn-who", turn.speaker === "agent" ? "AI" : "Owner"), el("span", "turn-text", turn.text));
        return li;
      }),
    );
  }
  v.transcript.dataset.callId = call.id;
  setText(v.transcriptHead, call.transcript ? `Transcript · ${call.transcript.length} turns` : "Transcript");
  tickTimer();
  renderKill();
}

// ---- (d) Business cards ------------------------------------------------------------------------

const cardsRoot = $("#cards");
const cardNodes = new Map<string, { li: HTMLLIElement; frontName: HTMLElement; backName: HTMLElement; frontTrade: HTMLElement; backTrade: HTMLElement; rail: HTMLElement; cell: HTMLElement; quote: HTMLElement }>();

function face(kind: "front" | "back"): { face: HTMLElement; trade: HTMLElement; name: HTMLElement } {
  const node = el("div", `biz-face biz-${kind}`);
  const top = el("div", "biz-top");
  const trade = el("span", "biz-trade");
  top.append(trade, el("span", `channel-chip ${kind === "front" ? "channel-phone" : "channel-text"}`, kind === "front" ? "Phone-only" : "Text-enabled"));
  const name = el("p", "biz-name");
  node.append(top, name);
  return { face: node, trade, name };
}

function renderCards(): void {
  for (const id of state.businessOrder) {
    const b = state.businesses[id]!;
    let card = cardNodes.get(id);
    if (!card) {
      const li = el("li", "biz-card");
      const inner = el("div", "biz-inner");
      const front = face("front");
      front.face.append(el("p", "biz-note", "Calls only. No consent on file."));
      const back = face("back");
      const line = el("p", "biz-line");
      const rail = el("span", "biz-rail");
      const cell = el("span", "biz-cell");
      line.append(rail, cell);
      const quote = el("p", "biz-quote");
      back.face.append(line, quote);
      back.face.setAttribute("aria-hidden", "true");
      inner.append(front.face, back.face);
      li.append(inner);
      cardsRoot.append(li);
      card = { li, frontName: front.name, backName: back.name, frontTrade: front.trade, backTrade: back.trade, rail, cell, quote };
      cardNodes.set(id, card);
    }
    updateCard(card, b);
  }
  const enabled = state.businessOrder.filter((id) => state.businesses[id]!.channel === "text_enabled").length;
  setText($("#biz-meta"), state.businessOrder.length ? `${enabled} of ${state.businessOrder.length} text-enabled` : "");
}

function updateCard(card: NonNullable<ReturnType<typeof cardNodes.get>>, b: BusinessView): void {
  const enabled = b.channel === "text_enabled";
  const was = card.li.dataset.channel;
  card.li.dataset.channel = enabled ? "text_enabled" : "phone_only";
  if (was === "phone_only" && enabled && body.dataset.hydrating !== "true") {
    card.li.classList.remove("just-flipped");
    void card.li.offsetWidth; // restart the settle animation
    card.li.classList.add("just-flipped");
  }
  card.li.setAttribute("aria-label", `${b.name}: ${enabled ? "text-enabled" : "phone-only"}`);
  for (const n of [card.frontName, card.backName]) setText(n, b.name);
  for (const n of [card.frontTrade, card.backTrade]) setText(n, formatTrade(b.trade));
  setText(card.rail, formatRail(b.rail) ?? "Text");
  setText(card.cell, b.numberMasked ?? "cell pending");
  setText(card.quote, b.consentQuote ? `“${b.consentQuote}”` : "");
  card.li.querySelector(".biz-front")!.setAttribute("aria-hidden", String(enabled));
  card.li.querySelector(".biz-back")!.setAttribute("aria-hidden", String(!enabled));
}

// ---- (e) Supply table ------------------------------------------------------------------------------

let lastSupply: unknown[] = [];
function renderSupply(): void {
  const keys = [state.businesses, state.messages, state.calls];
  if (keys.every((k, i) => k === lastSupply[i])) return;
  lastSupply = keys;
  const rows = supplyRows(state).map((r) => {
    const tr = el("tr");
    tr.dataset.channel = r.channel;
    const name = el("th", "supply-name");
    name.scope = "row";
    name.append(el("span", "", r.name), el("span", "supply-trade", formatTrade(r.trade)));
    const channel = el("td");
    channel.append(el("span", `channel-chip ${r.channel === "text_enabled" ? "channel-text" : "channel-phone"}`, r.channel === "text_enabled" ? (formatRail(r.rail) ?? "Text") : "Phone"));
    const reply = el("td", "num", r.medianReplySeconds !== undefined ? `${r.medianReplySeconds < 10 ? r.medianReplySeconds.toFixed(r.medianReplySeconds % 1 ? 1 : 0) : Math.round(r.medianReplySeconds)} s` : "none");
    if (r.replyCount) reply.title = `${r.replyCount} repl${r.replyCount === 1 ? "y" : "ies"}`;
    const price = el("td", "num", formatMoney(r.lastPriceCents) ?? "none");
    const optIn = el("td", "num");
    if (r.optIn.length === 0) optIn.textContent = "none";
    for (const v of r.optIn) {
      const span = el("span", "optin", `${Math.round(v.rate * 100)}%`);
      span.append(el("small", "", ` ${v.version} · ${v.consents}/${v.calls}`));
      optIn.append(span);
    }
    tr.append(name, channel, reply, price, optIn);
    return tr;
  });
  $("#supply").replaceChildren(...rows);
}

// ---- (f) Owner phone ----------------------------------------------------------------------------------

const bubblesRoot = $("#bubbles");
const bubbleNodes = new Map<string, { li: HTMLLIElement; meta: HTMLElement }>();

function bubbleMeta(m: MessageView): string {
  const time = formatTime(m.at).replace(/:\d\d /, " ");
  if (m.direction === "out") return `${m.status === "sent" ? "Delivered" : m.status.charAt(0).toUpperCase() + m.status.slice(1)} · ${time}`;
  return [time, m.classification ? `read as ${m.classification.class} · ${formatConfidence(m.classification.confidence)}` : undefined].filter(Boolean).join(" · ");
}

let lastMessages: unknown;
function renderPhone(): void {
  if (state.messages === lastMessages) return;
  lastMessages = state.messages;
  if (state.messages.length === 0) {
    if (!bubblesRoot.childElementCount) bubblesRoot.append(el("li", "bubble-empty", "Once an owner says yes on a call, every job request arrives here as one text. They answer with one letter."));
    return;
  }
  bubblesRoot.querySelector(".bubble-empty")?.remove();
  let previousBusiness: string | undefined;
  for (const m of state.messages) {
    let node = bubbleNodes.get(m.id);
    if (!node) {
      if (m.businessId && previousBusiness && m.businessId !== previousBusiness) {
        bubblesRoot.append(el("li", "bubble-divider", state.businesses[m.businessId]?.name ?? ""));
      }
      const li = el("li", `bubble-row bubble-${m.direction}`);
      const bubble = el("p", "bubble", m.body);
      const meta = el("span", "bubble-meta");
      li.append(bubble, meta);
      bubblesRoot.append(li);
      node = { li, meta };
      bubbleNodes.set(m.id, node);
    }
    previousBusiness = m.businessId ?? previousBusiness;
    setText(node.meta, bubbleMeta(m));
  }
  const last = state.messages.at(-1);
  const business = last?.businessId ? state.businesses[last.businessId] : undefined;
  if (last) {
    setText($("#phone-name"), business?.name ?? "Owner");
    setText($("#phone-avatar"), initials(business?.name ?? "Owner"));
    setText($("#phone-sub"), [formatRail(business?.rail ?? last.channel), business?.numberMasked].filter(Boolean).join(" · "));
    setText($("#phone-meta"), `${state.messages.length} message${state.messages.length === 1 ? "" : "s"}`);
  }
  bubblesRoot.scrollTo({ top: bubblesRoot.scrollHeight, behavior: body.dataset.hydrating === "true" ? "auto" : "smooth" });
}

// ---- (g) Bookings -------------------------------------------------------------------------------------

const bookingsRoot = $("#bookings");
const bookingNodes = new Map<string, HTMLLIElement>();

function evidenceLine(b: BookingView): string {
  if (b.status !== "confirmed" && !b.evidence) return b.status === "pending" ? "Waiting for the owner" : "";
  const kind = b.evidence?.kind;
  if (kind === "call") return `Confirmed by call${b.evidence?.quote ? ` · “${b.evidence.quote}”` : ""}`;
  if (kind === "text") {
    const reply = evidenceMessage(state, b)?.body;
    return `Confirmed by text${reply ? ` · “${reply}”` : ""}`;
  }
  if (kind === "rule") return "Confirmed by the owner's rule";
  return b.status === "confirmed" ? "Confirmed" : "";
}

let lastBookings: unknown[] = [];
function renderBookings(): void {
  const keys = [state.bookings, state.messages];
  if (keys.every((k, i) => k === lastBookings[i])) return;
  lastBookings = keys;
  for (const id of state.bookingOrder) {
    const b = state.bookings[id]!;
    let li = bookingNodes.get(id);
    if (!li) {
      li = el("li", "booking");
      bookingNodes.set(id, li);
      bookingsRoot.prepend(li);
    }
    li.dataset.status = b.status;
    const top = el("div", "booking-top");
    top.append(el("span", "booking-code", b.shortCode ?? id.slice(-6)), el("span", `status-chip status-${b.status}`, b.status.replace(/_/g, " ")));
    const what = el("p", "booking-what", [b.service, state.businesses[b.businessId ?? ""]?.name].filter(Boolean).join(" · "));
    const meta = el("p", "booking-meta");
    for (const part of [b.route ? `by ${b.route}` : undefined, formatMoney(b.priceCents), formatSlot(b.slotStart)]) if (part) meta.append(el("span", "", part));
    if (b.fromTranscript) meta.append(el("span", "badge badge-transcript", "from transcript"));
    const evidence = el("p", "booking-evidence", evidenceLine(b));
    li.replaceChildren(top, what, meta, evidence);
  }
  const confirmed = state.bookingOrder.filter((id) => state.bookings[id]!.status === "confirmed").length;
  setText($("#book-meta"), state.bookingOrder.length ? `${confirmed} confirmed` : "");
  if (!state.bookingOrder.length && !bookingsRoot.querySelector(".booking-empty")) bookingsRoot.replaceChildren(el("li", "booking-empty", "No bookings yet. Each one appears here with its evidence once the owner says yes."));
  else if (state.bookingOrder.length) bookingsRoot.querySelector(".booking-empty")?.remove();
}

// ---- (a) Event stream ----------------------------------------------------------------------------------

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
    li.dataset.kind = event.type.split(".")[0];
    li.append(el("time", "ev-time", formatTime(event.created_at)), el("span", "actor", event.actor));
    const main = el("span", "ev-main");
    main.append(el("span", "ev-type", event.type));
    const detail = summarize(event);
    if (detail) main.append(el("span", "ev-detail", detail));
    li.append(main);
    const conf = el("span", "confidence");
    conf.title = `Confidence ${formatConfidence(event.confidence)}`;
    const bar = el("i");
    bar.style.setProperty("--c", String(event.confidence));
    conf.append(bar, document.createTextNode(formatConfidence(event.confidence)));
    li.append(conf);
    li.title = event.reason ?? "";
    streamRoot.prepend(li);
    streamNodes.set(event.id, li);
  }
  setText($("#stream-meta"), `${state.eventCount} event${state.eventCount === 1 ? "" : "s"}`);
}

// ---- Kill switch -------------------------------------------------------------------------------------------

let killArmed: ReturnType<typeof setTimeout> | undefined;
function renderKill(): void {
  if (RECORDING) return;
  const inProgress = currentCall(state)?.state === "In-Progress";
  killButton.hidden = false;
  killButton.disabled = !inProgress;
  if (!inProgress && killArmed) disarmKill();
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
    setText(killButton, "Click to end the call");
    killArmed = setTimeout(disarmKill, 3_000);
    return;
  }
  disarmKill();
  killButton.disabled = true;
  const result = await requestKillCall(source.base);
  if (result.ok) say("Kill switch sent. The call ends in a moment.");
  else if (result.status === 404) say("This server has no kill switch (404).");
  else say(result.status ? `Kill switch failed (HTTP ${result.status}).` : "Kill switch failed: the server did not answer.");
  renderKill();
});

// ---- Render loop --------------------------------------------------------------------------------------------

let frame = 0;
function render(): void {
  frame = 0;
  replayed.hidden = !state.replayed || RECORDING;
  renderBeats();
  renderDarwin();
  renderCall();
  renderCards();
  renderBookings();
  renderPhone();
  renderSupply();
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
  hydrate(() => {
    state = next;
    for (const map of [cardNodes, bubbleNodes, bookingNodes, streamNodes]) map.clear();
    cardsRoot.replaceChildren();
    bubblesRoot.replaceChildren();
    bookingsRoot.replaceChildren();
    streamRoot.replaceChildren();
    callView.transcript.replaceChildren();
    delete callView.transcript.dataset.callId;
    lastDarwin = lastCall = lastSupply = lastBookings = [];
    lastMessages = undefined;
    for (const id of ["#phone-name", "#phone-sub", "#phone-meta", "#call-meta"]) setText($(id), "");
    setText($("#phone-name"), "No texts yet");
    setText($("#phone-sub"), "Texts start after the owner says yes");
    setText($("#phone-avatar"), "P");
    for (const t of callView.toolNodes) t.li.dataset.state = "idle";
    callRoot.dataset.state = "none";
    delete callRoot.dataset.phase;
    setText(callView.name, "Waiting for a call");
    setText(callView.eyebrow, "No call yet");
    setText(callView.timer, "0:00");
    render();
  });
}

/** Runs a burst of updates with transitions off, e.g. the backlog after a refresh. */
function hydrate(fn: () => void): void {
  body.dataset.hydrating = "true";
  fn();
  requestAnimationFrame(() => requestAnimationFrame(() => (body.dataset.hydrating = "false")));
}

setInterval(() => {
  if (currentCall(state)?.state === "In-Progress") tickTimer();
}, 250);

// ---- Data source ----------------------------------------------------------------------------------------------

let playing: AbortController | undefined;
async function playLocal(): Promise<void> {
  playing?.abort();
  const controller = new AbortController();
  playing = controller;
  resetTo(initialState());
  // Slower than the landing page: the timeline should be watchable on a projector.
  await playRecording(GOLDEN_PATH, dispatch, 1, 3_500, controller.signal);
}

replayButton.addEventListener("click", async () => {
  replayButton.disabled = true;
  try {
    if (RECORDING) void playLocal();
    else {
      const cutoff = history.length;
      if (await requestReplay(source.base)) resetTo(reduceAll(history.slice(cutoff)));
      else say("Replay is only available on a fakes server (DEMO_MODE=fakes).");
    }
  } finally {
    setTimeout(() => (replayButton.disabled = false), 1_500);
  }
});

render();
if (RECORDING) {
  setConnection("recording");
  conn.title = "No server behind this page: it replays the golden path recorded against the test fakes.";
  replayButton.textContent = "Replay";
  body.dataset.hydrating = "false";
  setTimeout(() => void playLocal(), 500);
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
  });
}
