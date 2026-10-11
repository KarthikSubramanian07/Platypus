import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The Context MCP is reachable from the public internet (Dial calls it through
 * PUBLIC_BASE_URL), so it is guarded twice:
 *
 * - CONTEXT_MCP_SECRET: an unguessable path segment, /mcp/<secret>. At least 24 random bytes.
 * - CONTEXT_MCP_TOKEN: a static bearer token that Dial sends on every request
 *   (authMode "static"). At least 32 random bytes.
 *
 * Both are base64url. Neither is ever printed in full; use maskSecret.
 */
export const MIN_SECRET_BYTES = 24;
export const MIN_TOKEN_BYTES = 32;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** 32 random base64url characters use about 24 distinct symbols; fewer than 12 means it was not random. */
const MIN_DISTINCT_CHARS = 12;

/** A fresh path secret: 32 random bytes, base64url (43 characters). */
export function generateContextMcpSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** A fresh bearer token: 48 random bytes, base64url (64 characters). */
export function generateContextMcpToken(): string {
  return randomBytes(48).toString("base64url");
}

/** Returns why a value is not a strong base64url secret, or undefined if it is. */
export function secretProblem(value: string | undefined, minBytes: number): string | undefined {
  if (!value) return "is missing";
  if (!BASE64URL.test(value)) return "must be base64url (A-Z, a-z, 0-9, - and _)";
  const bytes = Buffer.from(value, "base64url").length;
  if (bytes < minBytes) return `must carry at least ${minBytes} random bytes (got ${bytes})`;
  // Long enough but hand-typed ("aaaa…", "abcabc…"): random base64url of this length uses far more symbols.
  if (new Set(value).size < MIN_DISTINCT_CHARS) return "looks hand-made, not random; generate it";
  return undefined;
}

/** "AbCd…(43 chars)": enough to tell two values apart in a log, useless to an attacker. */
export function maskSecret(value: string | undefined): string {
  if (!value) return "(unset)";
  return `${value.slice(0, 4)}…(${value.length} chars)`;
}

/** Constant-time string comparison; hashing first hides the length too. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface ContextMcpCredentials {
  secret: string;
  token: string;
  /** True when generated for this process because the env had none (fakes mode only). */
  ephemeral: boolean;
}

/**
 * Reads CONTEXT_MCP_SECRET and CONTEXT_MCP_TOKEN. In live mode (DEMO_MODE=live)
 * a missing or weak value is fatal: the server refuses to start rather than
 * expose booking tools behind a guessable URL. In fakes mode a missing value is
 * replaced by a random one for this process; a present but weak value is still an error.
 */
export function resolveContextMcpCredentials(env: NodeJS.ProcessEnv = process.env): ContextMcpCredentials {
  const live = (env.DEMO_MODE ?? "fakes") === "live";
  let ephemeral = false;
  const pick = (name: string, minBytes: number, generate: () => string): string => {
    const value = env[name]?.trim() || undefined;
    const problem = secretProblem(value, minBytes);
    if (!problem) return value!;
    if (!value && !live) {
      ephemeral = true;
      return generate();
    }
    throw new Error(`${name} ${problem}. Generate one with: node -e "console.log(require('crypto').randomBytes(${minBytes + 8}).toString('base64url'))"`);
  };
  const secret = pick("CONTEXT_MCP_SECRET", MIN_SECRET_BYTES, generateContextMcpSecret);
  const token = pick("CONTEXT_MCP_TOKEN", MIN_TOKEN_BYTES, generateContextMcpToken);
  return { secret, token, ephemeral };
}
