import { NumberNotAllowedError } from "@platypus/shared/safety";
import { describe, expect, it, vi } from "vitest";
import {
  createDialCalls,
  DialConflictError,
  DialInsufficientCreditError,
  DialNetworkError,
  DialRateLimitError,
  DialUnsupportedRegionError,
} from "./client";

const OWNER = "+14155550101";
const call = (over: Record<string, unknown> = {}) => ({
  id: "call_abc",
  from: "+14155550199",
  to: OWNER,
  direction: "outbound",
  status: { state: "Queued", terminationType: null, label: "Queued" },
  duration: null,
  transcript: null,
  transcriptTurns: null,
  createdAt: "2026-10-11T19:00:00.000Z",
  ...over,
});

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers }));
}

const client = (fetch: ReturnType<typeof mockFetch>, allowed = [OWNER]) =>
  createDialCalls({ apiKey: "sk_test_key", fromNumberId: "num_123", allowedNumbers: allowed, fetch: fetch as unknown as typeof globalThis.fetch });

describe("createDialCalls", () => {
  it("POSTs /calls with the exact URL, headers and body, and unwraps {call}", async () => {
    const fetch = mockFetch(201, { call: call() });
    const placed = await client(fetch).placeCall(
      { to: OWNER, outboundInstruction: "Say the disclosure.", maxCallDurationSeconds: 110 },
      { idempotencyKey: "onboard-bkg_1" },
    );
    expect(placed.id).toBe("call_abc");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.getdial.ai/api/v1/calls");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_test_key");
    expect(headers["Idempotency-Key"]).toBe("onboard-bkg_1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({
      to: OWNER,
      fromNumberId: "num_123",
      outboundInstruction: "Say the disclosure.",
      language: "en-US",
      maxCallDurationSeconds: 110,
    });
  });

  it("refuses a number outside ALLOWED_NUMBERS before any request", async () => {
    const fetch = mockFetch(201, { call: call() });
    await expect(
      client(fetch).placeCall({ to: "+14155550999", outboundInstruction: "x" }, { idempotencyKey: "onboard-bkg_1" }),
    ).rejects.toBeInstanceOf(NumberNotAllowedError);
    await expect(client(fetch, []).placeCall({ to: OWNER, outboundInstruction: "x" }, { idempotencyKey: "k" })).rejects.toBeInstanceOf(NumberNotAllowedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [402, DialInsufficientCreditError, "insufficient_credit"],
    [403, DialUnsupportedRegionError, "unsupported_region"],
    [409, DialConflictError, "calling_disabled"],
    [429, DialRateLimitError, "call_limit_reached"],
  ])("maps %i to a typed error and never retries", async (status, ErrorClass, code) => {
    const fetch = mockFetch(status, { error: { code, message: "nope" } }, { "retry-after": "30" });
    const error = await client(fetch)
      .placeCall({ to: OWNER, outboundInstruction: "x" }, { idempotencyKey: "onboard-bkg_1" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorClass);
    expect((error as DialConflictError).code).toBe(code);
    if (error instanceof DialRateLimitError) expect(error.retryAfterSeconds).toBe(30);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a network failure on POST as ambiguous, without retrying", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      client(fetch as never).placeCall({ to: OWNER, outboundInstruction: "x" }, { idempotencyKey: "onboard-bkg_1" }),
    ).rejects.toBeInstanceOf(DialNetworkError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("lists calls by contact and since, and unwraps {calls}", async () => {
    const fetch = mockFetch(200, { calls: [call({ status: { state: "Some-New-State", terminationType: null } })] });
    const calls = await client(fetch).listCalls({ contact: OWNER, since: "2026-10-11T18:00:00.000Z" });
    expect(calls[0]?.status.state).toBe("Some-New-State");
    expect(fetch.mock.calls[0]![0]).toBe("https://api.getdial.ai/api/v1/calls?contact=%2B14155550101&since=2026-10-11T18%3A00%3A00.000Z");
    expect((fetch.mock.calls[0]![1]?.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_key");
  });

  it("gets one call with its transcript turns", async () => {
    const turns = [{ speaker: "agent", text: "Hi", startMs: 0, endMs: 900 }];
    const fetch = mockFetch(200, { call: call({ transcriptTurns: turns, transcript: "Agent: Hi" }) });
    const got = await client(fetch).getCall("call_abc");
    expect(got.transcriptTurns).toEqual(turns);
    expect(fetch.mock.calls[0]![0]).toBe("https://api.getdial.ai/api/v1/calls/call_abc");
  });

  it("stops a call", async () => {
    const fetch = mockFetch(200, { call: call({ status: { state: "Terminated", terminationType: "canceled" } }), cancelPending: true });
    const stopped = await client(fetch).stopCall("call_abc");
    expect(stopped.cancelPending).toBe(true);
    expect(fetch.mock.calls[0]![0]).toBe("https://api.getdial.ai/api/v1/calls/call_abc/stop");
    expect(fetch.mock.calls[0]![1]?.method).toBe("POST");
  });
});
