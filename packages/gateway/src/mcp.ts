import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GATEWAY_TOOLS, GATEWAY_TOOL_NAMES, type GatewayContext, type GatewayTools } from "@platypus/shared/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

export const DEFAULT_AGENT_ID = "claude-desktop";
/** Optional header naming the calling agent, e.g. `mcp-remote <url> --header "x-platypus-agent: muse"`. */
export const AGENT_HEADER = "x-platypus-agent";

const AGENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_ERROR_CHARS = 300;
export const MAX_BODY_BYTES = 256 * 1024;
/** Across all agents; each agent's per-tool limit in tools.ts sits on top of this. */
export const GLOBAL_REQUESTS_PER_MINUTE = 120;
/** The shortest GATEWAY_TOKEN accepted when /mcp is public through PUBLIC_BASE_URL. */
export const MIN_TOKEN_CHARS = 16;

/** The agent id lands in logs and on the dashboard (never in owner copy), so anything odd falls back to the default. */
export const agentIdFrom = (raw: string | undefined): string => {
  const id = raw?.trim();
  return id && AGENT_ID.test(id) ? id : DEFAULT_AGENT_ID;
};

type AnyTool = (input: unknown, ctx: GatewayContext) => Promise<unknown>;

const toolError = (name: string, error: unknown): CallToolResult => {
  console.error(`[gateway] ${name} failed`, error);
  const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, MAX_ERROR_CHARS);
  return { content: [{ type: "text", text: `${name} failed: ${message || "unknown error"}` }], isError: true };
};

/**
 * Every tool in GATEWAY_TOOLS over MCP. The SDK validates arguments with the contract's zod
 * schema and turns validation failures into tool errors; results go back as JSON text plus
 * structuredContent. Without `ctxFor`, the agent id is the MCP client's name (stdio) or the default.
 */
export function createMcpServer(tools: GatewayTools, ctxFor?: () => GatewayContext): McpServer {
  const server = new McpServer({ name: "platypus", version: "0.1.0" });
  const context = ctxFor ?? (() => ({ agent_id: agentIdFrom(server.server.getClientVersion()?.name) }));

  for (const name of GATEWAY_TOOL_NAMES) {
    const spec = GATEWAY_TOOLS[name];
    const run = tools[name] as AnyTool;
    server.registerTool(name, { description: spec.description, inputSchema: spec.input }, async (input: unknown): Promise<CallToolResult> => {
      try {
        const output = (await run(input, context())) as Record<string, unknown>;
        return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        return toolError(name, error);
      }
    });
  }
  return server;
}

/** MCP spec: reject browser origins that are not local, so a web page cannot DNS-rebind into /mcp. */
const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (!origin) return true;
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
};

const tokenMatches = (header: string | undefined, expected: string): boolean => {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
};

/**
 * GATEWAY_TOKEN, an empty one counting as unset. With PUBLIC_BASE_URL set, /mcp is reachable
 * through the tunnel, so a missing or short token throws instead of serving /mcp open.
 */
export function gatewayToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.GATEWAY_TOKEN?.trim() || undefined;
  if (env.PUBLIC_BASE_URL?.trim() && (!token || token.length < MIN_TOKEN_CHARS)) {
    throw new Error(`PUBLIC_BASE_URL is set, so /mcp is public: set GATEWAY_TOKEN to a random string of at least ${MIN_TOKEN_CHARS} characters`);
  }
  return token;
}

/** Refills `perMinute` tokens a minute; each call takes one, or returns false when none is left. */
function tokenBucket(perMinute: number, now: () => number): () => boolean {
  let tokens = perMinute;
  let last = now();
  return () => {
    const t = now();
    tokens = Math.min(perMinute, tokens + ((t - last) * perMinute) / 60_000);
    last = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/**
 * Streamable HTTP at POST /mcp, stateless: a fresh server and transport per request, so no
 * session map to manage. GET (standalone SSE) and DELETE (session end) get 405, which clients
 * treat as "not supported".
 */
export function createMcpApp(
  tools: GatewayTools,
  options: { token?: string; requestsPerMinute?: number; now?: () => number } = {},
): Hono {
  const app = new Hono();
  // Through a public tunnel /mcp is reachable from anywhere; GATEWAY_TOKEN makes callers prove they are ours.
  const expected = (options.token ?? process.env.GATEWAY_TOKEN)?.trim() || undefined;
  // ponytail: one bucket shared by every caller, so one noisy agent can starve the rest; key it by agent if that bites.
  const take = tokenBucket(options.requestsPerMinute ?? GLOBAL_REQUESTS_PER_MINUTE, options.now ?? Date.now);

  app.use("/mcp", async (c, next) => {
    if (!isAllowedOrigin(c.req.header("origin"))) return c.text("Forbidden origin", 403);
    if (expected && !tokenMatches(c.req.header("authorization"), expected)) return c.text("Unauthorized", 401);
    if (!take()) return c.text("Too many requests", 429);
    await next();
  });
  app.use("/mcp", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.text("Request body too large", 413) }));

  app.post("/mcp", async (c) => {
    const ctx: GatewayContext = { agent_id: agentIdFrom(c.req.header(AGENT_HEADER)) };
    const server = createMcpServer(tools, () => ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  app.on(["GET", "DELETE"], "/mcp", (c) =>
    c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, 405),
  );

  return app;
}
