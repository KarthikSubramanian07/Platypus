import { systemClock, type Clock } from "../clock";
import { newId } from "../ids";
import { decode, insertRow, type Db } from "../db/repo";
import type { EventRow } from "../db/types";
import { defaultBus, type EventBus } from "./bus";
import { ENTITY_REFS, EVENT_ACTORS, type EmitInput, type PlatypusEvent } from "./types";

export interface EmitOptions {
  bus?: Pick<EventBus, "publish">;
  clock?: Clock;
}

export function rowToEvent(row: EventRow): PlatypusEvent {
  const refs: PlatypusEvent["refs"] = {};
  for (const k of ENTITY_REFS) if (row[k]) refs[k] = row[k]!;
  return {
    id: row.id,
    type: row.type,
    actor: row.actor as PlatypusEvent["actor"],
    refs,
    payload: row.payload,
    reason: row.reason,
    confidence: row.confidence,
    created_at: row.created_at,
  };
}

function eventToRow(event: PlatypusEvent): EventRow {
  return {
    id: event.id,
    type: event.type,
    actor: event.actor,
    business_id: event.refs.business_id ?? null,
    booking_id: event.refs.booking_id ?? null,
    call_id: event.refs.call_id ?? null,
    message_id: event.refs.message_id ?? null,
    consent_id: event.refs.consent_id ?? null,
    hold_id: event.refs.hold_id ?? null,
    payload: event.payload,
    reason: event.reason,
    confidence: event.confidence,
    created_at: event.created_at,
  };
}

/**
 * Writes one event to the append-only log, then broadcasts it. If called inside
 * a transaction, the broadcast still happens immediately; callers that need
 * strict ordering emit after commit (the booking module does).
 */
export function emit<P extends Record<string, unknown>>(db: Db, input: EmitInput<P>, options: EmitOptions = {}): PlatypusEvent<P> {
  if (!EVENT_ACTORS.includes(input.actor)) throw new Error(`Unknown actor: ${input.actor}`);
  const confidence = input.confidence ?? 1;
  if (!(confidence >= 0 && confidence <= 1)) throw new Error(`Confidence must be within 0..1, got ${confidence}`);
  const clock = options.clock ?? systemClock;
  const now = clock.now();
  const event: PlatypusEvent<P> = {
    id: newId("event", now.getTime()),
    type: input.type,
    actor: input.actor,
    refs: input.refs ?? {},
    payload: (input.payload ?? {}) as P,
    reason: input.reason ?? null,
    confidence,
    created_at: now.toISOString(),
  };
  insertRow(db, "events", eventToRow(event));
  (options.bus ?? defaultBus).publish(event);
  return event;
}

/** Re-appends an event exactly as recorded (fixture replay). Keeps type, actor and payload; issues a fresh id and time. */
export function reemit(db: Db, event: PlatypusEvent, options: EmitOptions = {}): PlatypusEvent {
  return emit(
    db,
    {
      type: event.type,
      actor: event.actor,
      refs: event.refs,
      payload: event.payload,
      ...(event.reason ? { reason: event.reason } : {}),
      confidence: event.confidence,
    },
    options,
  );
}

export interface ListEventsQuery {
  afterId?: string;
  bookingId?: string;
  businessId?: string;
  type?: string;
  limit?: number;
}

export function listEvents(db: Db, query: ListEventsQuery = {}): PlatypusEvent[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.afterId) {
    where.push("id > ?");
    params.push(query.afterId);
  }
  if (query.bookingId) {
    where.push("booking_id = ?");
    params.push(query.bookingId);
  }
  if (query.businessId) {
    where.push("business_id = ?");
    params.push(query.businessId);
  }
  if (query.type) {
    where.push("type = ?");
    params.push(query.type);
  }
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id LIMIT ?`;
  params.push(Math.min(query.limit ?? 1000, 10_000));
  return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => rowToEvent(decode("events", r)!));
}

/** One JSON object per line, oldest first. Used to cut fixtures from a real run. */
export function exportJsonl(events: PlatypusEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
}

export function parseJsonl(text: string): PlatypusEvent[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PlatypusEvent);
}
