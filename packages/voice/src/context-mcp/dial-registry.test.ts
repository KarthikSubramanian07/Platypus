import { describe, expect, it, vi } from "vitest";
import { DIAL_API_BASE, runRegisterCli, runStatusCli, type DialContextMcp } from "./dial-registry";
import { generateContextMcpSecret, generateContextMcpToken } from "./secret";

const SECRET = generateContextMcpSecret();
const TOKEN = generateContextMcpToken();
const API_KEY = "sk_live_test_0123456789abcdef";
const BASE = "https://platypus-demo.trycloudflare.com";
const env = { DIAL_API_KEY: API_KEY, PUBLIC_BASE_URL: BASE, CONTEXT_MCP_SECRET: SECRET, CONTEXT_MCP_TOKEN: TOKEN };

const entry = (over: Partial<DialContextMcp> = {}): DialContextMcp => ({
  id: "cmcp_new",
  name: "platypus",
  url: `${BASE}/mcp/${SECRET}`,
  authMode: "static",
  status: "connected",
  toolCount: 5,
  timeoutMs: 10_000,
  headersMasked: { Authorization: "Bear••••" },
  lastError: null,
  createdAt: "2026-10-11T19:00:00.000Z",
  ...over,
});

function harness(routes: Record<string, (init?: RequestInit) => Response>) {
  const lines: string[] = [];
  const calls: { method: string; url: string; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, ...(init ? { init } : {}) });
    const route = routes[`${method} ${url.replace(DIAL_API_BASE, "")}`];
    if (!route) throw new Error(`unexpected ${method} ${url}`);
    return route(init);
  });
  return { io: { env, fetch, out: (l: string) => lines.push(l) }, lines, calls, printed: () => lines.join("\n") };
}

const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status });

describe("dial:register-mcp", () => {
  it("replaces every earlier 'platypus' connection, then creates one with the static bearer", async () => {
    const h = harness({
      "GET /context-mcps": () => json(200, { contextMcps: [entry({ id: "cmcp_old", url: `${BASE}/mcp/old` }), entry({ id: "cmcp_other", name: "someone-else" })] }),
      "DELETE /context-mcps/cmcp_old": () => json(204, null),
      "POST /context-mcps": () => json(201, { contextMcp: entry(), authorizationUrl: null }),
    });
    expect(await runRegisterCli([], h.io)).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.url.replace(DIAL_API_BASE, "")}`)).toEqual(["GET /context-mcps", "DELETE /context-mcps/cmcp_old", "POST /context-mcps"]);
    const post = h.calls[2]!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ name: "platypus", url: `${BASE}/mcp/${SECRET}`, headers: { Authorization: `Bearer ${TOKEN}` }, timeoutMs: 10_000 });
    expect((post.init!.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);
    expect(h.printed()).toMatch(/status\s+connected/);
    expect(h.printed()).toMatch(/toolCount\s+5/);
    expect(h.printed()).toMatch(/lastError\s+none/);
  });

  it("never prints the path secret, the token or the API key", async () => {
    const h = harness({
      "GET /context-mcps": () => json(200, { contextMcps: [] }),
      "POST /context-mcps": () => json(201, { contextMcp: entry({ status: "error", lastError: `GET ${BASE}/mcp/${SECRET} timed out` }) }),
    });
    expect(await runRegisterCli([], h.io)).toBe(1);
    for (const secret of [SECRET, TOKEN, API_KEY]) expect(h.printed()).not.toContain(secret);
    expect(h.printed()).toContain(`${SECRET.slice(0, 4)}…(${SECRET.length} chars)`);
    expect(h.printed()).toMatch(/Problem: status is error/);
  });

  it("prints a dry run without touching the network", async () => {
    const h = harness({});
    expect(await runRegisterCli(["--dry-run"], h.io)).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(h.printed()).toContain(`POST   ${DIAL_API_BASE}/context-mcps`);
    expect(h.printed()).toContain('"timeoutMs": 10000');
    for (const secret of [SECRET, TOKEN, API_KEY]) expect(h.printed()).not.toContain(secret);
  });

  it("explains a missing API key instead of calling Dial", async () => {
    const h = harness({});
    expect(await runRegisterCli([], { ...h.io, env: { ...env, DIAL_API_KEY: "" } })).toBe(2);
    expect(h.printed()).toMatch(/DIAL_API_KEY is not set/);
    expect(h.calls).toHaveLength(0);
  });

  it("lists every configuration problem at once", async () => {
    const h = harness({});
    expect(await runRegisterCli(["--dry-run"], { ...h.io, env: { PUBLIC_BASE_URL: "http://example.com", CONTEXT_MCP_SECRET: "short" } })).toBe(2);
    expect(h.printed()).toMatch(/must be https/);
    expect(h.printed()).toMatch(/CONTEXT_MCP_SECRET must carry at least 24 random bytes/);
    expect(h.printed()).toMatch(/CONTEXT_MCP_TOKEN is missing/);
  });

  it("explains Dial's 400 probe failure", async () => {
    const h = harness({
      "GET /context-mcps": () => json(200, { contextMcps: [] }),
      "POST /context-mcps": () => json(400, { error: `Could not reach ${BASE}/mcp/${SECRET}: 502` }),
    });
    expect(await runRegisterCli([], h.io)).toBe(1);
    expect(h.printed()).toMatch(/is pnpm dev running and the tunnel up/);
    expect(h.printed()).not.toContain(SECRET);
  });
});

describe("dial:mcp-status", () => {
  it("prints status, authMode, toolCount and lastError, masked", async () => {
    const h = harness({ "GET /context-mcps": () => json(200, { contextMcps: [entry()] }) });
    expect(await runStatusCli([], h.io)).toBe(0);
    expect(h.printed()).toMatch(/authMode\s+static/);
    expect(h.printed()).not.toContain(SECRET);
  });

  it("fails when nothing is registered or the server came up as oauth", async () => {
    const none = harness({ "GET /context-mcps": () => json(200, { contextMcps: [] }) });
    expect(await runStatusCli([], none.io)).toBe(1);
    const oauth = harness({ "GET /context-mcps": () => json(200, { contextMcps: [entry({ authMode: "oauth", status: "pending_auth", toolCount: 0 })] }) });
    expect(await runStatusCli([], oauth.io)).toBe(1);
    expect(oauth.printed()).toMatch(/expected static/);
  });
});
