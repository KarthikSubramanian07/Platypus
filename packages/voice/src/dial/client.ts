import { assertAllowedNumber } from "@platypus/shared/safety";
import { unwrapCall, unwrapCalls, WireCall } from "./wire";

export const DIAL_BASE_URL = "https://api.getdial.ai/api/v1";

/** What we send to POST /calls. `fromNumberId` falls back to the client's configured number. */
export interface PlaceCallInput {
  to: string;
  outboundInstruction: string;
  fromNumberId?: string;
  language?: string;
  maxCallDurationSeconds?: number;
  voiceGender?: "male" | "female";
}

export interface PlaceCallOptions {
  /** Required: Dial replays the original call for a repeated key instead of dialing twice. */
  idempotencyKey: string;
  /** Which booking and business the call is for. The real client ignores it; FakeDial uses it to play the script. */
  link?: { business_id?: string; booking_id?: string };
}

export interface StopCallResult {
  cancelPending: boolean | null;
  call: WireCall | null;
}

/** The slice of Dial's Calls API the phone side uses. FakeDial is adapted to the same interface. */
export interface DialCalls {
  placeCall(input: PlaceCallInput, options: PlaceCallOptions): Promise<WireCall>;
  listCalls(query?: { contact?: string; since?: string }): Promise<WireCall[]>;
  getCall(id: string): Promise<WireCall>;
  stopCall(id: string): Promise<StopCallResult>;
  /** Present on the FakeDial adapter only: Dial events delivered in-process instead of by webhook. */
  on?(listener: (envelope: unknown) => void): () => void;
}

export interface DialCallsOptions {
  apiKey: string;
  fromNumberId: string;
  /** Non-negotiable 6: every POST /calls is checked against this list first. */
  allowedNumbers: readonly string[];
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Per request. A POST that times out is an ambiguous outcome, never a retry. Default 20s. */
  timeoutMs?: number;
}

// ---- Errors -------------------------------------------------------------------

/** Dial answered with a non-2xx status. For POST /calls this guarantees no call was placed. */
export class DialApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "DialApiError";
  }
}
/** 402: the account is out of credit. */
export class DialInsufficientCreditError extends DialApiError {
  override name = "DialInsufficientCreditError";
}
/** 403: Dial will not call this region. */
export class DialUnsupportedRegionError extends DialApiError {
  override name = "DialUnsupportedRegionError";
}
/** 409: calling_disabled, or the idempotency key was reused with a different body. */
export class DialConflictError extends DialApiError {
  override name = "DialConflictError";
}
/** 429: concurrent-call or rate limit. `retryAfterSeconds` from the Retry-After header when present. */
export class DialRateLimitError extends DialApiError {
  override name = "DialRateLimitError";
  constructor(status: number, code: string | null, message: string, readonly retryAfterSeconds: number | null) {
    super(status, code, message);
  }
}
/**
 * The request never got a definite answer (network error, timeout, unparseable 2xx).
 * For POST /calls a call MAY exist: confirm with listCalls before doing anything else.
 */
export class DialNetworkError extends Error {
  override name = "DialNetworkError";
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

function errorFor(status: number, body: unknown, retryAfter: string | null): DialApiError {
  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const nested = (obj.error && typeof obj.error === "object" ? obj.error : obj) as Record<string, unknown>;
  const code = typeof nested.code === "string" ? nested.code : typeof obj.error === "string" ? obj.error : null;
  const message = `Dial ${status}${code ? ` ${code}` : ""}: ${typeof nested.message === "string" ? nested.message : "request failed"}`;
  switch (status) {
    case 402:
      return new DialInsufficientCreditError(status, code, message);
    case 403:
      return new DialUnsupportedRegionError(status, code, message);
    case 409:
      return new DialConflictError(status, code, message);
    case 429: {
      const seconds = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
      return new DialRateLimitError(status, code, message, seconds);
    }
    default:
      return new DialApiError(status, code, message);
  }
}

// ---- Client -------------------------------------------------------------------

/**
 * Dial's Calls API over fetch. Deliberately has no retry logic: a repeated
 * POST /calls is how a business gets two calls, so the caller decides what to do
 * after an error, and after an ambiguous one it lists calls first (non-negotiable 4).
 */
export function createDialCalls(options: DialCallsOptions): DialCalls {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = (options.baseUrl ?? DIAL_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 20_000;

  async function request(method: "GET" | "POST", path: string, init: { body?: unknown; headers?: Record<string, string> } = {}): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json", ...init.headers };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DialNetworkError(`Dial ${method} ${path} got no answer: ${(error as Error).message}`, error);
    }
    const text = await response.text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        if (response.ok) throw new DialNetworkError(`Dial ${method} ${path} returned unreadable JSON`);
      }
    }
    if (!response.ok) throw errorFor(response.status, body, response.headers.get("retry-after"));
    return body;
  }

  return {
    async placeCall(input, { idempotencyKey }) {
      assertAllowedNumber(input.to, options.allowedNumbers);
      if (!idempotencyKey || idempotencyKey.length > 255) throw new Error("placeCall needs an Idempotency-Key of 1..255 characters");
      const body = {
        to: input.to,
        fromNumberId: input.fromNumberId ?? options.fromNumberId,
        outboundInstruction: input.outboundInstruction,
        language: input.language ?? "en-US",
        ...(input.maxCallDurationSeconds !== undefined ? { maxCallDurationSeconds: input.maxCallDurationSeconds } : {}),
        ...(input.voiceGender ? { voiceGender: input.voiceGender } : {}),
      };
      const raw = await request("POST", "/calls", { body, headers: { "Idempotency-Key": idempotencyKey } });
      try {
        return unwrapCall(raw);
      } catch (error) {
        // 2xx means a call exists, but we cannot read it: treat as ambiguous so the caller lists calls.
        throw new DialNetworkError("Dial accepted the call but the response did not parse", error);
      }
    },

    async listCalls(query = {}) {
      const params = new URLSearchParams();
      if (query.contact) params.set("contact", query.contact);
      if (query.since) params.set("since", query.since);
      const qs = params.toString();
      return unwrapCalls(await request("GET", `/calls${qs ? `?${qs}` : ""}`));
    },

    async getCall(id) {
      return unwrapCall(await request("GET", `/calls/${encodeURIComponent(id)}`));
    },

    async stopCall(id) {
      const raw = (await request("POST", `/calls/${encodeURIComponent(id)}/stop`)) as Record<string, unknown> | null;
      const parsed = raw && "call" in raw ? WireCall.safeParse(raw.call) : null;
      return { cancelPending: typeof raw?.cancelPending === "boolean" ? raw.cancelPending : null, call: parsed?.success ? parsed.data : null };
    },
  };
}
