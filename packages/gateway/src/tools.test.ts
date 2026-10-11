import { beforeEach, describe, expect, it } from "vitest";
import { BookingError, transition } from "@platypus/shared/booking";
import type { OwnerChannels } from "@platypus/shared/contracts";
import { createDarwin, type Darwin } from "@platypus/shared/darwin";
import { getBusinessBySlug, getRow, openDb, seed, selectRows, updateRow, type Business, type Db } from "@platypus/shared/db";
import { EventBus, listEvents } from "@platypus/shared/events";
import { ScriptedDarwin } from "@platypus/shared/testing";
import { createGatewayTools, GatewayError, RATE_LIMIT, type GatewayDeps } from "./tools";

// Sunday 7pm in San Francisco; the window is Monday noon to 5pm Pacific.
const NOW = "2026-10-12T02:00:00.000Z";
const WINDOW = { start: "2026-10-12T19:00:00.000Z", end: "2026-10-13T00:00:00.000Z" };
const agent = { agent_id: "claude-desktop" };

type TextReply = Awaited<ReturnType<OwnerChannels["sendBookingRequest"]>>;

function stubOwner(textReply: TextReply = { message_id: "msg_stub" }, fail = false) {
  const calls: Array<{ via: "call" | "text"; booking_id: string; business_id: string }> = [];
  const owner: OwnerChannels = {
    startOnboardingCall: async (ref) => {
      calls.push({ via: "call", ...ref });
      if (fail) throw new Error("Dial is down");
      return { call_id: "call_stub" };
    },
    sendBookingRequest: async (ref) => {
      calls.push({ via: "text", ...ref });
      return textReply;
    },
  };
  return { owner, calls };
}

let db: Db;
let now: number;
let sal: Business;
const clock = { now: () => new Date(now) };

beforeEach(() => {
  db = openDb(":memory:");
  now = Date.parse(NOW);
  seed(db, { clock });
  sal = getBusinessBySlug(db, "sals-auto")!;
});

function gateway(overrides: Partial<GatewayDeps> = {}) {
  const stub = stubOwner();
  const darwin: Darwin | null = overrides.darwin === undefined ? new ScriptedDarwin() : overrides.darwin;
  const tools = createGatewayTools({ db, bus: new EventBus(), owner: stub.owner, clock, ...overrides, darwin });
  return { tools, calls: stub.calls };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  provider_id: sal.id,
  service: "oil change",
  window: WINDOW,
  requested_by: "Alex's assistant",
  notes: "2019 Honda Civic",
  idempotency_key: "key-0000001",
  ...overrides,
});

const types = () => listEvents(db).map((e) => e.type).filter((t) => t !== "business.listed");

describe("search_providers", () => {
  it("returns Sal's Auto with signals and Darwin's answer, logging the search in order", async () => {
    const { tools } = gateway({ darwin: createDarwin({ DEMO_MODE: "fakes" }) });
    const out = await tools.search_providers({ service: "oil change", location: "1025 Sansome St, San Francisco", budget_cents: 12000, window: WINDOW }, agent);

    expect(out.providers.map((p) => p.display_name)).toEqual(["Sal's Auto"]);
    expect(out.providers[0]).toMatchObject({ next_step: "call", channel_state: "phone_only", signals: { source: "local" } });
    expect(out.darwin.status).toBe("completed");
    expect(types()).toEqual(["agent.tool_called", "darwin.searched", "signals.computed"]);
    const [called, searched, signals] = listEvents(db).filter((e) => e.type !== "business.listed");
    expect(called!.payload).toMatchObject({ tool: "search_providers", agent_id: "claude-desktop", service: "oil change", budget_cents: 12000 });
    expect(searched!.payload).toMatchObject({ status: "completed", outcome: "listed_only", provenance: "live" });
    expect(signals!.payload).toEqual({ source: "local", signals: {}, note: "no history yet" });
  });

  it("reports Darwin as disabled, never simulated, when it is switched off", async () => {
    const { tools } = gateway({ darwin: null });
    const out = await tools.search_providers({ service: "haircut", location: "San Francisco" }, agent);
    expect(out.providers.map((p) => p.display_name)).toEqual(["Mira Hair Studio"]);
    expect(out.darwin).toMatchObject({ status: "disabled", agents: [] });
    expect(types()).not.toContain("darwin.searched");
  });

  it("leaves out businesses Platypus must not contact", async () => {
    updateRow(db, "businesses", sal.id, { channel_state: "paused" });
    const { tools } = gateway({ darwin: null });
    expect((await tools.search_providers({ service: "oil change", location: "San Francisco" }, agent)).providers).toEqual([]);
  });
});

