import type { Signals } from "@platypus/shared/contracts";
import type { Db } from "@platypus/shared/db";
import { listEvents } from "@platypus/shared/events";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Routing signals for one business, computed from the local event log only.
 * Never fabricated: a field with no supporting events is left out.
 *  - typical price: median of every price an event recorded for the business
 *    (agreed on a call, quoted in a counter, confirmed), one per booking.
 *    Agent-authored events are ignored so a caller cannot move the number.
 *  - median reply: message.sent to the next message.received on the same booking.
 *  - acceptance: confirmed / (confirmed + declined), one outcome per booking.
 */
export function computeSignals(db: Db, businessId: string): Signals {
  // ponytail: full scan of the business's events per call; precompute if a business ever has >10k events.
  const events = listEvents(db, { businessId, limit: 10_000 });
  const prices = new Map<string, number>();
  const sentAt = new Map<string, number>();
  const replySeconds: number[] = [];
  const outcomes = new Map<string, boolean>();

  for (const event of events) {
    const key = event.refs.booking_id ?? event.id;
    const price = event.payload.price_cents;
    if (event.actor !== "agent" && typeof price === "number" && Number.isInteger(price) && price >= 0) prices.set(key, price);

    const thread = event.refs.booking_id ?? "";
    if (event.type === "message.sent" && !sentAt.has(thread)) sentAt.set(thread, Date.parse(event.created_at));
    if (event.type === "message.received" && sentAt.has(thread)) {
      replySeconds.push(Math.max(0, (Date.parse(event.created_at) - sentAt.get(thread)!) / 1000));
      sentAt.delete(thread);
    }

    if (event.type === "booking.confirmed" || event.type === "booking.declined") outcomes.set(key, event.type === "booking.confirmed");
  }

  const accepted = [...outcomes.values()].filter(Boolean).length;
  return {
    source: "local",
    ...(prices.size ? { typical_price_cents: Math.round(median([...prices.values()])) } : {}),
    ...(replySeconds.length ? { median_reply_seconds: median(replySeconds) } : {}),
    ...(outcomes.size ? { acceptance_rate: accepted / outcomes.size } : {}),
  };
}
