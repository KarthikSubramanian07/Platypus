import { goldenCallScript } from "@platypus/shared/testing";
import { describe, expect, it, vi } from "vitest";
import type { AnthropicLike } from "./claude";
import type { TimedTurn } from "./deterministic";
import { mineTranscript } from "./mine";

/** The demo call's transcript turns, exactly as FakeDial plays them. */
function goldenTurns(now = new Date("2026-10-11T19:00:00.000Z")): TimedTurn[] {
  return goldenCallScript({ now }).flatMap((s) => (s.kind === "turn" ? [{ speaker: s.speaker, text: s.text, startMs: s.atMs, endMs: s.atMs + s.durationMs }] : []));
}

const WINDOW = { startIso: "2026-10-12T19:00:00.000Z", endIso: "2026-10-13T00:00:00.000Z", timeZone: "America/Los_Angeles" };
const value = (r: Awaited<ReturnType<typeof mineTranscript>>, kind: string) => r.findings.filter((f) => f.kind === kind).map((f) => f.value);

describe("mineTranscript on the golden call", () => {
  it("finds the price, the time, the consent sentence and the text number", async () => {
    const r = await mineTranscript(goldenTurns(), { anthropic: null, window: WINDOW });
    expect(value(r, "price")).toEqual([8900]);
    expect(value(r, "slot_time")).toEqual(["14:00"]);
    const consent = r.findings.find((f) => f.kind === "consent_sentence")!;
    expect(consent).toMatchObject({ value: "yes", quote: "Yeah, text me.", turnIndex: 7 });
    expect(value(r, "text_number")).toEqual(["this_line"]);
    expect(value(r, "do_not_call")).toEqual([]);
    expect(r.claude.used).toBe(false);
  });

  it("is more confident when the agent repeated the value back", async () => {
    const r = await mineTranscript(goldenTurns(), { anthropic: null, window: WINDOW });
    const price = r.findings.find((f) => f.kind === "price")!;
    expect(price.confidence).toBe(0.95);
    expect(price.quote).toBe("Two o'clock works. Eighty-nine bucks.");
    expect(r.findings.every((f) => f.confidence > 0 && f.confidence < 1)).toBe(true);
  });

  it("scores friction from the turn timings", async () => {
    const r = await mineTranscript(goldenTurns(), { anthropic: null });
    expect(r.friction.pauses.length).toBeGreaterThan(0);
    expect(r.friction.maxPauseMs).toBeGreaterThan(0);
    expect(r.friction.score).toBeGreaterThanOrEqual(0);
    expect(r.friction.score).toBeLessThan(0.5);
  });

  it("puts a bare time inside a morning window", async () => {
    const turns: TimedTurn[] = [
      { speaker: "agent", text: "Do you have an opening tomorrow morning?", startMs: 0, endMs: 2000 },
      { speaker: "user", text: "Eight o'clock, sixty bucks.", startMs: 2500, endMs: 4000 },
    ];
    const r = await mineTranscript(turns, { anthropic: null, window: { startIso: "2026-10-12T15:00:00.000Z", endIso: "2026-10-12T19:00:00.000Z", timeZone: "America/Los_Angeles" } });
    expect(value(r, "slot_time")).toEqual(["08:00"]);
    expect(value(r, "price")).toEqual([6000]);
  });

  it("flags do-not-call and a refused consent", async () => {
    const turns: TimedTurn[] = [
      { speaker: "agent", text: "Last thing. Next time a customer's agent needs you, can I text you instead of calling? Just a yes or no.", startMs: 0, endMs: 5000 },
      { speaker: "user", text: "No. And don't call here again.", startMs: 5600, endMs: 7000 },
      { speaker: "agent", text: "Understood, we won't call again.", startMs: 7400, endMs: 9000 },
    ];
    const r = await mineTranscript(turns, { anthropic: null });
    expect(value(r, "consent_sentence")).toEqual(["no"]);
    expect(r.findings.find((f) => f.kind === "do_not_call")?.confidence).toBe(0.95);
  });
});

describe("the optional Claude pass", () => {
  const stub = (findings: unknown[]): AnthropicLike & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return {
      calls,
      messages: {
        parse: vi.fn(async (params: unknown) => {
          calls.push(params);
          return { parsed_output: { findings } };
        }) as never,
      },
    };
  };

  it("adds what the patterns missed, only with a verbatim quote, capped below the deterministic findings", async () => {
    const client = stub([
      { kind: "lead_time", value: "2880", quote: "booked solid till Thursday", turn_index: 1, confidence: 0.99 },
      { kind: "hours", value: "open Sundays", quote: "we are open Sundays", turn_index: 1, confidence: 0.9 }, // not said: dropped
      { kind: "price", value: "100", quote: "Two o'clock", turn_index: 1, confidence: 0.9 }, // price already found: ignored
    ]);
    const turns: TimedTurn[] = [
      { speaker: "agent", text: "What's the price?", startMs: 0, endMs: 1000 },
      { speaker: "user", text: "Two o'clock, eighty-nine bucks, but we're booked solid till Thursday.", startMs: 1500, endMs: 4000 },
    ];
    const r = await mineTranscript(turns, { anthropic: client });
    expect(r.claude.used).toBe(true);
    const claude = r.findings.filter((f) => f.method === "claude");
    expect(claude).toHaveLength(1);
    expect(claude[0]).toMatchObject({ kind: "lead_time", value: 2880, confidence: 0.85 });
    expect(value(r, "price")).toEqual([8900]);

    const params = client.calls[0] as { model: string; temperature?: number; messages: { content: string }[]; output_config: unknown };
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params).not.toHaveProperty("temperature");
    expect(params.output_config).toBeDefined();
    expect(params.messages[0]!.content).toMatch(/^<transcript>\n[\s\S]*\n<\/transcript>$/);
  });

  it("keeps the deterministic findings when the model fails", async () => {
    const failing: AnthropicLike = { messages: { parse: vi.fn(async () => Promise.reject(new Error("overloaded"))) as never } };
    const r = await mineTranscript(goldenTurns(), { anthropic: failing });
    expect(r.claude).toEqual({ used: true, error: "overloaded" });
    expect(value(r, "price")).toEqual([8900]);
  });
});
