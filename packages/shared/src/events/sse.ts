import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { Db } from "../db/repo";
import { defaultBus, type EventBus } from "./bus";
import { listEvents } from "./log";
import type { PlatypusEvent } from "./types";

export interface EventsAppOptions {
  db: Db;
  bus?: EventBus;
  /** Heartbeat interval; keeps proxies and tunnels from closing an idle stream. */
  heartbeatMs?: number;
}

/**
 * GET /events/stream  Server-Sent Events. Replays everything after the
 *                     Last-Event-ID header (or ?after=<id>), then streams live.
 *                     Ids are monotonic, so a reconnecting client never sees
 *                     a duplicate and never misses an event.
 * GET /events         JSON page of the log (?after, ?booking_id, ?limit).
 * GET /events.jsonl   The whole log as JSONL (fixture export).
 */
export function createEventsApp({ db, bus = defaultBus, heartbeatMs = 15_000 }: EventsAppOptions): Hono {
  const app = new Hono();
  app.use("/events/*", cors());
  app.use("/events", cors());

  app.get("/events", (c) => {
    const after = c.req.query("after");
    const bookingId = c.req.query("booking_id");
    const limit = Number(c.req.query("limit") ?? 500);
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
    return c.body(listEvents(db, { limit: 10_000 }).map((e) => JSON.stringify(e)).join("\n") + "\n");
  });

  app.get("/events/stream", (c) => {
    const lastId = c.req.header("last-event-id") ?? c.req.query("after") ?? undefined;
    return streamSSE(c, async (stream) => {
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

      for (const event of listEvents(db, { ...(lastId ? { afterId: lastId } : {}), limit: 10_000 })) await write(event);
      replaying = false;
      for (const event of pending.sort((a, b) => (a.id < b.id ? -1 : 1))) await write(event);
      pending.length = 0;

      await stream.writeSSE({ event: "ready", data: JSON.stringify({ cursor }) });
      while (!stream.aborted) {
        await stream.sleep(heartbeatMs);
        if (!stream.aborted) await stream.writeSSE({ event: "heartbeat", data: "{}" });
      }
      unsubscribe();
    });
  });

  return app;
}
