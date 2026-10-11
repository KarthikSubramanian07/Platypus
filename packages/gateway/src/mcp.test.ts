import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GATEWAY_TOOL_NAMES, type BookingView, type GatewayContext, type GatewayTools } from "@platypus/shared/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_HEADER, DEFAULT_AGENT_ID, MAX_BODY_BYTES, MIN_TOKEN_CHARS, agentIdFrom, createMcpApp, gatewayToken } from "./mcp";

const BOOKING: BookingView = {
  booking_id: "bk_1",
  provider_id: "prov_1",
  provider_name: "Eddy's Auto",
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
      expect(tools.find((t) => t.name === name)?.description).toContain("Call wait_for_booking");
    }
    const wait = tools.find((t) => t.name === "wait_for_booking")!;
    expect(wait.description).toContain("keep calling it until the status is final");
    expect(wait.inputSchema.required).toEqual(["booking_id"]);
    expect(wait.inputSchema.properties?.timeout_seconds).toMatchObject({ minimum: 5, maximum: 120 });
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

  it("accepts only letters, digits, dot, underscore and dash in the agent id, up to 64 characters", () => {
    expect(agentIdFrom("demo-cli_1.2")).toBe("demo-cli_1.2");
    expect(agentIdFrom("a".repeat(64))).toBe("a".repeat(64));
    for (const bad of ["Sal said yes", "me@example.com", "a".repeat(65), "naïve", ""]) expect(agentIdFrom(bad)).toBe(DEFAULT_AGENT_ID);
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

const LIST_TOOLS = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const JSON_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("GATEWAY_TOKEN", () => {
  it("rejects a request without the bearer token and accepts one with it", async () => {
    const app = createMcpApp({} as never, { token: "s3cret" });
    const denied = await app.request("/mcp", { method: "POST", headers: JSON_HEADERS, body: LIST_TOOLS });
    expect(denied.status).toBe(401);
    const allowed = await app.request("/mcp", { method: "POST", headers: { ...JSON_HEADERS, authorization: "Bearer s3cret" }, body: LIST_TOOLS });
    expect(allowed.status).not.toBe(401);
  });

  it("refuses to serve a public /mcp without a token of at least 16 characters", () => {
    const strong = "x".repeat(MIN_TOKEN_CHARS);
    expect(gatewayToken({})).toBeUndefined();
    expect(gatewayToken({ GATEWAY_TOKEN: "" })).toBeUndefined();
    expect(gatewayToken({ PUBLIC_BASE_URL: "https://x.example", GATEWAY_TOKEN: strong })).toBe(strong);
    for (const token of [undefined, "", "short"]) {
      expect(() => gatewayToken({ PUBLIC_BASE_URL: "https://x.example", GATEWAY_TOKEN: token })).toThrow(/GATEWAY_TOKEN/);
    }
  });
});

describe("request limits", () => {
  it("refuses a body over 256 KB before the MCP server parses it", async () => {
    const app = createMcpApp(stubTools([]), { token: "" });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(MAX_BODY_BYTES) } });
    const response = await app.request("/mcp", { method: "POST", headers: JSON_HEADERS, body });
    expect(response.status).toBe(413);
  });

  it("answers 429 once every agent together goes over the global budget, and refills over time", async () => {
    let now = 0;
    const app = createMcpApp(stubTools([]), { token: "", requestsPerMinute: 2, now: () => now });
    const post = () => app.request("/mcp", { method: "POST", headers: JSON_HEADERS, body: LIST_TOOLS });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
    now += 30_000;
    expect((await post()).status).toBe(200);
  });
});
