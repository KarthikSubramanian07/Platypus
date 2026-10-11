import { DIAL_API_BASE } from "./dial-messaging";
import { DialEnvelope } from "./webhook";

/**
 * The second way inbound texts arrive: a long-poll loop over Dial's
 * POST /events/wait. It only sees the next event, so it is the backup to the
 * webhook, not a replacement. Both feed the same ingest function, and the same
 * dedupe (event id, then the UNIQUE provider message id) makes a message that
 * arrives both ways act once.
 */

export interface EventsConsumerOptions {
  apiKey: string;
  ingest: (envelope: DialEnvelope, source: "events") => void;
  eventType?: string;
  /** Seconds Dial holds each request open, 1 to 60. */
  timeoutSeconds?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Backoff after an error: starts here, doubles, caps at maxBackoffMs. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  onError?: (error: Error) => void;
}

export interface EventsConsumer {
  start(): void;
  /** Stops the loop and resolves once the in-flight request is abandoned. */
  stop(): Promise<void>;
  readonly running: boolean;
}

export function createEventsConsumer(options: EventsConsumerOptions): EventsConsumer {
  const base = (options.baseUrl ?? DIAL_API_BASE).replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const initial = options.initialBackoffMs ?? 1_000;
  const max = options.maxBackoffMs ?? 30_000;
  let running = false;
  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;

  const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });

  async function run(signal: AbortSignal): Promise<void> {
    let backoff = initial;
    while (running && !signal.aborted) {
      // Yield to the event loop each round, so a server answering instantly can never starve the process.
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        const res = await doFetch(`${base}/events/wait`, {
          method: "POST",
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ eventType: options.eventType ?? "message.received", timeout: Math.min(60, Math.max(1, options.timeoutSeconds ?? 30)) }),
          signal,
        });
        if (res.status === 408) {
          backoff = initial;
          continue;
        }
        if (res.status === 429) {
          const wait = Number(res.headers.get("retry-after"));
          await pause(Number.isFinite(wait) && wait > 0 ? wait * 1000 : backoff, signal);
          continue;
        }
        if (!res.ok) throw new Error(`POST /events/wait returned ${res.status}`);
        const json = (await res.json()) as { event?: unknown };
        const envelope = DialEnvelope.safeParse(json.event);
        if (envelope.success) options.ingest(envelope.data, "events");
        backoff = initial;
      } catch (error) {
        if (signal.aborted || !running) break;
        options.onError?.(error as Error);
        await pause(backoff, signal);
        backoff = Math.min(max, backoff * 2);
      }
    }
  }

  return {
    get running() {
      return running;
    },
    start() {
      if (running) return;
      running = true;
      controller = new AbortController();
      loop = run(controller.signal);
    },
    async stop() {
      running = false;
      controller?.abort();
      await loop;
      loop = null;
    },
  };
}
