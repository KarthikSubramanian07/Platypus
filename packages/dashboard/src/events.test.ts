import { describe, expect, it } from "vitest";
import { parseStreamEvent, resolveSource } from "./events";

describe("resolveSource", () => {
  it("plays the recording in a production build with no server configured", () => {
    expect(resolveSource("", { PROD: true })).toEqual({ mode: "recording", base: "" });
  });

  it("streams same-origin in dev", () => {
    expect(resolveSource("", { PROD: false })).toEqual({ mode: "live", base: "" });
  });

  it("lets ?events= override the build setting, without a trailing slash", () => {
    expect(resolveSource("?events=https://demo.example.com/", { PROD: true, VITE_EVENTS_URL: "https://other.example.com" })).toEqual({ mode: "live", base: "https://demo.example.com" });
    expect(resolveSource("", { PROD: true, VITE_EVENTS_URL: "https://other.example.com" })).toEqual({ mode: "live", base: "https://other.example.com" });
  });
});

describe("parseStreamEvent", () => {
  it("accepts a Platypus event and fills safe defaults", () => {
    expect(parseStreamEvent(JSON.stringify({ id: "evt_1", type: "call.placed", created_at: "2026-10-12T02:00:00.000Z", payload: { state: "Queued" } }))).toEqual({
      id: "evt_1",
      type: "call.placed",
      actor: "system",
      refs: {},
      payload: { state: "Queued" },
      reason: null,
      confidence: 1,
      created_at: "2026-10-12T02:00:00.000Z",
    });
  });

  it("drops frames that are not events instead of throwing", () => {
    expect(parseStreamEvent("not json")).toBeUndefined();
    expect(parseStreamEvent("{}")).toBeUndefined();
    expect(parseStreamEvent("null")).toBeUndefined();
    expect(parseStreamEvent(JSON.stringify({ id: 1, type: "x", created_at: "y" }))).toBeUndefined();
  });

  it("never lets an array or a string stand in for payload or refs", () => {
    const event = parseStreamEvent(JSON.stringify({ id: "e", type: "t", created_at: "c", payload: [1], refs: "x" }));
    expect(event?.payload).toEqual({});
    expect(event?.refs).toEqual({});
  });
});
