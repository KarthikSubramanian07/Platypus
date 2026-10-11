import { describe, expect, it } from "vitest";
import { formatConfidence, summarize, type StreamEvent } from "./format";

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
    expect(summarize({ ...base, type: "consent.recorded", payload: { quoted_sentence: "Yeah, text me." } })).toBe('"Yeah, text me."');
  });

  it("formats confidence as a percentage", () => {
    expect(formatConfidence(0.873)).toBe("87%");
  });
});
