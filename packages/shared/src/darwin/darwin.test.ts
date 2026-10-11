import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manualClock } from "../clock";
import { DarwinSummary } from "../contracts/darwin";
import { DARWIN_FIXTURES, darwinFailures, ScriptedDarwin, searchWith, startableAgent } from "../testing";
import {
  createDarwin,
  DarwinLookupCache,
  darwinEventPayload,
  DarwinError,
  HttpDarwin,
  isDarwinEnabled,
  lookupDarwin,
  warmDarwinLookups,
  type SearchResponse,
  parseRetryAfter,
  probeDarwinMcp,
  searchLadder,
  toDarwinSummary,
  tradeQuery,
} from "./index";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": `req-${status}`, ...headers },
  });
}

function http(responses: Array<Response | Error>, options: ConstructorParameters<typeof HttpDarwin>[0] = {}) {
  const queue = [...responses];
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const darwin = new HttpDarwin({ fetch: fetch as unknown as typeof globalThis.fetch, sleep, random: () => 0, ...options });
  return { darwin, fetch, sleep };
}

const sentHeaders = (init: RequestInit | undefined) => init?.headers as Record<string, string>;

describe("recorded Darwin responses", () => {
  it("match the v3 contract Platypus reads", () => {
    expect(DARWIN_FIXTURES.hairSalon.status).toBe("completed");
    expect(DARWIN_FIXTURES.hairSalon.response.agents.length).toBeGreaterThan(0);
    expect(DARWIN_FIXTURES.needsInput.status).toBe("needs_input");
    expect(DARWIN_FIXTURES.needsInput.response.question).toBeTruthy();
  });

  it("include main's recorded invoice match, which the client also parses", () => {
    expect(DARWIN_FIXTURES.invoiceMatch.response.agents.length).toBeGreaterThan(0);
  });

  it("never carry a live search token", () => {
    for (const fixture of [DARWIN_FIXTURES.hairSalon, DARWIN_FIXTURES.movingCompanyWithContext, DARWIN_FIXTURES.needsInput]) {
      expect(fixture.searchToken ?? "REDACTED_SEARCH_TOKEN").toBe("REDACTED_SEARCH_TOKEN");
    }
  });
});

