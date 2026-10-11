import { describe, expect, it } from "vitest";
import { defaultStepMinutes, generateSlots, parseBusinessHours, speakableTime, zonedInstant } from "./business-hours";

const LA = "America/Los_Angeles";
const SALS_HOURS = { "mon-fri": "08:00-18:00", sat: "09:00-14:00" };

describe("parseBusinessHours", () => {
  it("reads day ranges, single days and closed days", () => {
    const week = parseBusinessHours(SALS_HOURS);
    expect(week.mon).toEqual([{ open: 480, close: 1080 }]);
    expect(week.fri).toEqual([{ open: 480, close: 1080 }]);
    expect(week.sat).toEqual([{ open: 540, close: 840 }]);
    expect(week.sun).toEqual([]);
  });

  it("lets a specific day override a broader range, and wraps ranges past Sunday", () => {
    const week = parseBusinessHours({ "mon-sat": "08:00-17:00", sat: "09:00-14:00", "fri-mon": "10:00-11:00" });
    // fri-mon (4 days) is narrower than mon-sat (6 days), so it wins on mon, fri, sat and sun.
    expect(week.sat).toEqual([{ open: 540, close: 840 }]);
    expect(week.sun).toEqual([{ open: 600, close: 660 }]);
    expect(week.wed).toEqual([{ open: 480, close: 1020 }]);
  });

  it("reads split days, comma lists, 24:00 and closed, and skips nonsense", () => {
    const week = parseBusinessHours({ "mon,wed": "08:00-12:00,13:00-17:00", tue: "closed", thu: "00:00-24:00", fri: "late", xyz: "08:00-09:00" });
    expect(week.mon).toEqual([
      { open: 480, close: 720 },
      { open: 780, close: 1020 },
    ]);
    expect(week.wed).toHaveLength(2);
    expect(week.tue).toEqual([]);
    expect(week.thu).toEqual([{ open: 0, close: 1440 }]);
    expect(week.fri).toEqual([]);
  });
});

describe("zonedInstant (DST-safe)", () => {
  it("converts wall time to UTC on ordinary days in both offsets", () => {
    expect(zonedInstant("2026-10-12", 8 * 60, LA).toISOString()).toBe("2026-10-12T15:00:00.000Z"); // PDT
    expect(zonedInstant("2026-12-14", 8 * 60, LA).toISOString()).toBe("2026-12-14T16:00:00.000Z"); // PST
  });

  it("is right on the spring-forward day (2026-03-08), where midnight is PST and 8am is PDT", () => {
    expect(zonedInstant("2026-03-08", 8 * 60, LA).toISOString()).toBe("2026-03-08T15:00:00.000Z");
    expect(zonedInstant("2026-03-08", 1 * 60, LA).toISOString()).toBe("2026-03-08T09:00:00.000Z");
  });

  it("is right on the fall-back day (2026-11-01), where midnight is PDT and 8am is PST", () => {
    expect(zonedInstant("2026-11-01", 8 * 60, LA).toISOString()).toBe("2026-11-01T16:00:00.000Z");
    expect(zonedInstant("2026-11-01", 18 * 60, LA).toISOString()).toBe("2026-11-02T02:00:00.000Z");
  });

  it("handles a 24:00 close as the next midnight", () => {
    expect(zonedInstant("2026-10-12", 24 * 60, LA).toISOString()).toBe("2026-10-13T07:00:00.000Z");
  });
});

