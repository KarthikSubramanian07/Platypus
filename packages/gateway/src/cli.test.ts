import { GATEWAY_TOOL_NAMES, type BookingView, type GatewayContext, type GatewayTools } from "@platypus/shared/contracts";
import { describe, expect, it } from "vitest";
import { run } from "./cli";
import { createMcpApp } from "./mcp";

const SLOT_START = new Date(2026, 9, 13, 14, 0).toISOString(); // Tue Oct 13, 2:00pm local

const BOOKING: BookingView = {
  booking_id: "bk_1",
  provider_id: "prov_sal",
  provider_name: "Sal's Auto",
  service: "oil change",
  status: "pending",
  route: "call",
  short_code: "SAL-4K2",
  window: null,
  slot: null,
  price_cents: null,
  confirmed_by: null,
  updated_at: "2026-10-11T12:00:00Z",
};

function stubTools(requests: unknown[], agents: GatewayContext[], waits: unknown[] = [], answer = true): GatewayTools {
  const notImplemented = async (): Promise<never> => {
    throw new Error("not implemented in the stub");
  };
  const stub = Object.fromEntries(GATEWAY_TOOL_NAMES.map((name) => [name, notImplemented])) as unknown as GatewayTools;
  return {
    ...stub,
    search_providers: async () => ({
      providers: [
        {
          provider_id: "prov_sal",
          display_name: "Sal's Auto",
          trade: "auto",
          address: "1200 Sansome St",
          channel_state: "phone_only",
          services: [{ name: "oil change", typical_price_cents: [7900, 9900] }],
          signals: { typical_price_cents: 8900, median_reply_seconds: 240, acceptance_rate: 0.9, source: "local" },
          next_step: "call",
        },
      ],
      darwin: { status: "no_match", no_match_reason: "no agent covers this shop", agents: [], cached: false },
    }),
    request_booking: async (input, ctx) => {
      requests.push(input);
      agents.push(ctx);
      return { booking_id: "bk_1", status: "pending", route: "call", short_code: "SAL-4K2", reasons: ["phone-only business"] };
    },
    wait_for_booking: async (input) => {
      waits.push(input);
      return answer
        ? { ...BOOKING, status: "confirmed", slot: { start: SLOT_START, end: SLOT_START }, price_cents: 8900, confirmed_by: "call", changed: true, waited_seconds: 40 }
        : { ...BOOKING, changed: false, waited_seconds: 55 };
    },
  };
}

const fetchInto = (tools: GatewayTools) => {
  const app = createMcpApp(tools, { token: "s3cret" });
  return async (url: string | URL, init?: RequestInit) => app.fetch(new Request(url, init));
};

describe("demo CLI", () => {
  it("drives search, request and wait_for_booking to a Booked line over MCP", async () => {
    const requests: unknown[] = [];
    const agents: GatewayContext[] = [];
    const waits: unknown[] = [];
    const lines: string[] = [];

    const code = await run(["oil"], { fetch: fetchInto(stubTools(requests, agents, waits)), token: "s3cret", print: (l) => lines.push(l) });

    expect(code).toBe(0);
    expect(waits).toEqual([{ booking_id: "bk_1", since_status: "pending" }]);
    expect(lines).toContain("Darwin: no_match, no agent covers this shop");
    expect(lines.filter((l) => l.startsWith("Status:")).map((l) => l.split(" ")[1])).toEqual(["pending", "confirmed"]);
    expect(lines.at(-1)).toBe("Booked: Sal's Auto, Tue 2:00pm, $89, code SAL-4K2");
    expect(requests).toEqual([
      expect.objectContaining({ provider_id: "prov_sal", service: "oil change", requested_by: "Alex's assistant", notes: "2019 Civic" }),
    ]);
    expect(agents).toEqual([{ agent_id: "demo-cli" }]);
  });

  it("warms Darwin with the stage search, prints its answer and latency, and books nothing", async () => {
    const requests: unknown[] = [];
    const searches: unknown[] = [];
    const answer = (status: "completed" | "error") => ({ ...stubTools(requests, []), search_providers: async (input: unknown) => {
      searches.push(input);
      return { providers: [], darwin: { status, agents: [], cached: false, latency_ms: 3500 } };
    } }) as GatewayTools;
    const lines: string[] = [];

    const code = await run(["warm"], { fetch: fetchInto(answer("completed")), token: "s3cret", print: (l) => lines.push(l) });

    expect(code).toBe(0);
    expect(lines[0]).toBe("Darwin: completed (3500ms)");
    expect(lines[1]).toMatch(/^Round trip: \d+\.\ds$/);
    expect(searches).toEqual([expect.objectContaining({ service: "oil change", location: "1025 Sansome St, San Francisco", budget_cents: 12000 })]);
    expect(requests).toEqual([]);
    expect(await run(["warm"], { fetch: fetchInto(answer("error")), token: "s3cret", print: () => {} })).toBe(1);
  });

  it("gives up with a Still line once its own timeout passes", async () => {
    const lines: string[] = [];
    const code = await run(["oil"], { fetch: fetchInto(stubTools([], [], [], false)), token: "s3cret", print: (l) => lines.push(l), timeoutMs: 0 });
    expect(code).toBe(1);
    expect(lines.slice(-2)).toEqual(["Status: pending (0s)", "Still pending after 0s, code SAL-4K2"]);
  });

  it("prints one line and exits 1 when a call fails", async () => {
    const lines: string[] = [];
    const code = await run(["oil"], { fetch: fetchInto(stubTools([], [])), token: "wrong", print: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
  });
});