describe("HttpDarwin.search", () => {
  it("posts the request to /v3/search anonymously when no key is set", async () => {
    const { darwin, fetch } = http([jsonResponse(200, DARWIN_FIXTURES.hairSalon)]);
    const result = await darwin.search({ query: "hair salon", maxResults: 5 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.darwin.so/api/v3/search");
    expect(JSON.parse(init!.body as string)).toEqual({ query: "hair salon", maxResults: 5 });
    expect(sentHeaders(init).authorization).toBeUndefined();
    expect(result.requestId).toBe("req-200");
    expect(result.search.searchId).toMatch(/^srch_/);
  });

  it("sends the application key as a bearer token", async () => {
    const { darwin, fetch } = http([jsonResponse(200, DARWIN_FIXTURES.hairSalon)], { apiKey: "dk_test" });
    await darwin.search({ query: "hair salon" });
    expect(sentHeaders(fetch.mock.calls[0]![1]).authorization).toBe("Bearer dk_test");
  });

  it("does not retry a 500, because Darwin's 500s mostly repeat for the same phrasing", async () => {
    const { darwin, fetch } = http([jsonResponse(500, { statusCode: 500, message: "Internal server error" })]);
    const error = await darwin.search({ query: "hair salon in San Francisco" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DarwinError);
    expect((error as DarwinError).kind).toBe("server");
    expect((error as DarwinError).retryable).toBe(false);
    expect((error as DarwinError).details.requestId).toBe("req-500");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 once with backoff, then succeeds", async () => {
    const { darwin, fetch, sleep } = http([jsonResponse(503, { message: "busy" }), jsonResponse(200, DARWIN_FIXTURES.hairSalon)]);
    await darwin.search({ query: "hair salon" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("honors Retry-After on 429, capped at maxBackoffMs", async () => {
    const { darwin, sleep } = http(
      [jsonResponse(429, { message: "slow down" }, { "retry-after": "60" }), jsonResponse(200, DARWIN_FIXTURES.hairSalon)],
      { maxBackoffMs: 2000 },
    );
    await darwin.search({ query: "hair salon" });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("stops after maxRetries", async () => {
    const { darwin, fetch } = http([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")], {
      maxRetries: 1,
    });
    await expect(darwin.search({ query: "x" })).rejects.toMatchObject({ kind: "network" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a rejected key as unauthorized instead of falling back to anonymous", async () => {
    const { darwin, fetch } = http([jsonResponse(401, { message: "Supply a Darwin API key" })], { apiKey: "bad" });
    await expect(darwin.search({ query: "x" })).rejects.toMatchObject({ kind: "unauthorized", details: { status: 401 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a 200 that breaks the contract", async () => {
    const { darwin } = http([jsonResponse(200, { searchId: "srch_x", response: {} })]);
    await expect(darwin.search({ query: "x" })).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("validates the request before it leaves Platypus", async () => {
    const { darwin, fetch } = http([]);
    await expect(darwin.search({ query: "x", maxResults: 50 })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("HttpDarwin.act", () => {
  it("refuses without a pilot token and makes no request", async () => {
    const { darwin, fetch } = http([]);
    expect(darwin.canAct).toBe(false);
    await expect(
      darwin.act({ searchId: DARWIN_FIXTURES.hairSalon.searchId, message: "hi" }, { idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ kind: "act_not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the token, idempotency key and search token", async () => {
    const ack = { type: "request", actRequestId: "act_1", status: "completed", threads: [{ agentId: "a1", threadId: "t1" }] };
    const { darwin, fetch } = http([jsonResponse(200, ack)], { actToken: "oauth_test" });
    const result = await darwin.act(
      { searchId: DARWIN_FIXTURES.hairSalon.searchId, agentIds: ["a1"], message: "Book a haircut" },
      { idempotencyKey: "bkg_1", searchToken: "tok" },
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.darwin.so/api/v3/act");
    expect(sentHeaders(init)).toMatchObject({ authorization: "Bearer oauth_test", "idempotency-key": "bkg_1", "x-search-token": "tok" });
    expect(result.actRequestId).toBe("act_1");
  });

  it("surfaces the pilot gate as forbidden", async () => {
    const { darwin } = http([jsonResponse(403, { code: "ACT_PREVIEW_ACCESS_REQUIRED", message: "pilot" })], { actToken: "t" });
    await expect(
      darwin.act({ threadId: "t1", message: { type: "text", text: "hi" } }, { idempotencyKey: "k" }),
    ).rejects.toMatchObject({ kind: "forbidden", details: { code: "ACT_PREVIEW_ACCESS_REQUIRED" } });
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("Sun, 11 Oct 2026 18:00:05 GMT", Date.parse("2026-10-11T18:00:00Z"))).toBe(5000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("searchLadder", () => {
  it("tries trade and service first, then the bare trade, and never sends a location", () => {
    expect(searchLadder({ trade: "salon", service: "Haircut" })).toEqual([
      { query: "hair salon: Haircut", maxResults: 5 },
      { query: "hair salon", maxResults: 5 },
    ]);
    expect(JSON.stringify(searchLadder({ trade: "salon", service: "Haircut", ...({ area: "San Francisco" } as object) }))).not.toContain("San Francisco");
  });

  it("sends budget and a UTC deadline as context, never an offset", () => {
    const [first] = searchLadder({ trade: "auto_repair", service: "oil change", budgetCents: 12000, deadline: "2026-10-12T17:00:00-07:00" });
    expect(first!.context).toEqual([
      { type: "budget", amountMinor: 12000, currency: "USD" },
      { type: "deadline", at: "2026-10-13T00:00:00.000Z" },
    ]);
    expect(searchLadder({ trade: "auto_repair", deadline: "not a date", budgetCents: -5 })).toEqual([{ query: "auto repair shop", maxResults: 5 }]);
  });

  it("has one rung when there is nothing to add", () => {
    expect(searchLadder({ trade: "dog_groomer" })).toEqual([{ query: "dog groomer", maxResults: 5 }]);
  });

  it("sanitizes the agent-supplied service before it reaches Darwin", () => {
    const [first] = searchLadder({ trade: "auto_repair", service: "oil change\n see https://evil.example now" });
    expect(first!.query).toBe("auto repair shop: oil change see [link removed] now");
  });

  it("phrases unknown trades from their slug", () => {
    expect(tradeQuery("piano_tuner")).toBe("piano tuner");
  });
});

describe("lookupDarwin", () => {
  const input = { trade: "salon", service: "Haircut" };

  it("falls back to the bare trade when the specific query returns 500", async () => {
    const darwin = new ScriptedDarwin({ script: [darwinFailures.server500("r-1")] });
    const lookup = await lookupDarwin(darwin, input);
    expect(lookup.outcome).toBe("listed_only");
    expect(lookup.candidate).toBeNull();
    expect(lookup.attempts.map((a) => [a.query, a.ok, a.status])).toEqual([
      ["hair salon: Haircut", false, 500],
      ["hair salon", true, 200],
    ]);
    expect(darwin.searches[1]).toEqual({ query: "hair salon", maxResults: 5 });
  });

  it("picks the first startable result in Darwin's order", async () => {
    const listed = DARWIN_FIXTURES.hairSalon.response.agents[0]!;
    const ready = startableAgent(DARWIN_FIXTURES.hairSalon.response.agents[1]);
    const lookup = await lookupDarwin(new ScriptedDarwin({ script: [searchWith([listed, ready])] }), input);
    expect(lookup.outcome).toBe("startable");
    expect(lookup.candidate?.agentId).toBe(ready.agentId);
  });

  it("does not treat canStartThread without readiness as startable", async () => {
    const odd = { ...startableAgent(), readiness: "recheck_required" as const };
    const lookup = await lookupDarwin(new ScriptedDarwin({ script: [searchWith([odd])] }), input);
    expect(lookup.outcome).toBe("listed_only");
  });

  it("reports needs_input and no_match", async () => {
    expect((await lookupDarwin(new ScriptedDarwin({ script: [DARWIN_FIXTURES.needsInput] }), { trade: "x" })).outcome).toBe(
      "listed_only",
    );
    const asking = searchWith([], DARWIN_FIXTURES.needsInput);
    expect((await lookupDarwin(new ScriptedDarwin({ script: [asking] }), { trade: "x" })).outcome).toBe("needs_input");
    const empty = { ...searchWith([]), status: "no_match" as const };
    expect((await lookupDarwin(new ScriptedDarwin({ script: [empty] }), { trade: "x" })).outcome).toBe("no_match");
  });

  it("gives the bare trade a second try, because its 500s are intermittent", async () => {
    const darwin = new ScriptedDarwin({ script: [darwinFailures.server500(), darwinFailures.server500()] });
    const lookup = await lookupDarwin(darwin, input);
    expect(lookup.outcome).toBe("listed_only");
    expect(darwin.searches.map((r) => r.query)).toEqual(["hair salon: Haircut", "hair salon", "hair salon"]);
  });

  it("returns unavailable instead of throwing when every rung fails", async () => {
    const darwin = new ScriptedDarwin({ script: [darwinFailures.server500(), darwinFailures.network(), darwinFailures.server500()] });
    const lookup = await lookupDarwin(darwin, input);
    expect(lookup.outcome).toBe("unavailable");
    expect(lookup.attempts).toHaveLength(3);
    expect(lookup.configError).toBeNull();
  });

  it("stops early and flags a rejected key", async () => {
    const darwin = new ScriptedDarwin({ script: [darwinFailures.unauthorized()] });
    const lookup = await lookupDarwin(darwin, input);
    expect(lookup).toMatchObject({ outcome: "unavailable", configError: "unauthorized" });
    expect(darwin.searches).toHaveLength(1);
  });

  it("rethrows bugs that are not Darwin failures", async () => {
    const darwin = new ScriptedDarwin({
      script: [
        () => {
          throw new RangeError("bug");
        },
      ],
    });
    await expect(lookupDarwin(darwin, input)).rejects.toThrow(RangeError);
  });
});

describe("DarwinLookupCache", () => {
  const input = { trade: "salon", service: "Haircut" };

  it("answers a repeated lookup without calling Darwin, until the TTL passes", async () => {
    const clock = manualClock();
    const cache = new DarwinLookupCache({ ttlMs: 60_000, clock, maxStaleMs: 0 });
    const darwin = new ScriptedDarwin();
    const first = await lookupDarwin(darwin, input, { cache });
    const second = await lookupDarwin(darwin, input, { cache });
    expect(second.search).toBe(first.search);
    expect(toDarwinSummary(first).cached).toBe(false);
    expect(toDarwinSummary(second).cached).toBe(true);
    expect(darwin.searches).toHaveLength(1);
    clock.advance(60_001);
    await lookupDarwin(darwin, input, { cache });
    expect(darwin.searches).toHaveLength(2);
  });

  it("shares the bare-trade answer across services, so warm-up covers every request", async () => {
    const cache = new DarwinLookupCache();
    const darwin = new ScriptedDarwin();
    expect(await warmDarwinLookups(darwin, cache, ["salon", "salon", "dog_groomer"])).toEqual([
      { trade: "salon", outcome: "listed_only", rounds: 1 },
      { trade: "dog_groomer", outcome: "listed_only", rounds: 1 },
    ]);
    const lookup = await lookupDarwin(darwin, { trade: "salon", service: "Color", budgetCents: 9000 }, { cache });
    expect(lookup).toMatchObject({ outcome: "listed_only", cached: true, attempts: [] });
    expect(darwin.searches.map((r) => r.query)).toEqual(["hair salon", "dog groomer"]);
  });

  it("skips a phrasing that just failed", async () => {
    const clock = manualClock();
    const cache = new DarwinLookupCache({ ttlMs: 0, clock, failureTtlMs: 60_000, maxStaleMs: 0 });
    const darwin = new ScriptedDarwin({ script: [darwinFailures.server500()] });
    await lookupDarwin(darwin, input, { cache });
    clock.advance(1);
    await lookupDarwin(darwin, input, { cache });
    expect(darwin.searches.map((r) => r.query)).toEqual(["hair salon: Haircut", "hair salon", "hair salon"]);
    clock.advance(60_001);
    await lookupDarwin(darwin, input, { cache });
    expect(darwin.searches.at(-1)?.query).toBe("hair salon: Haircut");
  });

  it("runs one ladder for concurrent identical lookups", async () => {
    const cache = new DarwinLookupCache();
    const darwin = new ScriptedDarwin();
    const [a, b] = await Promise.all([lookupDarwin(darwin, input, { cache }), lookupDarwin(darwin, input, { cache })]);
    expect(a).toBe(b);
    expect(darwin.searches).toHaveLength(1);
  });

  it("keeps warming a trade until Darwin answers", async () => {
    const darwin = new ScriptedDarwin({ script: [darwinFailures.server500(), darwinFailures.server500(), darwinFailures.server500()] });
    expect(await warmDarwinLookups(darwin, new DarwinLookupCache(), ["auto_repair"])).toEqual([
      { trade: "auto_repair", outcome: "listed_only", rounds: 2 },
    ]);
  });

  it("stands in the last good answer, labeled cached, when Darwin fails", async () => {
    const clock = manualClock();
    const cache = new DarwinLookupCache({ ttlMs: 1000, clock });
    const fails = [darwinFailures.server500(), darwinFailures.server500(), darwinFailures.server500()];
    const darwin = new ScriptedDarwin({ script: [DARWIN_FIXTURES.hairSalon, ...fails] });
    await lookupDarwin(darwin, { trade: "salon" }, { cache });
    clock.advance(5000);
    const lookup = await lookupDarwin(darwin, input, { cache });
    expect(lookup).toMatchObject({ outcome: "listed_only", cached: true });
    expect(lookup.attempts.map((a) => a.status)).toEqual([500, 500, 500]);
    expect(toDarwinSummary(lookup)).toMatchObject({ status: "completed", cached: true });
  });

  it("persists answers without the search token and reloads them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "darwin-cache-"));
    const file = join(dir, "nested", "lookups.json");
    const search = { ...DARWIN_FIXTURES.hairSalon, searchToken: "secret-token" };
    await lookupDarwin(new ScriptedDarwin({ script: [search] }), { trade: "salon" }, { cache: new DarwinLookupCache({ file }) });
    expect(readFileSync(file, "utf8")).not.toContain("secret-token");
    const reloaded = new DarwinLookupCache({ file });
    const darwin = new ScriptedDarwin();
    expect(await lookupDarwin(darwin, { trade: "salon", service: "cut" }, { cache: reloaded })).toMatchObject({ outcome: "listed_only", cached: true });
    expect(darwin.searches).toHaveLength(0);
    writeFileSync(file, "{not json");
    expect(() => new DarwinLookupCache({ file })).not.toThrow();
  });

  it("never caches an outage", async () => {
    const cache = new DarwinLookupCache();
    const darwin = new ScriptedDarwin({ script: [darwinFailures.server500(), darwinFailures.server500(), darwinFailures.server500()] });
    expect((await lookupDarwin(darwin, input, { cache })).outcome).toBe("unavailable");
    expect((await lookupDarwin(darwin, input, { cache })).outcome).toBe("listed_only");
  });
});

describe("lookup budget", () => {
  const slow = (ms: number) => () => new Promise<SearchResponse>((resolve) => setTimeout(() => resolve(DARWIN_FIXTURES.hairSalon), ms));

  it("answers a slow lookup from the last good answer when there is one", async () => {
    const clock = manualClock();
    const cache = new DarwinLookupCache({ ttlMs: 1000, clock });
    await lookupDarwin(new ScriptedDarwin(), { trade: "salon" }, { cache });
    clock.advance(5000);
    const lookup = await lookupDarwin(new ScriptedDarwin({ script: [slow(80)] }), { trade: "salon" }, { cache, budgetMs: 20 });
    expect(lookup).toMatchObject({ outcome: "listed_only", cached: true, timedOut: true });
  });

  it("answers within the budget and finishes in the background to fill the cache", async () => {
    const cache = new DarwinLookupCache();
    const darwin = new ScriptedDarwin({ script: [slow(80)] });
    const started = Date.now();
    const first = await lookupDarwin(darwin, { trade: "salon" }, { cache, budgetMs: 20 });
    expect(Date.now() - started).toBeLessThan(70);
    expect(first).toMatchObject({ outcome: "unavailable", timedOut: true });
    expect(toDarwinSummary(first).status).toBe("error");
    expect(darwinEventPayload(first)).toMatchObject({ timed_out: true });
    await new Promise((r) => setTimeout(r, 120));
    const second = await lookupDarwin(darwin, { trade: "salon" }, { cache, budgetMs: 20 });
    expect(second).toMatchObject({ outcome: "listed_only", cached: true });
    expect(darwin.searches).toHaveLength(1);
  });

  it("returns Darwin's answer when it beats the budget", async () => {
    const lookup = await lookupDarwin(new ScriptedDarwin({ script: [slow(5)] }), { trade: "salon" }, { budgetMs: 500 });
    expect(lookup.outcome).toBe("listed_only");
    expect(lookup.timedOut).toBeUndefined();
  });

  it("reports a bug thrown after the budget instead of crashing the process", async () => {
    const onBackgroundError = vi.fn();
    const darwin = new ScriptedDarwin({
      script: [() => new Promise<SearchResponse>((_, reject) => setTimeout(() => reject(new RangeError("bug")), 30))],
    });
    await lookupDarwin(darwin, { trade: "salon" }, { budgetMs: 5, onBackgroundError });
    await new Promise((r) => setTimeout(r, 60));
    expect(onBackgroundError).toHaveBeenCalledWith(expect.any(RangeError));
  });
});

describe("darwinEventPayload", () => {
  it("matches the golden path's darwin.searched shape and drops provider text and the search token", async () => {
    const search = { ...searchWith([startableAgent()]), searchToken: "secret-token" };
    const lookup = await lookupDarwin(new ScriptedDarwin({ script: [search] }), { trade: "salon" });
    const payload = darwinEventPayload(lookup);
    expect(payload).toMatchObject({
      status: "completed",
      http_status: 200,
      provenance: "live",
      query: "hair salon",
      search_id: search.searchId,
      outcome: "startable",
      candidate_agent_id: lookup.candidate!.agentId,
    });
    const text = JSON.stringify(payload);
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain(lookup.candidate!.connectionPrompt.slice(0, 40));
    expect(text).not.toContain(lookup.candidate!.description!.slice(0, 40));
  });

  it("reports an outage as status error with the last HTTP status", async () => {
    const darwin = new ScriptedDarwin({ script: [darwinFailures.server500(), darwinFailures.server500(), darwinFailures.server500()] });
    const payload = darwinEventPayload(await lookupDarwin(darwin, { trade: "auto_repair", service: "oil change" }));
    expect(payload).toMatchObject({ status: "error", http_status: 500, query: "auto repair shop", outcome: "unavailable", agents: [] });
  });
});

describe("toDarwinSummary", () => {
  it("satisfies the DarwinSummary contract search_providers returns", async () => {
    const lookup = await lookupDarwin(new ScriptedDarwin({ script: [DARWIN_FIXTURES.needsInput] }), { trade: "x" });
    const summary = DarwinSummary.parse(toDarwinSummary(lookup));
    expect(summary).toMatchObject({ status: "needs_input", search_id: DARWIN_FIXTURES.needsInput.searchId, cached: false });
    expect(summary.question).toBe(DARWIN_FIXTURES.needsInput.response.question);
    expect(summary.agents[0]).toMatchObject({ readiness: "unavailable", can_start_thread: false });
  });

  it("reports a skipped lookup as disabled", () => {
    expect(DarwinSummary.parse(toDarwinSummary(null))).toMatchObject({ status: "disabled", agents: [] });
  });

  it("reports every rung failing as error, never as no_match", async () => {
    const darwin = new ScriptedDarwin({ script: [darwinFailures.network(), darwinFailures.server500()] });
    const lookup = await lookupDarwin(darwin, { trade: "x" });
    expect(DarwinSummary.parse(toDarwinSummary(lookup))).toMatchObject({ status: "error", agents: [] });
  });
});

describe("createDarwin", () => {
  it("runs the real client over the recorded api.darwin.so in fakes mode", async () => {
    const darwin = createDarwin({ DEMO_MODE: "fakes" });
    const lookup = await lookupDarwin(darwin, { trade: "salon", service: "haircut" });
    expect(lookup.outcome).toBe("listed_only");
    expect(lookup.search?.searchId).toBe(DARWIN_FIXTURES.hairSalon.searchId);
    const failing = await lookupDarwin(createDarwin({ DEMO_MODE: "fakes" }, { fakeMode: "error_500" }), { trade: "auto_repair", service: "oil change" });
    expect(failing.outcome).toBe("unavailable");
    expect(failing.attempts.map((a) => a.status)).toEqual([500, 500, 500]);
  });

  it("never serves recorded answers in live mode", () => {
    expect(() => createDarwin({ DEMO_MODE: "live", DARWIN_IMPL: "fake" })).toThrow(/test-only/);
    expect(() => createDarwin({ DARWIN_IMPL: "mock" })).toThrow(/fake or real/);
  });

  it("is on unless DARWIN_ENABLED says otherwise", () => {
    expect(isDarwinEnabled({})).toBe(true);
    expect(isDarwinEnabled({ DARWIN_ENABLED: "true" })).toBe(true);
    for (const off of ["false", "0", "OFF", " no "]) expect(isDarwinEnabled({ DARWIN_ENABLED: off })).toBe(false);
  });

  it("enables Act only with DARWIN_ACT_ENABLED=true and a pilot token", () => {
    expect(createDarwin({ DARWIN_IMPL: "real" }).canAct).toBe(false);
    expect(createDarwin({ DARWIN_IMPL: "real", DARWIN_ACT_TOKEN: "t" }).canAct).toBe(false);
    expect(createDarwin({ DARWIN_IMPL: "real", DARWIN_ACT_ENABLED: "true" }).canAct).toBe(false);
    expect(createDarwin({ DARWIN_IMPL: "real", DARWIN_ACT_ENABLED: "true", DARWIN_ACT_TOKEN: "t" }).canAct).toBe(true);
  });
});

describe("probeDarwinMcp", () => {
  const sse = (message: unknown) => new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, { status: 200 });

  it("initializes, lists tools and checks the ones Platypus needs", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { id, method } = JSON.parse(init!.body as string) as { id: number; method: string };
      if (method === "initialize") return sse({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", serverInfo: { version: "0.11.0" } } });
      return sse({ jsonrpc: "2.0", id, result: { tools: [{ name: "search" }, { name: "act" }, { name: "get_thread" }] } });
    });
    const probe = await probeDarwinMcp({ fetch: fetch as unknown as typeof globalThis.fetch });
    expect(probe).toMatchObject({ ok: true, serverVersion: "0.11.0", missingTools: [] });
    expect((fetch.mock.calls[1]![1]!.headers as Record<string, string>)["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("reports missing tools and transport failures without throwing", async () => {
    const partial = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const { id } = JSON.parse(init!.body as string) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: id === 1 ? {} : { tools: [{ name: "search" }] } }));
    });
    expect(await probeDarwinMcp({ fetch: partial as unknown as typeof globalThis.fetch })).toMatchObject({
      ok: false,
      missingTools: ["act", "get_thread"],
    });
    const down = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    expect(await probeDarwinMcp({ fetch: down as unknown as typeof globalThis.fetch })).toMatchObject({
      ok: false,
      error: "initialize returned HTTP 502",
    });
  });
});
