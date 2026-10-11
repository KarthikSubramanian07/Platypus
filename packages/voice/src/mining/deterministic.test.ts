import { describe, expect, it } from "vitest";
import * as M from "./deterministic";

describe("spoken numbers", () => {
  it.each([
    ["eighty-nine", 89],
    ["a hundred and twenty", 120],
    ["one twenty", 120],
    ["ninety nine", 99],
  ])("%s -> %i", (words, n) => expect(M.wordsToNumber(words)).toBe(n));
});

describe("prices", () => {
  it("reads the demo line", () => expect(M.findPrices("Two o'clock works. Eighty-nine bucks.").map((p) => p.cents)).toEqual([8900]));
  it("reads dollars and cents and flags approximations", () =>
    expect(M.findPrices("It's about $95.50 for synthetic").map((p) => [p.cents, p.approximate])).toEqual([[9550, true]]));
  it("reads price shorthand", () => expect(M.findPrices("one twenty dollars").map((p) => p.cents)).toEqual([12000]));
});

describe("times", () => {
  it("two o'clock is 14:00 in the afternoon", () => expect(M.findTimes("Two o'clock works. Eighty-nine bucks.").map((t) => t.hour24)).toEqual([14]));
  it("3:30", () => expect(M.findTimes("how about 3:30?").map((t) => [t.hour24, t.minute])).toEqual([[15, 30]]));
  it("half past two", () => expect(M.findTimes("half past two").map((t) => [t.hour24, t.minute])).toEqual([[14, 30]]));
  it("ten in the morning", () => expect(M.findTimes("ten in the morning").map((t) => t.hour24)).toEqual([10]));
  it("noon", () => expect(M.findTimes("noon is fine").map((t) => t.hour24)).toEqual([12]));
  it("a bare number is not a time", () => expect(M.findTimes("I have 2 bays")).toHaveLength(0));
  it("two thirty is 2:30, not 230", () => expect(M.findTimes("two thirty").map((t) => [t.hour24, t.minute])).toEqual([[14, 30]]));
  it("marks inferred meridiems", () => {
    expect(M.findTimes("two o'clock")[0]?.explicit).toBe(false);
    expect(M.findTimes("2pm")[0]?.explicit).toBe(true);
  });
});

describe("lead times and hours", () => {
  it("45 minutes", () => expect(M.findLeadTimes("takes about forty-five minutes").map((d) => d.minutes)).toEqual([45]));
  it("2 days", () => expect(M.findLeadTimes("we need two days notice").map((d) => d.minutes)).toEqual([2880]));
  it("hours", () => expect(M.findHours("we're open eight to six, Monday through Saturday").map((h) => h.kind)).toEqual(["open_range", "days"]));
});

describe("intent patterns", () => {
  it("yes", () => expect(M.YES_RE.test("Yeah, text me.")).toBe(true));
  it("no", () => expect(M.NO_RE.test("Nah, just call.")).toBe(true));
  it("do not call", () => expect(M.DNC_RE.test("Please don't call here again")).toBe(true));
  it("not do not call", () => expect(M.DNC_RE.test("call me anytime")).toBe(false));
  it("this one", () => expect(M.THIS_LINE_RE.test("This one.")).toBe(true));
  it("owner name", () => expect(M.findOwnerName("Sal's Auto, this is Eddy.")).toBe("Eddy"));
  it("phone in words", () => expect(M.findSpokenPhone("four one five, five five five, oh one two three")).toBe("+14155550123"));
  it("phone in digits", () => expect(M.findSpokenPhone("415 555 0123")).toBe("+14155550123"));
  it("asked if AI", () => expect(M.AI_Q_RE.test("wait, are you a robot?")).toBe(true));
  it("voicemail", () => expect(M.VOICEMAIL_RE.test("Please leave a message after the tone")).toBe(true));
});

describe("friction", () => {
  it("measures replies, talking over and clarifications", () => {
    const f = M.friction([
      { speaker: "agent", text: "Hi", startMs: 1200, endMs: 6400 },
      { speaker: "user", text: "It is.", startMs: 7000, endMs: 7800 },
      { speaker: "agent", text: "A customer", startMs: 8600, endMs: 14000 },
      { speaker: "user", text: "Sorry?", startMs: 13800, endMs: 14500 },
    ]);
    expect(f.pauses).toEqual([600, 800, -200]);
    expect(f.maxPauseMs).toBe(800);
    expect(f.owner_reply_latency_ms).toEqual([600, 0]);
    expect(f.overlaps).toBe(1);
    expect(f.clarification_requests).toBe(1);
    // 0.4 * (600 / 2500) + 0.3 * (1 / 3) + 0.3 * (1 / 2)
    expect(f.score).toBeCloseTo(0.35, 2);
  });
});
