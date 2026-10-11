import { describe, expect, it } from "vitest";
import { formatConfidence, GOLDEN_STEPS, stepFor, summarize, type StreamEvent } from "./format";

const base: StreamEvent = { id: "evt_1", type: "x", actor: "system", refs: {}, payload: {}, reason: null, confidence: 1, created_at: "2026-10-12T02:00:00.000Z" };

describe("summarize", () => {
  it("names the mid-call tool and flags failures", () => {
    expect(summarize({ ...base, type: "voice.tool_called", payload: { tool: "hold_slot", ok: true } })).toBe("hold_slot");
    expect(summarize({ ...base, type: "voice.tool_called", payload: { tool: "hold_slot", ok: false } })).toBe("hold_slot (failed)");
  });

  it("shows booking transitions with the short code", () => {
    expect(summarize({ ...base, type: "booking.confirmed", payload: { short_code: "SAL-4K2", from: "pending", to: "confirmed" } })).toBe("SAL-4K2 · pending to confirmed");
  });

  it("quotes the consent sentence", () => {
    expect(summarize({ ...base, type: "darwin.searched", payload: { status: "completed", outcome: "listed_only", agents: [{ can_start_thread: false }] } })).toBe(
      "no ready agent · 1 listed, none can start",
    );
    expect(summarize({ ...base, type: "darwin.searched", payload: { status: "completed", outcome: "listed_only", agents: [{}], cached: true } })).toBe(
      "no ready agent · 1 listed, none can start (cached)",
    );
    expect(summarize({ ...base, type: "darwin.searched", payload: { status: "error", http_status: 500, timed_out: true } })).toBe("status error (HTTP 500) (timed out)");
    expect(summarize({ ...base, type: "darwin.searched", payload: { status: "needs_input" } })).toBe("Darwin asked for more input");
    expect(summarize({ ...base, type: "consent.recorded", payload: { quoted_sentence: "Yeah, text me." } })).toBe('"Yeah, text me."');
  });

  it("formats confidence as a percentage", () => {
    expect(formatConfidence(0.873)).toBe("87%");
  });
});

describe("stepFor", () => {
  it("maps the golden-path milestones", () => {
    expect(stepFor({ ...base, type: "agent.tool_called", payload: { tool: "search_providers" } })).toBe("ask");
    expect(stepFor({ ...base, type: "call.placed" })).toBe("call");
    expect(stepFor({ ...base, type: "voice.tool_called", payload: { tool: "create_booking", ok: true } })).toBe("tools");
    expect(stepFor({ ...base, type: "voice.tool_called", payload: { tool: "create_booking", ok: false } })).toBeUndefined();
    expect(stepFor({ ...base, type: "booking.confirmed", payload: { evidence: { kind: "call" } } })).toBeUndefined();
    expect(stepFor({ ...base, type: "booking.confirmed", payload: { evidence: { kind: "text" } } })).toBe("confirmed");
  });

  it("lights every step when the recorded golden path plays", async () => {
    const { GOLDEN_PATH } = await import("./fixture");
    const keys = new Set(GOLDEN_PATH.map(stepFor).filter(Boolean));
    expect([...keys]).toEqual(GOLDEN_STEPS.map((s) => s.key));
  });
});
