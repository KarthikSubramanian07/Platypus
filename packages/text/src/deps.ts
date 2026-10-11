import { createHash } from "node:crypto";
import { monotonicFactory } from "ulid";
import type { BookingContext } from "@platypus/shared/booking";
import type { TextChannel } from "@platypus/shared/config";
import { decode, type Db, type EventRow } from "@platypus/shared/db";
import { emit, type EmitInput, type EventBus } from "@platypus/shared/events";
import type { DialMessaging } from "./dial-messaging";
import type { ReplyModel } from "./model";

/**
 * Structurally the same as the shared Clock (packages/shared/src/clock.ts), which
 * is not exported through a package subpath.
 */
export interface Clock {
  now(): Date;
}

/** Everything the text package needs, injected so tests run against fakes and an in-memory database. */
export interface TextDeps {
  db: Db;
  bus?: Pick<EventBus, "publish">;
  clock?: Clock;
  /** Overrides MAX_REQUESTS_PER_BUSINESS_PER_HOUR (outbound.ts). */
  maxRequestsPerHour?: number;
  messaging: DialMessaging;
  /** TEXT_CHANNEL: the owner rail. Never "sms" (that is the "dial" rail, Dial-to-Dial only). */
  textChannel: TextChannel;
  /** ALLOWED_NUMBERS: checked again immediately before every send. */
  allowedNumbers: readonly string[];
  /** DIAL_OWNER_NUMBERS: owner numbers that are themselves Dial numbers, the only ones that may get "sms". */
  dialNumbers?: readonly string[];
  /**
   * DIAL_OWNER_LINE: the demo shop's texting line, when it is not the number we call. On the
   * Dial-to-Dial rail it is a second Dial number (spec A.4: "today Sal's line is a Dial number");
   * on iMessage it is a teammate's iPhone, while the shop's calls still reach the Dial number
   * playing Eddy. Used only for the demo shop, after its own numbers; replies from it are read as the demo shop's.
   */
  ownerLine?: string;
  /** Our Dial number in E.164 (DIAL_NUMBER), recorded as the sender on outbound rows. */
  ourNumber?: string;
  /** Claude, or null when ANTHROPIC_API_KEY is unset. */
  model?: ReplyModel | null;
  /** How long a lookup verdict stays good (default 24 hours: Dial says it is point-in-time). */
  lookupMaxAgeMs?: number;
}

const nextUlid = monotonicFactory();

/**
 * Prefixed monotonic ULIDs in the shared format ("msg_01...", "cns_01..."). The
 * shared newId is not exported through a package subpath, so this mirrors it.
 */
export function newId(kind: "message" | "consent", at: number): string {
  return `${kind === "message" ? "msg" : "cns"}_${nextUlid(at)}`;
}

export const now = (deps: TextDeps): Date => (deps.clock ? deps.clock.now() : new Date());

export function record(deps: TextDeps, input: EmitInput) {
  return emit(deps.db, input, { ...(deps.bus ? { bus: deps.bus } : {}), ...(deps.clock ? { clock: deps.clock } : {}) });
}

export function bookingCtx(deps: TextDeps): BookingContext {
  return { db: deps.db, ...(deps.bus ? { bus: deps.bus } : {}), ...(deps.clock ? { clock: deps.clock } : {}) };
}

/**
 * A stable pseudonym for a phone number in the event log, which must never hold a real
 * number. It hides the number from a reader, not from a determined one: phone numbers are
 * few enough to hash them all, so the live log stays operator-only (DASHBOARD_TOKEN).
 */
export function numberRef(e164: string): string {
  return createHash("sha256").update(`platypus:${e164}`).digest("hex").slice(0, 16);
}

/** The newest events of one type for a business (or booking), newest first. */
export function latestEvents(deps: TextDeps, type: string, by: { business_id?: string; booking_id?: string }, limit = 50): EventRow[] {
  const col = by.booking_id ? "booking_id" : "business_id";
  const id = by.booking_id ?? by.business_id;
  return (deps.db.prepare(`SELECT * FROM events WHERE type = ? AND ${col} = ? ORDER BY id DESC LIMIT ?`).all(type, id, limit) as Record<string, unknown>[]).map(
    (r) => decode("events", r)!,
  );
}
