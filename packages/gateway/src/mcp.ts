import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GATEWAY_TOOLS, GATEWAY_TOOL_NAMES, type GatewayContext, type GatewayTools } from "@platypus/shared/contracts";
import { Hono } from "hono";

export const DEFAULT_AGENT_ID = "claude-desktop";
/** Optional header naming the calling agent, e.g. `mcp-remote <url> --header "x-platypus-agent: muse"`. */
export const AGENT_HEADER = "x-platypus-agent";

const AGENT_ID = /^[\w .@-]{1,64}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_ERROR_CHARS = 300;

/** The agent id ends up in owner messages, so anything odd falls back to the default. */
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
 * Streamable HTTP at POST /mcp, stateless: a fresh server and transport per request, so no
 * session map to manage. GET (standalone SSE) and DELETE (session end) get 405, which clients
 * treat as "not supported".
 */
export function createMcpApp(tools: GatewayTools, options: { token?: string } = {}): Hono {
  const app = new Hono();
  // Through a public tunnel /mcp is reachable from anywhere; GATEWAY_TOKEN makes callers prove they are ours.
  const expected = options.token ?? process.env.GATEWAY_TOKEN;

  app.use("/mcp", async (c, next) => {
    if (!isAllowedOrigin(c.req.header("origin"))) return c.text("Forbidden origin", 403);
    if (expected && !tokenMatches(c.req.header("authorization"), expected)) return c.text("Unauthorized", 401);
    await next();
  });

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
