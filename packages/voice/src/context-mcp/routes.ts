import { hostHeaderValidationResponse } from "@modelcontextprotocol/server";
import type { VoiceTools } from "@platypus/shared/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MIN_SECRET_BYTES, MIN_TOKEN_BYTES, safeEqual, secretProblem } from "./secret";
import { createContextMcpHandler, type ToolCallLog } from "./server";

/** A JSON-RPC tool call is well under a kilobyte; nothing Dial sends comes close to this. */
export const MAX_CONTEXT_MCP_BODY_BYTES = 64 * 1024;
/** One call makes a handful of tool calls; this is room for several calls at once, not for a loop. */
export const CONTEXT_MCP_REQUESTS_PER_MINUTE = 120;

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
  /** Authenticated requests per minute across the endpoint; the next one gets 429. */
  requestsPerMinute?: number;
  now?: () => number;
}

/** Sliding one-minute window: at most `limit` calls in any 60 seconds. */
function minuteWindow(limit: number, now: () => number): () => boolean {
  const times: number[] = [];
  return () => {
    const t = now();
    while (times.length && t - times[0]! >= 60_000) times.shift();
    if (times.length >= limit) return false;
    times.push(t);
    return true;
  };
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
  const take = minuteWindow(opts.requestsPerMinute ?? CONTEXT_MCP_REQUESTS_PER_MINUTE, opts.now ?? Date.now);
  const limitBody = bodyLimit({ maxSize: MAX_CONTEXT_MCP_BODY_BYTES, onError: (c) => c.text("Payload Too Large", 413) });
  app.all("/mcp/:secret", async (c, next) => {
    if (!safeEqual(c.req.param("secret"), opts.secret)) {
      await next();
      return;
    }
    const rejected = opts.allowedHosts ? hostHeaderValidationResponse(c.req.raw, opts.allowedHosts) : undefined;
    if (rejected) return rejected;
    const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1]?.trim() ?? "";
    if (!safeEqual(bearer, opts.token)) return c.text("Forbidden", 403);
    if (!take()) return c.text("Too Many Requests", 429, { "retry-after": "5" });
    // bodyLimit answers 413 itself, or swaps in a size-capped body before the handler reads it.
    let response: Response | undefined;
    const refused = await limitBody(c, async () => {
      response = await handle(c.req.raw);
    });
    return response ?? refused ?? c.res;
  });
  return app;
}
