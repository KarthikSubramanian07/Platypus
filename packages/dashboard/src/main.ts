import "@fontsource/source-serif-4/400.css";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { GOLDEN_PATH, playRecording } from "./fixture";
import { formatConfidence, formatTime, GOLDEN_STEPS, stepFor, summarize, type StepKey, type StreamEvent } from "./format";

/**
 * Where the event stream lives. In dev it is same-origin (Vite proxies to the server).
 * A static deploy has no server, so it plays the recorded golden path instead,
 * unless VITE_EVENTS_URL or ?events=<url> points it at a live one.
 */
const fromQuery = new URLSearchParams(location.search).get("events");
const configured = fromQuery ?? (import.meta.env.VITE_EVENTS_URL as string | undefined);
const RECORDING = import.meta.env.PROD && !configured;
const BASE = (configured ?? "").replace(/\/$/, "");

const list = document.querySelector<HTMLOListElement>("#events")!;
const empty = document.querySelector<HTMLParagraphElement>("#empty")!;
const conn = document.querySelector<HTMLSpanElement>("#conn")!;
const count = document.querySelector<HTMLSpanElement>("#count")!;
const replay = document.querySelector<HTMLButtonElement>("#replay")!;
const stepsEl = document.querySelector<HTMLOListElement>("#steps")!;
const caption = document.querySelector<HTMLParagraphElement>("#caption")!;
const seen = new Set<string>();
const reached = new Set<StepKey>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent only: event text is untrusted
  return node;
}

const stepNodes = new Map<StepKey, HTMLLIElement>();
for (const [i, step] of GOLDEN_STEPS.entries()) {
  const li = el("li", "step");
  li.append(el("span", "step-num", String(i + 1).padStart(2, "0")), el("span", "step-label", step.label));
  stepsEl.append(li);
  stepNodes.set(step.key, li);
}

function markStep(key: StepKey): void {
  reached.add(key);
  for (const step of GOLDEN_STEPS) {
    const node = stepNodes.get(step.key)!;
    node.dataset.state = reached.has(step.key) ? (step.key === key ? "current" : "done") : "todo";
  }
  caption.textContent = GOLDEN_STEPS.find((s) => s.key === key)!.caption;
}

function resetView(): void {
  list.replaceChildren();
  seen.clear();
  reached.clear();
  for (const node of stepNodes.values()) node.dataset.state = "todo";
  caption.textContent = "";
  empty.hidden = false;
  count.textContent = "0 events";
}

function render(event: StreamEvent): void {
  if (seen.has(event.id)) return;
  seen.add(event.id);
  const item = el("li", "event");
  item.dataset.actor = event.actor;
  item.dataset.kind = event.type.split(".")[0];
  item.append(el("time", "event-time", formatTime(event.created_at)));
  item.append(el("span", "actor", event.actor));
  const body = el("div", "event-body");
  const head = el("div", "event-head");
  head.append(el("span", "event-type", event.type));
  const detail = summarize(event);
  if (detail) head.append(el("span", "event-detail", detail));
  body.append(head);
  if (event.reason) body.append(el("span", "event-reason", event.reason));
  item.append(body);
  const conf = el("span", "confidence");
  conf.title = "Confidence";
  const bar = el("i", "");
  bar.style.setProperty("--c", String(event.confidence));
  conf.append(bar, document.createTextNode(formatConfidence(event.confidence)));
  item.append(conf);
  list.append(item);
  empty.hidden = true;
  count.textContent = `${seen.size} event${seen.size === 1 ? "" : "s"}`;
  list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  const step = stepFor(event);
  if (step) markStep(step);
}

function connect(): void {
  // EventSource reconnects on its own and sends Last-Event-ID, so the server replays only what was missed.
  const source = new EventSource(`${BASE}/events/stream`);
  source.addEventListener("open", () => {
    conn.dataset.state = "live";
    conn.textContent = "Live";
  });
  source.addEventListener("error", () => {
    conn.dataset.state = "reconnecting";
    conn.textContent = "Reconnecting";
  });
  source.addEventListener("platypus", (message) => render(JSON.parse((message as MessageEvent<string>).data) as StreamEvent));
}

let playing: AbortController | undefined;
async function playLocal(): Promise<void> {
  playing?.abort();
  playing = new AbortController();
  resetView();
  await playRecording(GOLDEN_PATH, render, 2, 2_200, playing.signal);
}

replay.addEventListener("click", async () => {
  replay.disabled = true;
  document.querySelector("#log")?.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    if (RECORDING) void playLocal();
    else {
      resetView();
      await fetch(`${BASE}/demo/replay`, { method: "POST" });
    }
  } finally {
    setTimeout(() => (replay.disabled = false), 1500);
  }
});

if (RECORDING) {
  conn.dataset.state = "recording";
  conn.textContent = "Recorded run";
  conn.title = "No server behind this page: it replays the golden path recorded against the test fakes.";
  // Start when the log scrolls into view, so a visitor sees it from the first event.
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      observer.disconnect();
      void playLocal();
    }
  }, { threshold: 0.25 });
  observer.observe(document.querySelector("#log")!);
} else {
  connect();
}
