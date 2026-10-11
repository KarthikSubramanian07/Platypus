import type { StreamEvent } from "./format";
import goldenPath from "../../shared/src/testing/fixtures/golden-path.jsonl?raw";

/** The golden-path run recorded against the fakes, bundled so the deployed dashboard works with no server. */
export const GOLDEN_PATH: StreamEvent[] = goldenPath
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as StreamEvent);

/** Plays events with their original gaps, sped up and capped, and stamps them with the current time. */
export async function playRecording(events: StreamEvent[], onEvent: (e: StreamEvent) => void, speed = 2, maxGapMs = 2_500, signal?: AbortSignal): Promise<void> {
  let previous: number | undefined;
  for (const [i, event] of events.entries()) {
    if (signal?.aborted) return;
    const at = new Date(event.created_at).getTime();
    if (previous !== undefined) await new Promise((r) => setTimeout(r, Math.min(Math.max(0, at - previous!) / speed, maxGapMs)));
    previous = at;
    onEvent({ ...event, id: `${event.id}-r${Date.now()}-${i}`, created_at: new Date().toISOString(), payload: { ...event.payload, replayed: true } });
  }
}
