import { monotonicFactory } from "ulid";

const next = monotonicFactory();

/**
 * Call row ids in the same shape as @platypus/shared's newId("call"): "call_" plus a
 * monotonic ULID, so they sort in creation order. Re-declared because the shared
 * package does not export its id helper on a public subpath.
 */
export function newCallId(at: number = Date.now()): string {
  return `call_${next(at)}`;
}

/** Structurally identical to @platypus/shared's Clock (not exported on a public subpath). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
