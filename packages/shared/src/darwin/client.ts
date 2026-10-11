import type { z } from "zod";
import {
  ActContinueRequest,
  ActResponse,
  ActStartRequest,
  SearchRequest,
  SearchResponse,
} from "./schema";

export const DARWIN_API_BASE_URL = "https://api.darwin.so/api";
export const DARWIN_MCP_URL = "https://mcp.darwin.so/mcp";

/**
 * What the gateway needs from Darwin. HttpDarwin talks to the real API, or to
 * the recorded fake (createFakeDarwinFetch) in DEMO_MODE=fakes; ScriptedDarwin
 * in @platypus/shared/testing scripts multi-step sequences for tests.
 */
export interface Darwin {
  search(request: SearchRequest): Promise<DarwinSearchResult>;
  /** True only when an Act pilot credential is configured. Search never needs one. */
  readonly canAct: boolean;
  act(request: ActStartRequest | ActContinueRequest, options: ActOptions): Promise<ActResponse>;
}

export interface DarwinSearchResult {
  search: SearchResponse;
  /** Darwin's correlation id, for support tickets and the event log. */
  requestId: string | null;
  latencyMs: number;
}

export interface ActOptions {
  /** Reuse the same key, with identical inputs, when retrying an uncertain write. */
  idempotencyKey: string;
  /** Required when the Search was anonymous. */
  searchToken?: string;
}

export type DarwinErrorKind =
  | "network" // DNS, TLS, reset, timeout
  | "rate_limited" // 429
  | "server" // 5xx
  | "unauthorized" // 401: missing or bad key; never silently downgraded to anonymous
  | "forbidden" // 403, including ACT_PREVIEW_ACCESS_REQUIRED
  | "invalid_request" // 400 or 404
  | "conflict" // 409
  | "invalid_response" // 2xx that does not match the published contract
  | "act_not_configured";

/**
 * 502, 503 and 504 are transient. A 500 is not retried as-is: Darwin's 500s mostly
 * repeat for the same phrasing, so the caller rephrases first (see ./lookup).
 */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export class DarwinError extends Error {
  constructor(
    public readonly kind: DarwinErrorKind,
    message: string,
    public readonly details: {
      status?: number;
      code?: string;
      requestId?: string | null;
      retryAfterMs?: number;
      operation?: "search" | "act";
    } = {},
  ) {
    super(message);
    this.name = "DarwinError";
  }

  get retryable(): boolean {
    if (this.kind === "network" || this.kind === "rate_limited") return true;
    return this.kind === "server" && TRANSIENT_STATUSES.has(this.details.status ?? 0);
  }
}

export interface HttpDarwinOptions {
  baseUrl?: string;
  /** Application Search key (directory:read). Optional: anonymous Search works without it. */
  apiKey?: string;
  /** Act pilot OAuth token (human:actions). Without it, act() refuses before any request. */
  actToken?: string;
  /** Per-attempt timeout. Search answers in 2 to 17 seconds in practice. */
  timeoutMs?: number;
  /** Extra attempts for network failures, 429, 502, 503 and 504. */
  maxRetries?: number;
  /** Ceiling for any single backoff, including a server-sent Retry-After. */
  maxBackoffMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HttpDarwin implements Darwin {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly actToken: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: HttpDarwinOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DARWIN_API_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey || undefined;
    this.actToken = options.actToken || undefined;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.maxRetries = options.maxRetries ?? 1;
    this.maxBackoffMs = options.maxBackoffMs ?? 5_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? realSleep;
    this.random = options.random ?? Math.random;
  }

  get canAct(): boolean {
    return this.actToken !== undefined;
  }

  async search(request: SearchRequest): Promise<DarwinSearchResult> {
    const body = SearchRequest.parse(request);
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const started = Date.now();
    const { json, requestId } = await this.send("search", "/v3/search", body, headers);
    return { search: parseOrThrow(SearchResponse, json, "search", requestId), requestId, latencyMs: Date.now() - started };
  }

  async act(request: ActStartRequest | ActContinueRequest, options: ActOptions): Promise<ActResponse> {
    if (!this.actToken) {
      throw new DarwinError("act_not_configured", "Darwin Act needs DARWIN_ACT_TOKEN (an allowlisted pilot OAuth token)", {
        operation: "act",
      });
    }
    const body = "threadId" in request ? ActContinueRequest.parse(request) : ActStartRequest.parse(request);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.actToken}`,
      "idempotency-key": options.idempotencyKey,
    };
    if (options.searchToken) headers["x-search-token"] = options.searchToken;
    const { json, requestId } = await this.send("act", "/v3/act", body, headers);
    return parseOrThrow(ActResponse, json, "act", requestId);
  }

  /**
   * One logical request with bounded retries. Act writes carry an Idempotency-Key,
   * so retrying an uncertain write with the identical body is safe by contract.
   */
  private async send(
    operation: "search" | "act",
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ json: unknown; requestId: string | null }> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.once(operation, path, body, headers);
      } catch (error) {
        const darwinError = error instanceof DarwinError ? error : toNetworkError(error, operation);
        if (!darwinError.retryable || attempt >= this.maxRetries) throw darwinError;
        const backoff = darwinError.details.retryAfterMs ?? 250 * 2 ** attempt * (1 + this.random());
        await this.sleep(Math.min(backoff, this.maxBackoffMs));
        attempt += 1;
      }
    }
  }

  private async once(
    operation: "search" | "act",
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ json: unknown; requestId: string | null }> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const requestId = response.headers.get("x-request-id");
    const text = await response.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON bodies are reported below by status, or as an invalid response.
    }
    if (response.ok) {
      if (json === undefined) throw new DarwinError("invalid_response", `Darwin ${operation} returned a non-JSON body`, { status: response.status, requestId, operation });
      return { json, requestId };
    }
    const payload = (json ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof payload.code === "string" ? payload.code : undefined;
    const message = `Darwin ${operation} failed with HTTP ${response.status}${code ? ` ${code}` : ""}${
      typeof payload.message === "string" ? `: ${payload.message.slice(0, 200)}` : ""
    }`;
    throw new DarwinError(kindForStatus(response.status), message, {
      status: response.status,
      code,
      requestId,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      operation,
    });
  }
}

function kindForStatus(status: number): DarwinErrorKind {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 409) return "conflict";
  return "invalid_request";
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function toNetworkError(error: unknown, operation: "search" | "act"): DarwinError {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new DarwinError("network", `Darwin ${operation} could not be reached (${reason})`, { operation });
}

function parseOrThrow<T>(schema: z.ZodType<T>, json: unknown, operation: "search" | "act", requestId: string | null): T {
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  throw new DarwinError(
    "invalid_response",
    `Darwin ${operation} response does not match the v3 contract at ${first?.path.join(".") || "(root)"}: ${first?.message ?? "unknown"}`,
    { requestId, operation },
  );
}