describe("request_booking", () => {
  it("calls a phone-only business once and returns pending", async () => {
    const { tools, calls } = gateway();
    const out = await tools.request_booking(request(), agent);

    expect(out).toMatchObject({ status: "pending", route: "call", reasons: ["Darwin returned no ready agent", "no text consent on record"] });
    expect(calls).toEqual([{ via: "call", booking_id: out.booking_id, business_id: sal.id }]);
    const pending = listEvents(db, { type: "booking.pending" })[0]!;
    expect(pending.payload).toMatchObject({ route: "call", agent_id: "claude-desktop", routing_reasons: out.reasons });
    expect(getRow(db, "bookings", out.booking_id)).toMatchObject({ status: "pending", details: "2019 Honda Civic", requested_by: "Alex's assistant" });
  });

  it("returns the same booking for the same idempotency key and contacts the owner once", async () => {
    const { tools, calls } = gateway();
    const [a, b] = await Promise.all([tools.request_booking(request(), agent), tools.request_booking(request(), agent)]);
    const c = await tools.request_booking(request(), agent);

    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(selectRows(db, "bookings")).toHaveLength(1);
    expect(calls).toHaveLength(1);
    await expect(tools.request_booking(request({ service: "tire rotation" }), agent)).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("texts an owner who opted in, holding the requested start first", async () => {
    updateRow(db, "businesses", sal.id, { channel_state: "text_enabled" });
    const { tools, calls } = gateway();
    const out = await tools.request_booking(request({ service: "brake inspection" }), agent);

    expect(out.route).toBe("text");
    expect(calls.map((c) => c.via)).toEqual(["text"]);
    const hold = listEvents(db, { type: "hold.placed" })[0]!;
    expect(hold).toMatchObject({ actor: "system", refs: { booking_id: out.booking_id } });
    expect(hold.payload).toMatchObject({ slot_start: WINDOW.start, slot_end: "2026-10-12T19:30:00.000Z" });
    expect(types().indexOf("hold.placed")).toBeGreaterThan(types().indexOf("booking.pending"));
  });

  it("falls back to a call when the text side says it needs one, releasing the hold", async () => {
    updateRow(db, "businesses", sal.id, { channel_state: "text_enabled" });
    const stub = stubOwner({ needs_call: true, reason: "no iMessage on that number" });
    const tools = createGatewayTools({ db, bus: new EventBus(), owner: stub.owner, darwin: null, clock });
    const out = await tools.request_booking(request(), agent);

    expect(out.route).toBe("call");
    expect(stub.calls.map((c) => c.via)).toEqual(["text", "call"]);
    expect(selectRows(db, "holds").map((h) => h.status)).toEqual(["released"]);
    expect(getRow(db, "bookings", out.booking_id)?.route).toBe("call");
  });

  it("still routes with Darwin disabled", async () => {
    const { tools, calls } = gateway({ darwin: null });
    const out = await tools.request_booking(request(), agent);
    expect(out.route).toBe("call");
    expect(out.reasons[0]).toBe("Darwin not consulted (DARWIN_ENABLED=false)");
    expect(calls).toHaveLength(1);
  });

  it("never contacts a do-not-call phone-only business and creates no booking", async () => {
    updateRow(db, "businesses", sal.id, { do_not_call: true });
    const { tools, calls } = gateway();
    await expect(tools.request_booking(request(), agent)).rejects.toMatchObject({ code: "no_route" });
    expect(calls).toEqual([]);
    expect(selectRows(db, "bookings")).toEqual([]);
  });

  it("keeps the booking pending with a reason when the owner channel fails", async () => {
    const stub = stubOwner(undefined, true);
    const tools = createGatewayTools({ db, bus: new EventBus(), owner: stub.owner, darwin: null, clock });
    const out = await tools.request_booking(request(), agent);
    expect(out.status).toBe("pending");
    expect(out.reasons.at(-1)).toBe("could not reach the owner yet: Dial is down");
    expect(listEvents(db, { type: "booking.dispatch_failed" })).toHaveLength(1);
  });
});

describe("booking tools", () => {
  it("never lets an agent confirm a booking", async () => {
    const { tools } = gateway({ darwin: null });
    const { booking_id } = await tools.request_booking(request(), agent);
    const slot = { start: "2026-10-12T21:00:00.000Z", end: "2026-10-12T21:45:00.000Z" };

    await expect(tools.confirm_booking({ booking_id, slot, idempotency_key: "confirm-01" }, agent)).rejects.toBeInstanceOf(GatewayError);
    transition({ db, clock }, booking_id, "countered", { actor: "owner", reason: "owner proposed 2pm", patch: { slot_start: slot.start, slot_end: slot.end } });
    await expect(tools.confirm_booking({ booking_id, slot, idempotency_key: "confirm-02" }, agent)).rejects.toMatchObject({ code: "owner_confirmation_required" });
    expect((await tools.get_booking({ booking_id }, agent)).status).toBe("countered");
  });

  it("lets the requesting agent read and cancel its booking, and hides it from others", async () => {
    const { tools } = gateway({ darwin: null });
    const { booking_id } = await tools.request_booking(request(), agent);

    expect(await tools.get_booking({ booking_id }, agent)).toMatchObject({ status: "pending", provider_name: "Sal's Auto", window: WINDOW, confirmed_by: null });
    expect(listEvents(db, { type: "agent.tool_called", bookingId: booking_id })[0]!.payload).toMatchObject({ tool: "get_booking", status: "pending" });
    await expect(tools.get_booking({ booking_id }, { agent_id: "someone-else" })).rejects.toMatchObject({ code: "not_found" });

    const cancelled = await tools.cancel_booking({ booking_id, reason: "plans changed, see https://evil.example", idempotency_key: "cancel-01" }, agent);
    expect(cancelled.status).toBe("cancelled");
    expect(listEvents(db, { type: "booking.cancelled" })[0]!.payload.note).toBe("plans changed, see [link removed]");
    await expect(tools.report_outcome({ booking_id, outcome: "completed" }, agent)).rejects.toBeInstanceOf(BookingError);
  });

  it("lists open slots inside business hours that nobody holds", async () => {
    const { tools } = gateway({ darwin: null });
    const before = await tools.get_availability({ provider_id: sal.id, window: WINDOW }, agent);
    expect(before.source).toBe("template");
    expect(before.slots[0]).toEqual({ start: "2026-10-12T19:00:00.000Z", end: "2026-10-12T19:45:00.000Z" });
    // 17:00 Pacific is past close for a 45-minute oil change.
    expect(before.slots.map((s) => s.start)).not.toContain("2026-10-13T00:00:00.000Z");

    updateRow(db, "businesses", sal.id, { channel_state: "text_enabled" });
    await tools.request_booking(request(), agent);
    const after = await tools.get_availability({ provider_id: sal.id, window: WINDOW }, agent);
    expect(after.slots.map((s) => s.start)).not.toContain("2026-10-12T19:00:00.000Z");
  });

  it("rate limits each agent", async () => {
    const { tools } = gateway({ darwin: null });
    for (let i = 0; i < RATE_LIMIT.calls; i++) await tools.get_provider({ provider_id: sal.id }, agent);
    await expect(tools.get_provider({ provider_id: sal.id }, agent)).rejects.toMatchObject({ code: "rate_limited" });
    await expect(tools.get_provider({ provider_id: sal.id }, { agent_id: "another-agent" })).resolves.toMatchObject({ display_name: "Sal's Auto" });
    now += RATE_LIMIT.windowMs;
    await expect(tools.get_provider({ provider_id: sal.id }, agent)).resolves.toMatchObject({ next_step: "call" });
  });
});
