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

function stubTools(requests: unknown[], agents: GatewayContext[]): GatewayTools {
  const notImplemented = async (): Promise<never> => {
    throw new Error("not implemented in the stub");
  };
  const stub = Object.fromEntries(GATEWAY_TOOL_NAMES.map((name) => [name, notImplemented])) as unknown as GatewayTools;
  let polls = 0;
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
    get_booking: async () =>
      ++polls < 2
        ? BOOKING
        : { ...BOOKING, status: "confirmed", slot: { start: SLOT_START, end: SLOT_START }, price_cents: 8900, confirmed_by: "call" },
  };
}

const fetchInto = (tools: GatewayTools) => {
  const app = createMcpApp(tools, { token: "s3cret" });
  return async (url: string | URL, init?: RequestInit) => app.fetch(new Request(url, init));
};

describe("demo CLI", () => {
  it("drives search, request and polling to a Booked line over MCP", async () => {
    const requests: unknown[] = [];
    const agents: GatewayContext[] = [];
    const lines: string[] = [];

    const code = await run(["oil"], { fetch: fetchInto(stubTools(requests, agents)), token: "s3cret", print: (l) => lines.push(l), pollMs: 0 });

    expect(code).toBe(0);
    expect(lines).toContain("Darwin: no_match, no agent covers this shop");
    expect(lines.filter((l) => l.startsWith("Status:")).map((l) => l.split(" ")[1])).toEqual(["pending", "confirmed"]);
    expect(lines.at(-1)).toBe("Booked: Sal's Auto, Tue 2:00pm, $89, code SAL-4K2");
    expect(requests).toEqual([
      expect.objectContaining({ provider_id: "prov_sal", service: "oil change", requested_by: "Alex's assistant", notes: "2019 Civic" }),
    ]);
    expect(agents).toEqual([{ agent_id: "demo-cli" }]);
  });

  it("prints one line and exits 1 when a call fails", async () => {
    const lines: string[] = [];
    const code = await run(["oil"], { fetch: fetchInto(stubTools([], [])), token: "wrong", print: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
  });
});
