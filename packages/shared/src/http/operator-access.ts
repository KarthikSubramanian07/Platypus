import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";

/**
 * Operator routes: the event log (/events, /events/stream, /events.jsonl), the audit
 * (/audit) and the stage controls (/demo/*). They show transcripts, owner replies and
 * consent quotes, and /demo/owner-reply can text a "Y" that confirms a booking, so
 * they are for the team, never for whoever finds the tunnel URL.
 *
 * A request gets in when either:
 *  - it presents DASHBOARD_TOKEN, as `Authorization: Bearer <token>` or `?token=<token>`
 *    (EventSource and no-cors POSTs cannot set headers); or
 *  - it comes from this machine: a loopback Host, a loopback peer, no Cloudflare tunnel
 *    headers, and, from a browser, a loopback or trusted Origin. The Origin check stops
 *    any web page the presenter has open from POSTing to http://localhost:8787/demo/*.
 *
 * Everything else gets 401 (no token) or 403 (wrong token). /health, /webhooks/dial and
 * the two MCP endpoints carry their own authentication and are not covered here.
 */

export const OPERATOR_PATHS = ["/events", "/events/*", "/events.jsonl", "/audit", "/demo/*"] as const;

/** The deployed dashboard may drive a server on the presenter's own machine without a token. */
export const DEFAULT_TRUSTED_ORIGINS = ["https://tryplatypus.pages.dev"];

/** The shortest DASHBOARD_TOKEN accepted: it travels in URLs, so it must be long and random. */
export const MIN_DASHBOARD_TOKEN_CHARS = 24;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** Headers cloudflared and Cloudflare's edge add to every tunnelled request. */
const TUNNEL_HEADERS = ["cf-connecting-ip", "cf-ray", "cf-ipcountry", "cdn-loop"];

export interface OperatorAccessOptions {
  /** DASHBOARD_TOKEN. Without it, only requests from this machine get in. */
  token?: string | undefined;
  /** Browser origins allowed on loopback without a token, besides loopback origins themselves. */
  trustedOrigins?: readonly string[];
  /** The TCP peer address, when the server exposes it (Node: c.env.incoming.socket.remoteAddress). */
  peerAddress?: (c: Context) => string | undefined;
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isLoopbackAddress(address: string): boolean {
  const a = address.toLowerCase();
  return a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127.");
}

/** The peer address from @hono/node-server, or undefined anywhere else (tests, other runtimes). */
export function nodePeerAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

function presentedToken(c: Context): string | undefined {
  const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1]?.trim();
  return bearer || c.req.query("token") || undefined;
}

/** True when the request was made on this machine, not through the tunnel or the LAN. */
export function isLocalRequest(c: Context, options: Pick<OperatorAccessOptions, "trustedOrigins" | "peerAddress"> = {}): boolean {
  const host = hostnameOf(c.req.header("host") ?? new URL(c.req.url).host);
  if (!host || !LOOPBACK_HOSTS.has(host)) return false;
  if (TUNNEL_HEADERS.some((h) => c.req.header(h) !== undefined)) return false;
  const peer = (options.peerAddress ?? nodePeerAddress)(c);
  if (peer && !isLoopbackAddress(peer)) return false;
  const origin = c.req.header("origin");
  if (origin === undefined) return true;
  const originHost = hostnameOf(origin);
  if (originHost && LOOPBACK_HOSTS.has(originHost)) return true;
  return (options.trustedOrigins ?? DEFAULT_TRUSTED_ORIGINS).includes(origin);
}

export function operatorAccess(options: OperatorAccessOptions = {}): MiddlewareHandler {
  const token = options.token?.trim() || undefined;
  return async (c, next) => {
    // A CORS preflight carries no credentials and changes nothing; the real request is checked.
    if (c.req.method === "OPTIONS") return next();
    const presented = presentedToken(c);
    if (token && presented && sameSecret(presented, token)) return next();
    if (isLocalRequest(c, options)) return next();
    return presented
      ? c.json({ error: "forbidden" }, 403)
      : c.json({ error: "operator routes need DASHBOARD_TOKEN (?token= or Authorization: Bearer)" }, 401);
  };
}

/**
 * Reads DASHBOARD_TOKEN and DASHBOARD_ORIGINS. A token that is set but short is a
 * configuration error, refused at startup rather than guessed later.
 */
export function operatorAccessFromEnv(env: NodeJS.ProcessEnv = process.env): OperatorAccessOptions {
  const token = env.DASHBOARD_TOKEN?.trim() || undefined;
  if (token && token.length < MIN_DASHBOARD_TOKEN_CHARS) {
    throw new Error(`DASHBOARD_TOKEN must be a random string of at least ${MIN_DASHBOARD_TOKEN_CHARS} characters`);
  }
  const extra = (env.DASHBOARD_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return { token, trustedOrigins: [...DEFAULT_TRUSTED_ORIGINS, ...extra] };
}

/** Installs the guard on every operator path. Call before mounting the routes it protects. */
export function guardOperatorRoutes(app: Hono, options: OperatorAccessOptions = {}): void {
  const guard = operatorAccess(options);
  for (const path of OPERATOR_PATHS) app.use(path, guard);
}
