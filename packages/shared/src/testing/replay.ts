import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/repo";
import type { EventBus } from "../events/bus";
import { parseJsonl, reemit } from "../events/log";
import type { PlatypusEvent } from "../events/types";

export const GOLDEN_PATH_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "golden-path.jsonl");

export function loadGoldenPath(): PlatypusEvent[] {
  return parseJsonl(readFileSync(GOLDEN_PATH_FIXTURE, "utf8"));
}

export interface ReplayOptions {
  db: Db;
  bus?: Pick<EventBus, "publish">;
  /** 1 = original pacing, 4 = four times faster, Infinity = all at once. */
  speed?: number;
  /** Cap any single gap so long pauses in a fixture do not stall a demo. */
  maxGapMs?: number;
  signal?: AbortSignal;
}

/**
 * Re-appends fixture events to the log with their original relative timing.
 * Every replayed event is marked payload.replayed = true so the dashboard can say so.
 */
export async function replayEvents(events: PlatypusEvent[], { db, bus, speed = 1, maxGapMs = 3_000, signal }: ReplayOptions): Promise<number> {
  let previous: number | undefined;
  let count = 0;
  for (const event of events) {
    if (signal?.aborted) break;
    const at = new Date(event.created_at).getTime();
    if (previous !== undefined && Number.isFinite(speed)) {
      const gap = Math.min(Math.max(0, at - previous) / speed, maxGapMs);
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
    previous = at;
    reemit(db, { ...event, payload: { ...event.payload, replayed: true } }, bus ? { bus } : {});
    count += 1;
  }
  return count;
}
