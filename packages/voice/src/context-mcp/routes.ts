import { hostHeaderValidationResponse } from "@modelcontextprotocol/server";
import type { VoiceTools } from "@platypus/shared/contracts";
import { Hono } from "hono";
import { MIN_SECRET_BYTES, MIN_TOKEN_BYTES, safeEqual, secretProblem } from "./secret";
import { createContextMcpHandler, type ToolCallLog } from "./server";

export interface ContextMcpRoutesOptions {
  tools: VoiceTools;
  /** CONTEXT_MCP_SECRET: the unguessable path segment. Served at /mcp/<secret>. */
  secret: string;
  /** CONTEXT_MCP_TOKEN: the bearer Dial sends on every request (authMode static). */
  token: string;
  /** Host header allowlist (DNS-rebinding guard). Omit to skip; see contextMcpAllowedHosts. */
  allowedHosts?: string[];
  onToolCall?: (log: ToolCallLog) => void;
  /** Zone for times read aloud. Defaults to America/Los_Angeles. */
  timeZone?: string;
}

/** localhost plus the public tunnel's hostname. */
export function contextMcpAllowedHosts(publicBaseUrl: string | undefined): string[] {
  const hosts = ["localhost", "127.0.0.1"];
  if (publicBaseUrl) hosts.push(new URL(publicBaseUrl).hostname);
  return hosts;
}

/** The URL to register with Dial. Contains the secret: never log it, log maskContextMcpUrl instead. */
export function contextMcpUrl(publicBaseUrl: string, secret: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/mcp/${secret}`;
}

/**
 * Hono routes for the Context MCP at /mcp/<secret>. Mount with app.route("/", routes).
 *
 * A request must carry both secrets: the path, and `Authorization: Bearer <token>`
 * on every request, including tools/list. A wrong or missing token gets a plain
 * 403 with no WWW-Authenticate header, because a 401 challenge would make Dial
 * switch the connection to OAuth. A wrong path falls through to the app's 404.
 * After that, each tool call is still authorized on the live call (see createVoiceTools).
 */
export function createContextMcpRoutes(opts: ContextMcpRoutesOptions): Hono {
  const secretIssue = secretProblem(opts.secret, MIN_SECRET_BYTES);
  if (secretIssue) throw new Error(`Context MCP path secret ${secretIssue}`);
  const tokenIssue = secretProblem(opts.token, MIN_TOKEN_BYTES);
  if (tokenIssue) throw new Error(`Context MCP bearer token ${tokenIssue}`);

  const handle = createContextMcpHandler({
    tools: opts.tools,
    ...(opts.onToolCall ? { onToolCall: opts.onToolCall } : {}),
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
  });
  const app = new Hono();
  app.all("/mcp/:secret", async (c, next) => {
    if (!safeEqual(c.req.param("secret"), opts.secret)) {
      await next();
      return;
    }
    const rejected = opts.allowedHosts ? hostHeaderValidationResponse(c.req.raw, opts.allowedHosts) : undefined;
    if (rejected) return rejected;
    const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1]?.trim() ?? "";
    if (!safeEqual(bearer, opts.token)) return c.text("Forbidden", 403);
    return handle(c.req.raw);
  });
  return app;
}
