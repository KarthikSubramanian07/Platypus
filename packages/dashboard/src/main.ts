import "@fontsource/source-serif-4/600.css";
import "@fontsource-variable/dm-sans";
import "./styles.css";
import { formatConfidence, formatTime, summarize, type StreamEvent } from "./format";

/** Where the event stream lives. Same origin in dev (Vite proxies to the gateway); set VITE_EVENTS_URL when deployed. */
const BASE = (import.meta.env.VITE_EVENTS_URL as string | undefined) ?? "";

const list = document.querySelector<HTMLOListElement>("#events")!;
const empty = document.querySelector<HTMLParagraphElement>("#empty")!;
const conn = document.querySelector<HTMLSpanElement>("#conn")!;
const count = document.querySelector<HTMLSpanElement>("#count")!;
const replay = document.querySelector<HTMLButtonElement>("#replay")!;
const seen = new Set<string>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text; // textContent only: event text is untrusted
  return node;
}

function render(event: StreamEvent): void {
  if (seen.has(event.id)) return;
  seen.add(event.id);
  const item = el("li", "event");
  item.dataset.actor = event.actor;
  item.append(el("time", "event-time", formatTime(event.created_at)));
  item.append(el("span", "actor", event.actor));
  const body = el("div", "event-body");
  body.append(el("span", "event-type", event.type));
  const detail = summarize(event);
  if (detail) body.append(el("span", "event-detail", detail));
  if (event.payload.replayed) body.append(el("span", "badge", "replay"));
  if (event.reason) body.append(el("span", "event-reason", event.reason));
  item.append(body);
  item.append(el("span", "confidence", formatConfidence(event.confidence)));
  list.append(item);
  empty.hidden = true;
  count.textContent = `${seen.size} event${seen.size === 1 ? "" : "s"}`;
  item.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function connect(): void {
  // EventSource reconnects on its own and sends Last-Event-ID, so the server replays only what we missed.
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

replay.addEventListener("click", async () => {
  replay.disabled = true;
  try {
    await fetch(`${BASE}/demo/replay`, { method: "POST" });
  } finally {
    setTimeout(() => (replay.disabled = false), 1500);
  }
});

connect();
