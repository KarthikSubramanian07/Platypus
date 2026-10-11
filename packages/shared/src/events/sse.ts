import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { Db } from "../db/repo";
import { defaultBus, type EventBus } from "./bus";
import { allEvents, listEvents } from "./log";
import type { PlatypusEvent } from "./types";

export interface EventsAppOptions {
  db: Db;
  bus?: EventBus;
  /** Heartbeat interval; keeps proxies and tunnels from closing an idle stream. */
  heartbeatMs?: number;
  /** Open /events/stream connections allowed at once; the next one gets 503. Each holds a bus subscriber. */
  maxStreams?: number;
}

/** A dashboard or two, a projector and a few judges' laptops; far beyond that is a flood. */
export const MAX_EVENT_STREAMS = 32;

/**
 * GET /events/stream  Server-Sent Events. Replays everything after the
 *                     Last-Event-ID header (or ?after=<id>), then streams live.
 *                     Ids are monotonic, so a reconnecting client never sees
 *                     a duplicate and never misses an event.
 * GET /events         JSON page of the log (?after, ?booking_id, ?limit).
 * GET /events.jsonl   The whole log as JSONL (fixture export).
 */
export function createEventsApp({ db, bus = defaultBus, heartbeatMs = 15_000, maxStreams = MAX_EVENT_STREAMS }: EventsAppOptions): Hono {
  const app = new Hono();
  let openStreams = 0;
  app.use("/events/*", cors());
  app.use("/events", cors());

  app.get("/events", (c) => {
    const after = c.req.query("after");
    const bookingId = c.req.query("booking_id");
    const limit = Number(c.req.query("limit") ?? 500); // listEvents clamps it to 1..MAX_EVENTS_PAGE
    return c.json({
      events: listEvents(db, {
        ...(after ? { afterId: after } : {}),
        ...(bookingId ? { bookingId } : {}),
        limit,
      }),
    });
  });

  app.get("/events.jsonl", (c) => {
    c.header("content-type", "application/x-ndjson");
    let body = "";
    for (const e of allEvents(db)) body += JSON.stringify(e) + "\n";
    return c.body(body || "\n");
  });

  app.get("/events/stream", (c) => {
    const lastId = c.req.header("last-event-id") ?? c.req.query("after") ?? undefined;
    if (openStreams >= maxStreams) return c.json({ error: "too many open event streams" }, 503, { "retry-after": "10" });
    openStreams += 1;
    let released = false;
    const release = () => {
      if (!released) openStreams -= 1;
      released = true;
    };
    return streamSSE(c, async (stream) => {
      stream.onAbort(release);
      // Buffer live events while the backlog replays, then drain in id order.
      const pending: PlatypusEvent[] = [];
      let replaying = true;
      let cursor = lastId ?? "";
      const write = async (event: PlatypusEvent) => {
        if (event.id <= cursor) return;
        cursor = event.id;
        await stream.writeSSE({ id: event.id, event: "platypus", data: JSON.stringify(event) });
      };
      const unsubscribe = bus.subscribe((event) => {
        if (replaying) pending.push(event);
        else void write(event);
      });
      stream.onAbort(() => unsubscribe());

      for (const event of allEvents(db, lastId ? { afterId: lastId } : {})) await write(event);
      replaying = false;
      for (const event of pending.sort((a, b) => (a.id < b.id ? -1 : 1))) await write(event);
      pending.length = 0;

      await stream.writeSSE({ event: "ready", data: JSON.stringify({ cursor }) });
      while (!stream.aborted) {
        await stream.sleep(heartbeatMs);
        if (!stream.aborted) await stream.writeSSE({ event: "heartbeat", data: "{}" });
      }
      unsubscribe();
      release();
    });
  });

  return app;
}
