import { monotonicFactory } from "ulid";

const next = monotonicFactory();

export const ID_PREFIXES = {
  business: "biz",
  booking: "bkg",
  hold: "hld",
  call: "call",
  message: "msg",
  consent: "cns",
  rule: "rul",
  event: "evt",
} as const;

export type EntityKind = keyof typeof ID_PREFIXES;

/**
 * Prefixed, monotonic ULIDs. Ids of the same kind sort in creation order,
 * which is what lets the event stream replay "everything after id X".
 */
export function newId(kind: EntityKind, at: number = Date.now()): string {
  return `${ID_PREFIXES[kind]}_${next(at)}`;
}
