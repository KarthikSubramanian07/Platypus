import { describe, expect, it } from "vitest";
import { customerHoursPerYear, formatCallOffset, formatClock, formatConfidence, formatLatency, formatMoney, formatRail, formatSlot, formatTrade, GOLDEN_STEPS, initials, ownerHoursPerYear, stepFor, summarize, type StreamEvent } from "./format";

describe("live dashboard formatters", () => {
  it("formats money from cents, and nothing for a missing price", () => {
    expect(formatMoney(8900)).toBe("$89");
    expect(formatMoney(8950)).toBe("$89.50");
    expect(formatMoney(120000)).toBe("$1,200");
    expect(formatMoney(null)).toBeUndefined();
  });

  it("shows slots in the shop's time zone", () => {
    expect(formatSlot("2026-10-12T21:00:00.000Z")).toBe("Mon 2:00 PM");
    expect(formatSlot("2026-10-13T17:00:00.000Z")).toBe("Tue 10:00 AM");
    expect(formatSlot("garbage")).toBeUndefined();
  });

  it("formats clocks, call offsets and latency", () => {
    expect(formatClock(7)).toBe("0:07");
    expect(formatClock(125)).toBe("2:05");
    expect(formatClock(-3)).toBe("0:00");
    expect(formatCallOffset(15100)).toBe("0:15");
    expect(formatCallOffset(undefined)).toBe("");
    expect(formatLatency(830)).toBe("830 ms");
    expect(formatLatency(1050)).toBe("1.05 s");
    expect(formatLatency(21000)).toBe("21.0 s");
  });

  it("names rails, trades and initials", () => {
    expect(formatRail("imessage")).toBe("iMessage");
    expect(formatRail("whatsapp")).toBe("WhatsApp");
    expect(formatRail("dial")).toBe("Dial");
    expect(formatTrade("dog_groomer")).toBe("Dog groomer");
    expect(initials("Sal's Auto")).toBe("SA");
    expect(initials("")).toBe("?");
  });
});

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

describe("time saved", () => {
  it("matches the figures printed on the page", () => {
    expect(customerHoursPerYear(4)).toBe(15);
    expect(customerHoursPerYear(40)).toBe(154);
    expect(ownerHoursPerYear(10)).toBe(33);
  });

  it("saves nothing when nothing is booked", () => {
    expect(customerHoursPerYear(0)).toBe(0);
    expect(ownerHoursPerYear(0)).toBe(0);
  });
});
