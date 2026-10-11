import type { StreamEvent } from "./format";

/**
 * The event client shared by the landing page and /live.
 *
 * In dev the stream is same-origin (Vite proxies /events and /demo to the server).
 * A static deploy has no server, so it plays the bundled golden-path recording,
 * unless VITE_EVENTS_URL or ?events=<url> points it at a live one.
 */
export interface StreamSource {
  mode: "live" | "recording";
  /** Origin of the event server, without a trailing slash; "" means same-origin. */
  base: string;
}

export function resolveSource(search: string, env: { PROD: boolean; VITE_EVENTS_URL?: string | undefined }): StreamSource {
  const fromQuery = new URLSearchParams(search).get("events");
  const configured = fromQuery ?? env.VITE_EVENTS_URL;
  return { mode: env.PROD && !configured ? "recording" : "live", base: (configured ?? "").replace(/\/$/, "") };
}

export type ConnectionState = "connecting" | "live" | "reconnecting" | "recording";

export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  recording: "Recorded run",
};

/** Parses one SSE data frame. Anything that is not a Platypus event is dropped, never thrown. */
export function parseStreamEvent(data: string): StreamEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const e = value as Record<string, unknown>;
  if (typeof e.id !== "string" || typeof e.type !== "string" || typeof e.created_at !== "string") return undefined;
  const record = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  return {
    id: e.id,
    type: e.type,
    actor: typeof e.actor === "string" ? e.actor : "system",
    refs: record(e.refs) as Record<string, string>,
    payload: record(e.payload),
    reason: typeof e.reason === "string" ? e.reason : null,
    confidence: typeof e.confidence === "number" ? e.confidence : 1,
    created_at: e.created_at,
  };
}

export interface LiveHandlers {
  onEvent: (event: StreamEvent) => void;
  onState: (state: ConnectionState) => void;
  /** The server finished replaying the backlog; everything after this is live. */
  onReady?: () => void;
}

/**
 * Opens /events/stream. EventSource reconnects by itself and sends Last-Event-ID,
 * so the server replays only what was missed. If the browser gives up (an HTTP
 * error from a proxy closes the source for good), this reopens it with ?after=
 * and a capped backoff. Duplicates are still possible across reconnects, so the
 * consumer dedupes by id.
 */
export function connectLive(base: string, handlers: LiveHandlers): () => void {
  let source: EventSource | undefined;
  let lastId: string | undefined;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const open = () => {
    const url = `${base}/events/stream${lastId ? `?after=${encodeURIComponent(lastId)}` : ""}`;
    handlers.onState(lastId ? "reconnecting" : "connecting");
    source = new EventSource(url);
    source.addEventListener("open", () => {
      retry = 0;
      handlers.onState("live");
    });
    source.addEventListener("error", () => {
      if (closed) return;
      handlers.onState("reconnecting");
      if (source?.readyState === EventSource.CLOSED) {
        source.close();
        timer = setTimeout(open, Math.min(10_000, 500 * 2 ** retry++));
      }
    });
    source.addEventListener("ready", () => handlers.onReady?.());
    source.addEventListener("platypus", (message) => {
      const frame = message as MessageEvent<string>;
      const event = parseStreamEvent(frame.data);
      if (!event) return;
      lastId = frame.lastEventId || event.id;
      handlers.onEvent(event);
    });
  };

  open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    source?.close();
  };
}

/** Asks the dev server to replay the golden path. Resolves true when a replay started. */
export async function requestReplay(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/demo/replay`, { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}

/** The demo kill switch: ends the live call. Never retried automatically. */
export async function requestKillCall(base: string): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await fetch(`${base}/demo/kill-call`, { method: "POST" });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
