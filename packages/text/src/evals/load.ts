import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Classification } from "@platypus/shared/contracts";
import type { ReplyContext, ReplyingTo } from "../classify";

/** One labeled owner reply from evals/owner-replies.jsonl. */
export interface EvalRow {
  id: string;
  text: string;
  replying_to: ReplyingTo;
  expected_class: Classification["class"];
  acceptable_classes?: Classification["class"][];
  expected_keyword?: string;
  expected_extracted?: { time?: string; time_iso?: string; price_cents?: number };
  /** True when the deterministic layer must decide this row; false when it must abstain. */
  deterministic: boolean;
  reaction?: string;
  channel?: string;
  notes?: string;
}

export const EVAL_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../evals/owner-replies.jsonl");

export function loadEvalRows(path = EVAL_PATH): EvalRow[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalRow);
}

/**
 * Every row is read as a reply to the golden-path request: brake inspection held
 * for Tue Oct 13, 10am Pacific, received Sunday Oct 11 at noon Pacific.
 */
export const EVAL_NOW = new Date("2026-10-11T19:00:00.000Z");
export const EVAL_OFFER = { service: "brake inspection", slot_start: "2026-10-13T17:00:00.000Z", window_start: "2026-10-13T17:00:00.000Z", price_cents: null };

export function evalContext(row: EvalRow): ReplyContext {
  return {
    now: EVAL_NOW,
    timeZone: "America/Los_Angeles",
    replying_to: row.replying_to,
    offer: row.replying_to === "new_request" ? EVAL_OFFER : null,
    reaction: row.reaction ?? null,
  };
}

export const acceptable = (row: EvalRow): string[] => row.acceptable_classes ?? [row.expected_class];
