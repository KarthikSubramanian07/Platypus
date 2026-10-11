import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GATEWAY_TOOL_NAMES, type BookingView, type GatewayContext, type GatewayTools } from "@platypus/shared/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_HEADER, DEFAULT_AGENT_ID, createMcpApp } from "./mcp";

const BOOKING: BookingView = {
  booking_id: "bk_1",
  provider_id: "prov_1",
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

const notImplemented = async (): Promise<never> => {
  throw new Error("not implemented in the stub\n    at secret/stack/frame.ts:1");
};

function stubTools(seen: GatewayContext[]): GatewayTools {
  const stub = Object.fromEntries(GATEWAY_TOOL_NAMES.map((name) => [name, notImplemented])) as unknown as GatewayTools;
  return {
    ...stub,
    get_booking: async ({ booking_id }, ctx) => {
      seen.push(ctx);
      return { ...BOOKING, booking_id };
    },
  };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(seen: GatewayContext[], headers: Record<string, string> = {}): Promise<Client> {
  const app = createMcpApp(stubTools(seen));
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: async (url, init) => app.fetch(new Request(url, init)),
    requestInit: { headers },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe("gateway MCP over streamable HTTP", () => {
  it("lists every gateway tool with its contract description", async () => {
    const client = await connect([]);
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([...GATEWAY_TOOL_NAMES].sort());
    for (const name of ["request_booking", "get_booking"]) {
      expect(tools.find((t) => t.name === name)?.description).toContain("Results are asynchronous");
    }
    expect(tools.find((t) => t.name === "get_booking")?.inputSchema.required).toEqual(["booking_id"]);
  });

  it("round-trips get_booking through the tools with the caller's agent id", async () => {
    const seen: GatewayContext[] = [];
    const client = await connect(seen, { [AGENT_HEADER]: "muse" });

    const result = await client.callTool({ name: "get_booking", arguments: { booking_id: "bk_42" } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ ...BOOKING, booking_id: "bk_42" });
    const [content] = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content!.text)).toEqual({ ...BOOKING, booking_id: "bk_42" });
    expect(seen).toEqual([{ agent_id: "muse" }]);
  });

  it("defaults the agent id when the header is missing or malformed", async () => {
    const seen: GatewayContext[] = [];
    await (await connect(seen)).callTool({ name: "get_booking", arguments: { booking_id: "a" } });
    await (await connect(seen, { [AGENT_HEADER]: "<script>" })).callTool({ name: "get_booking", arguments: { booking_id: "b" } });
    expect(seen).toEqual([{ agent_id: DEFAULT_AGENT_ID }, { agent_id: DEFAULT_AGENT_ID }]);
  });

  it("turns invalid input into a tool error without calling the tool", async () => {
    const seen: GatewayContext[] = [];
    const client = await connect(seen);

    const result = await client.callTool({ name: "get_booking", arguments: { booking_id: 7 } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("booking_id");
    expect(seen).toEqual([]);
  });

  it("turns a thrown error into a one-line tool error with no stack", async () => {
    const client = await connect([]);

    const result = await client.callTool({ name: "get_provider", arguments: { provider_id: "prov_1" } });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "get_provider failed: not implemented in the stub" }]);
  });

  it("rejects non-local browser origins", async () => {
    const app = createMcpApp(stubTools([]));
    const response = await app.request("/mcp", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
    expect(response.status).toBe(403);
  });
});