describe("generateSlots", () => {
  const notBefore = new Date("2026-10-11T18:00:00.000Z"); // Sunday 11:00 PDT

  it("offers hourly 45-minute slots inside Monday afternoon, like the golden path", () => {
    const slots = generateSlots({
      hours: SALS_HOURS,
      timeZone: LA,
      window: { start: "2026-10-12T19:00:00.000Z", end: "2026-10-13T00:00:00.000Z" },
      durationMinutes: 45,
      notBefore,
    });
    expect(slots.map((s) => s.start)).toEqual([
      "2026-10-12T19:00:00.000Z",
      "2026-10-12T20:00:00.000Z",
      "2026-10-12T21:00:00.000Z",
      "2026-10-12T22:00:00.000Z",
      "2026-10-12T23:00:00.000Z",
    ]);
    expect(slots[0]!.end).toBe("2026-10-12T19:45:00.000Z");
  });

  it("never offers a time outside business hours, even when the window is wider", () => {
    // Saturday 06:00 to 20:00 PDT; Sal's is open 09:00-14:00 on Saturdays.
    const slots = generateSlots({
      hours: SALS_HOURS,
      timeZone: LA,
      window: { start: "2026-10-17T13:00:00.000Z", end: "2026-10-18T03:00:00.000Z" },
      durationMinutes: 45,
      notBefore,
    });
    expect(slots[0]!.start).toBe("2026-10-17T16:00:00.000Z"); // 09:00 PDT
    expect(slots.at(-1)!.start).toBe("2026-10-17T20:00:00.000Z"); // 13:00, ends 13:45 before the 14:00 close
    expect(slots).toHaveLength(5);
  });

  it("returns nothing on a closed day", () => {
    const sunday = { start: "2026-10-18T15:00:00.000Z", end: "2026-10-19T01:00:00.000Z" };
    expect(generateSlots({ hours: SALS_HOURS, timeZone: LA, window: sunday, durationMinutes: 45, notBefore })).toEqual([]);
  });

  it("keeps the service duration inside closing time", () => {
    // Daycare drop-in day: 600 minutes, open 07:30-18:00. Hourly starts from opening:
    // 07:30 ends 17:30 and fits; 08:30 would end 18:30, after closing.
    const slots = generateSlots({
      hours: { "mon-fri": "07:30-18:00" },
      timeZone: LA,
      window: { start: "2026-10-12T07:00:00.000Z", end: "2026-10-13T07:00:00.000Z" },
      durationMinutes: 600,
      notBefore,
    });
    expect(slots.map((s) => speakableTime(s.start, LA, false))).toEqual(["7:30 AM"]);
    expect(slots[0]!.end).toBe("2026-10-13T00:30:00.000Z");
  });

  it("skips times in the past and busy times", () => {
    const slots = generateSlots({
      hours: SALS_HOURS,
      timeZone: LA,
      window: { start: "2026-10-12T15:00:00.000Z", end: "2026-10-12T20:00:00.000Z" }, // Monday 08:00-13:00 PDT
      durationMinutes: 45,
      notBefore: new Date("2026-10-12T16:10:00.000Z"), // 09:10
      isBusy: (s) => s.toISOString() === "2026-10-12T17:30:00.000Z",
    });
    // 09:30 is the first grid time after 09:10; 10:30 is busy; 12:30 would end after the window.
    expect(slots.map((s) => s.start)).toEqual(["2026-10-12T16:30:00.000Z", "2026-10-12T18:30:00.000Z"]);
  });

  it("offers slots at the right UTC instants across the spring-forward weekend", () => {
    const hours = { daily: "08:00-10:00" };
    const slots = generateSlots({
      hours,
      timeZone: LA,
      window: { start: "2026-03-07T00:00:00.000Z", end: "2026-03-10T00:00:00.000Z" },
      durationMinutes: 60,
      notBefore: new Date("2026-03-01T00:00:00.000Z"),
    });
    expect(slots.map((s) => s.start)).toEqual([
      "2026-03-07T16:00:00.000Z", // Sat 08:00 PST
      "2026-03-07T17:00:00.000Z",
      "2026-03-08T15:00:00.000Z", // Sun 08:00 PDT, after the switch
      "2026-03-08T16:00:00.000Z",
      "2026-03-09T15:00:00.000Z",
      "2026-03-09T16:00:00.000Z",
    ]);
    for (const s of slots) expect(["8:00 AM", "9:00 AM"]).toContain(speakableTime(s.start, LA, false));
  });

  it("stops at the limit and picks a step from the duration", () => {
    expect(defaultStepMinutes(30)).toBe(30);
    expect(defaultStepMinutes(45)).toBe(60);
    expect(defaultStepMinutes(600)).toBe(60);
    const slots = generateSlots({
      hours: SALS_HOURS,
      timeZone: LA,
      window: { start: "2026-10-12T00:00:00.000Z", end: "2026-10-20T00:00:00.000Z" },
      durationMinutes: 30,
      notBefore,
      limit: 3,
    });
    expect(slots).toHaveLength(3);
  });

  it("returns nothing for an empty or inverted window", () => {
    const w = { start: "2026-10-12T20:00:00.000Z", end: "2026-10-12T19:00:00.000Z" };
    expect(generateSlots({ hours: SALS_HOURS, timeZone: LA, window: w, durationMinutes: 45, notBefore })).toEqual([]);
  });
});
