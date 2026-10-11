import type { StreamEvent } from "./format";
import goldenPath from "../../shared/src/testing/fixtures/golden-path.jsonl?raw";

/** The golden-path run recorded against the fakes, bundled so the deployed dashboard works with no server. */
export const GOLDEN_PATH: StreamEvent[] = goldenPath
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as StreamEvent);

/** Plays events with their original gaps, sped up and capped, and stamps them with the current time. Used by the landing page's log. */
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

// ---- The paced recording /live plays -------------------------------------------------------

/**
 * One event of the plan: when it plays on the wall clock, and where it sits on the
 * recording's own clock. Both are milliseconds from the start of the run.
 */
export interface PlannedEvent {
  event: StreamEvent;
  wallMs: number;
  recordedMs: number;
}

/**
 * Something the phone shows ahead of an event, because a recording knows what comes next:
 * Platypus typing before its text lands, the owner composing their reply before it sends.
 * Nothing here enters the reducer; it is presentation only.
 */
export interface PlannedCue {
  kind: "typing" | "composing";
  fromMs: number;
  toMs: number;
  text?: string;
}

export interface RecordingPlan {
  events: PlannedEvent[];
  cues: PlannedCue[];
  /** Wall time of the last event. */
  totalMs: number;
}

export interface PlanOptions {
  /** How much faster than real time the recording plays. */
  speed: number;
  /** Longest pause between two events outside a call. */
  maxGapMs: number;
}

const isAsk = (e: StreamEvent) => e.type === "agent.tool_called" && e.payload.tool === "search_providers";

/**
 * The least wall time an audience needs before each story beat. The recording itself
 * has many events at the same instant (the ask, Darwin, the route and the dial all
 * land at 0 ms), which would read as one jump.
 */
const DWELL: [(e: StreamEvent) => boolean, number][] = [
  [isAsk, 900],
  [(e) => e.type === "darwin.searched", 1_800],
  [(e) => e.type === "booking.pending", 2_000],
  [(e) => e.type === "call.placed", 1_400],
  [(e) => e.type === "call.status_changed" && e.payload.to === "In-Progress", 3_200],
  [(e) => e.type === "message.sent", 2_200],
  [(e) => e.type === "message.received", 3_400],
];

/**
 * Turns a recording into a schedule a person can follow. Outside a call, gaps are
 * sped up and capped, and each beat gets at least its dwell. Inside a call nothing is
 * capped or stretched: the call plays at exactly `speed`, so captions revealed at
 * call start + startMs stay in step with the tools the voice agent called.
 */
export function planRecording(events: readonly StreamEvent[], { speed, maxGapMs }: PlanOptions): RecordingPlan {
  const first = events.length ? Date.parse(events[0]!.created_at) : 0;
  const planned: PlannedEvent[] = [];
  let wall = 0;
  let previousRecorded = 0;
  let inCall = false;
  for (const event of events) {
    const recordedMs = Math.max(previousRecorded, Date.parse(event.created_at) - first || 0);
    const gap = (recordedMs - previousRecorded) / speed;
    const dwell = DWELL.find(([match]) => match(event))?.[1] ?? 0;
    const step = planned.length === 0 ? 0 : inCall ? gap : Math.max(dwell, Math.min(gap, maxGapMs));
    wall += step;
    planned.push({ event, wallMs: Math.round(wall), recordedMs });
    previousRecorded = recordedMs;
    if (event.type === "call.status_changed" && event.payload.to === "In-Progress") inCall = true;
    if ((event.type === "call.status_changed" && event.payload.to === "Terminated") || event.type === "call.ended") inCall = false;
  }

  const cues: PlannedCue[] = [];
  for (const [i, p] of planned.entries()) {
    const before = planned[i - 1]?.wallMs ?? 0;
    if (p.event.type === "message.sent") cues.push({ kind: "typing", fromMs: Math.max(before, p.wallMs - 1_400), toMs: p.wallMs });
    if (p.event.type === "message.received" && typeof p.event.payload.body === "string") {
      cues.push({ kind: "composing", fromMs: Math.max(before + 400, p.wallMs - 1_700), toMs: p.wallMs, text: p.event.payload.body.slice(0, 40) });
    }
  }
  return { events: planned, cues, totalMs: planned.at(-1)?.wallMs ?? 0 };
}

/**
 * The recording's clock at a wall time, interpolated between planned events. It runs at
 * exactly `speed` during the call and stands still through a dwell, so the call timer
 * and the captions follow the recording, not the wall.
 */
export function recordedAt(plan: RecordingPlan, wallMs: number): number {
  const items = plan.events;
  if (!items.length || wallMs <= items[0]!.wallMs) return items[0]?.recordedMs ?? 0;
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1]!;
    const b = items[i]!;
    if (wallMs <= b.wallMs) {
      const span = b.wallMs - a.wallMs;
      return span <= 0 ? b.recordedMs : a.recordedMs + ((wallMs - a.wallMs) / span) * (b.recordedMs - a.recordedMs);
    }
  }
  return items.at(-1)!.recordedMs;
}

/** The cues showing at a wall time. */
export function cuesAt(plan: RecordingPlan, wallMs: number): PlannedCue[] {
  return plan.cues.filter((c) => wallMs >= c.fromMs && wallMs < c.toMs);
}
