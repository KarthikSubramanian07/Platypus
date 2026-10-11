import { afterEach, describe, expect, it, vi } from "vitest";
import { connectLive, isCrossOrigin, parseStreamEvent, postDemo, requestKillCall, requestOwnerReply, requestReplay, resolveSource, withToken, type ConnectionState } from "./events";

/** Just enough of EventSource to drive connectLive from a test. */
class FakeSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static all: FakeSource[] = [];
  readyState = FakeSource.CONNECTING;
  private listeners = new Map<string, ((e: unknown) => void)[]>();
  constructor(public url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, e: unknown = {}) {
    if (type === "open") this.readyState = FakeSource.OPEN;
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  close() {
    this.readyState = FakeSource.CLOSED;
  }
}

describe("connectLive", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeSource.all = [];
  });

  it("reopens a silent stream from the last event it saw, and reports the state", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeSource);
    const states: ConnectionState[] = [];
    const events: string[] = [];
    const close = connectLive("http://x", { onEvent: (e) => events.push(e.id), onState: (s) => states.push(s) }, { staleMs: 10_000 });
    const first = FakeSource.all[0]!;
    expect(first.url).toBe("http://x/events/stream");
    first.emit("open");
    first.emit("platypus", { data: JSON.stringify({ id: "evt_9", type: "x", created_at: "t" }), lastEventId: "evt_9" });
    vi.advanceTimersByTime(8_000);
    first.emit("heartbeat");
    vi.advanceTimersByTime(8_000);
    expect(FakeSource.all).toHaveLength(1); // heartbeats keep it alive
    vi.advanceTimersByTime(10_000);
    expect(first.readyState).toBe(FakeSource.CLOSED);
    expect(FakeSource.all[1]!.url).toBe("http://x/events/stream?after=evt_9");
    expect(states).toEqual(["connecting", "live", "reconnecting", "reconnecting"]);
    expect(events).toEqual(["evt_9"]);
    close();
  });

  it("passes DASHBOARD_TOKEN to the stream as ?token=, on reconnects too", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeSource);
    const close = connectLive("https://tunnel.example", { onEvent: () => {}, onState: () => {} }, { staleMs: 10_000, token: "t&k=1" });
    const first = FakeSource.all[0]!;
    expect(first.url).toBe("https://tunnel.example/events/stream?token=t%26k%3D1");
    first.emit("open");
    first.emit("platypus", { data: JSON.stringify({ id: "evt_2", type: "x", created_at: "t" }), lastEventId: "evt_2" });
    vi.advanceTimersByTime(30_000);
    expect(FakeSource.all[1]!.url).toBe("https://tunnel.example/events/stream?after=evt_2&token=t%26k%3D1");
    close();
  });

  it("retries with backoff when the browser gives up on the source", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeSource);
    connectLive("", { onEvent: () => {}, onState: () => {} });
    const first = FakeSource.all[0]!;
    first.readyState = FakeSource.CLOSED;
    first.emit("error");
    expect(FakeSource.all).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(FakeSource.all).toHaveLength(2);
  });
});

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
    expect(resolveSource("?events=https://t.example&token=%20abc%20", { PROD: true })).toEqual({ mode: "live", base: "https://t.example", token: "abc" });
    expect(resolveSource("?token=", { PROD: false })).toEqual({ mode: "live", base: "" });
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

describe("demo controls", () => {
  afterEach(() => vi.unstubAllGlobals());
  const ORIGIN = "http://localhost:5173";

  it("sends the token with every demo control, and nothing when there is none", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await requestKillCall("", "tok");
    await requestOwnerReply("https://tunnel.example", "Y", "tok");
    await requestReplay("", "tok");
    const urls = fetch.mock.calls.map((call) => (call as unknown[])[0]);
    expect(urls).toEqual(["/demo/kill-call?token=tok", "https://tunnel.example/demo/owner-reply?token=tok", "/demo/replay?token=tok"]);
    expect(withToken("/x?a=1", undefined)).toBe("/x?a=1");
  });

  it("tells same-origin from cross-origin bases", () => {
    expect(isCrossOrigin("", ORIGIN)).toBe(false);
    expect(isCrossOrigin("http://localhost:5173", ORIGIN)).toBe(false);
    expect(isCrossOrigin("http://localhost:8794", ORIGIN)).toBe(true);
    expect(isCrossOrigin("http://[bad", ORIGIN)).toBe(false);
  });

  it("posts JSON same-origin and reads the answer", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    expect(await postDemo("", "/demo/owner-reply", { body: "Y" }, ORIGIN)).toEqual({ ok: false, status: 404 });
    expect(fetch).toHaveBeenCalledWith("/demo/owner-reply", { method: "POST", body: '{"body":"Y"}', headers: { "content-type": "application/json" } });
  });

  it("sends a CORS-simple no-cors request cross-origin and says the answer is unconfirmed", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await postDemo("http://localhost:8794", "/demo/owner-reply", { body: "N" }, ORIGIN)).toEqual({ ok: true, status: 0, unconfirmed: true });
    expect(fetch).toHaveBeenCalledWith("http://localhost:8794/demo/owner-reply", { method: "POST", body: '{"body":"N"}', headers: { "content-type": "text/plain" }, mode: "no-cors" });
  });

  it("reports a server that did not answer, and wires the kill switch, owner reply and replay", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("down"))));
    expect(await requestKillCall("")).toEqual({ ok: false, status: 0 });
    expect(await requestOwnerReply("", "Y")).toEqual({ ok: false, status: 0 });
    expect(await requestReplay("")).toBe(false);
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await requestKillCall("")).toEqual({ ok: true, status: 200 });
    expect(fetch).toHaveBeenCalledWith("/demo/kill-call", { method: "POST" });
  });
});
