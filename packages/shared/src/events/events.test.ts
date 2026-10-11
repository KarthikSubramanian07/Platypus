import { describe, expect, it } from "vitest";
import { manualClock } from "../clock";
import { openDb, seed } from "../db/index";
import { EventBus } from "./bus";
import { createEventsApp } from "./sse";
import { clampLimit, emit, exportJsonl, listEvents, MAX_EVENTS_PAGE, parseJsonl } from "./log";
import { emitSeedEvents } from "./seed-events";
import type { PlatypusEvent } from "./types";

function setup() {
  const db = openDb(":memory:");
  const bus = new EventBus();
  const clock = manualClock();
  return { db, bus, clock };
}

describe("emit", () => {
  it("writes to the log and broadcasts on the bus", () => {
    const { db, bus, clock } = setup();
    const seen: PlatypusEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const event = emit(db, { type: "booking.pending", actor: "agent", refs: { booking_id: "bkg_1" }, reason: "requested", confidence: 0.9 }, { bus, clock });
    expect(seen).toEqual([event]);
    expect(listEvents(db)).toEqual([event]);
    expect(event).toMatchObject({ actor: "agent", refs: { booking_id: "bkg_1" }, reason: "requested", confidence: 0.9 });
  });

  it("issues ids that sort in emission order", () => {
    const { db, bus, clock } = setup();
    const ids = Array.from({ length: 50 }, (_, i) => emit(db, { type: "t", actor: "system", payload: { i } }, { bus, clock }).id);
    expect([...ids].sort()).toEqual(ids);
    expect(listEvents(db, { afterId: ids[24] })).toHaveLength(25);
  });

  it("rejects unknown actors and out-of-range confidence", () => {
    const { db, bus } = setup();
    expect(() => emit(db, { type: "t", actor: "robot" as never }, { bus })).toThrow(/actor/);
    expect(() => emit(db, { type: "t", actor: "system", confidence: 1.5 }, { bus })).toThrow(/Confidence/);
  });

  it("filters by booking and type", () => {
    const { db, bus } = setup();
    emit(db, { type: "a", actor: "system", refs: { booking_id: "b1" } }, { bus });
    emit(db, { type: "b", actor: "system", refs: { booking_id: "b2" } }, { bus });
    expect(listEvents(db, { bookingId: "b2" }).map((e) => e.type)).toEqual(["b"]);
    expect(listEvents(db, { type: "a" })).toHaveLength(1);
  });
});

describe("JSONL", () => {
  it("round-trips", () => {
    const { db, bus } = setup();
    emit(db, { type: "a", actor: "voice", payload: { x: 1 } }, { bus });
    emit(db, { type: "b", actor: "owner" }, { bus });
    const events = listEvents(db);
    expect(parseJsonl(exportJsonl(events))).toEqual(events);
  });
});

describe("seed events", () => {
  it("emits business.listed for each seeded business", () => {
    const { db, bus } = setup();
    seed(db, { allowedNumbers: ["+15550100001"], onSeeded: emitSeedEvents(db, { bus }) });
    const listed = listEvents(db, { type: "business.listed" });
    expect(listed).toHaveLength(6);
    expect(listed.every((e) => e.actor === "system" && e.refs.business_id)).toBe(true);
  });
});

async function readSse(res: Response, count: number): Promise<{ event: string; id?: string; data: string }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out: { event: string; id?: string; data: string }[] = [];
  while (out.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const msg: { event: string; id?: string; data: string } = { event: "message", data: "" };
      for (const line of chunk.split("\n")) {
        const [k, ...rest] = line.split(":");
        const v = rest.join(":").trimStart();
        if (k === "event") msg.event = v;
        if (k === "id") msg.id = v;
        if (k === "data") msg.data += v;
      }
      out.push(msg);
    }
  }
  await reader.cancel();
  return out;
}

describe("GET /events/stream", () => {
  it("replays the backlog after Last-Event-ID, then streams live events without duplicates", async () => {
    const { db, bus } = setup();
    const first = emit(db, { type: "one", actor: "system" }, { bus });
    emit(db, { type: "two", actor: "system" }, { bus });
    const app = createEventsApp({ db, bus, heartbeatMs: 50 });
    const res = await app.request("/events/stream", { headers: { "last-event-id": first.id } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    setTimeout(() => emit(db, { type: "three", actor: "owner" }, { bus }), 20);
    const messages = (await readSse(res, 3)).filter((m) => m.event === "platypus");
    expect(messages.map((m) => (JSON.parse(m.data) as PlatypusEvent).type)).toEqual(["two", "three"]);
  });

  it("caps open streams and frees a slot when a client disconnects", async () => {
    const { db, bus } = setup();
    emit(db, { type: "one", actor: "system" }, { bus });
    const app = createEventsApp({ db, bus, heartbeatMs: 20, maxStreams: 2 });
    const a = await app.request("/events/stream");
    const b = await app.request("/events/stream");
    expect([a.status, b.status]).toEqual([200, 200]);
    const refused = await app.request("/events/stream");
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("10");
    await readSse(a, 1); // reads one frame, then cancels: the server sees the abort
    await new Promise((r) => setTimeout(r, 60));
    const again = await app.request("/events/stream");
    expect(again.status).toBe(200);
    await again.body!.cancel();
    await b.body!.cancel();
  });

  it("never lets ?limit run unbounded or break the query", async () => {
    const { db, bus } = setup();
    for (let i = 0; i < 5; i++) emit(db, { type: "t", actor: "system", payload: { i } }, { bus });
    const app = createEventsApp({ db, bus });
    const page = async (limit: string) => ((await (await app.request(`/events?limit=${limit}`)).json()) as { events: PlatypusEvent[] }).events.length;
    expect(await page("-1")).toBe(1); // SQLite reads LIMIT -1 as "everything"
    expect(await page("abc")).toBe(5);
    expect(await page("2.7")).toBe(2);
    expect(await page("1e12")).toBe(5);
    expect(clampLimit(-1)).toBe(1);
    expect(clampLimit(Number.NaN)).toBe(1000);
    expect(clampLimit(1e12)).toBe(MAX_EVENTS_PAGE);
  });

  it("serves the log as JSON and JSONL", async () => {
    const { db, bus } = setup();
    emit(db, { type: "one", actor: "system" }, { bus });
    const app = createEventsApp({ db, bus });
    const json = (await (await app.request("/events")).json()) as { events: PlatypusEvent[] };
    expect(json.events.map((e) => e.type)).toEqual(["one"]);
    expect(parseJsonl(await (await app.request("/events.jsonl")).text())).toHaveLength(1);
  });
});
