import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { systemClock, type Clock } from "../clock";
import type { DarwinSummary } from "../contracts/darwin";
import { sanitizeUntrustedText } from "../safety";
import { DarwinError, type Darwin, type DarwinErrorKind } from "./client";
import { SearchResponse, type SearchAgent, type SearchContextItem, type SearchRequest } from "./schema";

/** How Darwin's index phrases each seeded trade. Unknown trades fall back to the snake_case words. */
const TRADE_QUERIES: Record<string, string> = {
  auto_repair: "auto repair shop",
  salon: "hair salon",
  daycare: "daycare",
  mover: "moving company",
  cleaner: "house cleaning service",
  dog_groomer: "dog groomer",
};

export function tradeQuery(trade: string): string {
  return TRADE_QUERIES[trade] ?? trade.replace(/_/g, " ").trim();
}

export interface DarwinLookupInput {
  /** businesses.trade, e.g. "auto_repair". */
  trade: string;
  /** The service the customer agent asked for. Untrusted: sanitized before it leaves Platypus. */
  service?: string;
  /** Sent as a budget context item, in USD cents. */
  budgetCents?: number;
  /** Sent as a deadline context item. Darwin rejects offsets, so it is normalized to UTC with a Z suffix. */
  deadline?: string | Date;
  maxResults?: number;
}

/**
 * Ordered from most to least specific. No rung carries a location, in the query
 * or in context: location-bearing searches are the ones Darwin answers with
 * HTTP 500 (for example "hair salon in San Francisco"). The last rung is always
 * the bare trade, which is also the rung shared and warmed across requests.
 */
export function searchLadder(input: DarwinLookupInput): SearchRequest[] {
  const trade = tradeQuery(input.trade);
  const service = input.service ? sanitizeUntrustedText(input.service, 120) : "";
  const maxResults = input.maxResults ?? 5;
  const context: SearchContextItem[] = [];
  if (input.budgetCents !== undefined && Number.isInteger(input.budgetCents) && input.budgetCents >= 0) {
    context.push({ type: "budget", amountMinor: input.budgetCents, currency: "USD" });
  }
  const deadline = input.deadline === undefined ? undefined : new Date(input.deadline);
  if (deadline && !Number.isNaN(deadline.getTime())) context.push({ type: "deadline", at: deadline.toISOString() });
  const rungs: SearchRequest[] = [];
  if (service || context.length) {
    rungs.push({ query: service ? `${trade}: ${service}` : trade, maxResults, ...(context.length ? { context } : {}) });
  }
  rungs.push({ query: trade, maxResults });
  return rungs;
}

export type DarwinOutcome =
  /** A result Darwin says can start a thread right now. */
  | "startable"
  /** Darwin lists matching agents, but none can start a thread. */
  | "listed_only"
  | "needs_input"
  | "no_match"
  /** Every rung failed, or Darwin did not answer within the budget. Platypus routes on its own. */
  | "unavailable";

export interface DarwinAttempt {
  query: string;
  withContext: boolean;
  ok: boolean;
  status: number | null;
  errorKind: DarwinErrorKind | null;
  requestId: string | null;
  latencyMs: number;
}

export interface DarwinLookup {
  outcome: DarwinOutcome;
  /** First startable result in Darwin's order. Never re-ranked by Platypus. */
  candidate: SearchAgent | null;
  search: SearchResponse | null;
  attempts: DarwinAttempt[];
  /** Set when the last failure was a configuration problem (bad key), so doctor can flag it. */
  configError: DarwinErrorKind | null;
  /** True when the answer is a recent search replayed from DarwinLookupCache. */
  cached?: boolean;
  /** True when Darwin had not answered within budgetMs. The search keeps running and fills the cache. */
  timedOut?: boolean;
}

const CONFIG_ERRORS: ReadonlySet<DarwinErrorKind> = new Set(["unauthorized", "forbidden"]);

export function isStartable(agent: SearchAgent): boolean {
  return agent.canStartThread && agent.readiness === "ready";
}

/** Where `pnpm darwin:warm` writes and the gateway reads warmed answers. Gitignored. */
export const DARWIN_LOOKUP_CACHE_FILE = "darwin-cache/lookups.json";

export interface DarwinLookupCacheOptions {
  /** How long an answer counts as fresh. Default ten minutes. */
  ttlMs?: number;
  /** How long a failed phrasing is skipped. Default one minute. */
  failureTtlMs?: number;
  /**
   * How long the last good answer may stand in when Darwin fails or runs out of
   * time. It is always labeled cached, never presented as a new search. Default a day.
   */
  maxStaleMs?: number;
  /** Persist answers here (JSON, search tokens stripped), so a warm-up survives restarts. */
  file?: string;
  clock?: Clock;
}

interface CachedAnswer {
  at: number;
  search: SearchResponse;
  requestId: string | null;
}

/**
 * Remembers Darwin's answer to each exact search request. Keyed per request, not
 * per booking, so the bare-trade rung is shared by every request for that trade
 * and can be warmed before the demo. A request that just failed is skipped for
 * failureTtlMs, so a known-bad phrasing does not cost every agent five seconds.
 */
export class DarwinLookupCache {
  private readonly answers = new Map<string, CachedAnswer>();
  private readonly failures = new Map<string, number>();
  /** Lookups in flight, so concurrent requests and warm-up share one ladder. */
  readonly inflight = new Map<string, Promise<DarwinLookup>>();
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly file: string | undefined;
  private readonly clock: Clock;

  constructor(options: DarwinLookupCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.failureTtlMs = options.failureTtlMs ?? 60_000;
    this.maxStaleMs = options.maxStaleMs ?? 24 * 60 * 60_000;
    this.file = options.file;
    this.clock = options.clock ?? systemClock;
    if (this.file) this.load(this.file);
  }

  /** A fresh answer, or undefined. */
  answer(request: SearchRequest): CachedAnswer | undefined {
    const entry = this.answers.get(requestKey(request));
    return entry && this.now() - entry.at <= this.ttlMs ? entry : undefined;
  }

  /** The last good answer within maxStaleMs, fresh or not. */
  lastGood(request: SearchRequest): CachedAnswer | undefined {
    const entry = this.answers.get(requestKey(request));
    return entry && this.now() - entry.at <= this.maxStaleMs ? entry : undefined;
  }

  recentlyFailed(request: SearchRequest): boolean {
    const at = this.failures.get(requestKey(request));
    return at !== undefined && this.now() - at <= this.failureTtlMs;
  }

  remember(request: SearchRequest, search: SearchResponse, requestId: string | null): void {
    this.answers.set(requestKey(request), { at: this.now(), search, requestId });
    this.failures.delete(requestKey(request));
    if (this.file) this.save(this.file);
  }

  rememberFailure(request: SearchRequest): void {
    this.failures.set(requestKey(request), this.now());
  }

  private now(): number {
    return this.clock.now().getTime();
  }

  private load(file: string): void {
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { version?: number; answers?: Array<{ key: string } & Partial<CachedAnswer>> };
      if (data.version !== 1) return;
      for (const entry of data.answers ?? []) {
        const search = SearchResponse.safeParse(entry.search);
        if (search.success && typeof entry.at === "number") {
          this.answers.set(entry.key, { at: entry.at, search: search.data, requestId: entry.requestId ?? null });
        }
      }
    } catch {
      // A corrupt cache file is the same as no cache file.
    }
  }

  private save(file: string): void {
    // The search token is a credential for that search; it never goes to disk.
    const answers = [...this.answers].map(([key, a]) => ({ key, at: a.at, requestId: a.requestId, search: { ...a.search, searchToken: undefined } }));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, answers }, null, 2));
  }
}

const requestKey = (request: SearchRequest) => JSON.stringify(request);

export interface LookupOptions {
  cache?: DarwinLookupCache;
  /**
   * Answer within this many milliseconds. When Darwin is slower, the lookup
   * returns "unavailable" with timedOut, and the search finishes in the
   * background so the next request for the same trade is answered from cache.
   */
  budgetMs?: number;
  /** Receives bugs thrown by a search that outlived its budget. Defaults to console.error. */
  onBackgroundError?: (error: unknown) => void;
}

/**
 * Asks Darwin whether an agent-native route already exists for this request.
 * Never throws for Darwin-side failures: the booking always has a fallback.
 */
export async function lookupDarwin(darwin: Darwin, input: DarwinLookupInput, options: LookupOptions = {}): Promise<DarwinLookup> {
  const ladder = searchLadder(input);
  const { cache } = options;

  // The most specific phrasing Darwin has already answered recently wins.
  for (const request of ladder) {
    const hit = cache?.answer(request);
    if (hit) return { ...classify(hit.search), search: hit.search, attempts: [], configError: null, cached: true };
  }

  const key = requestKey({ query: ladder.map((r) => requestKey(r)).join("|") });
  let running = cache?.inflight.get(key);
  if (!running) {
    running = runLadder(darwin, ladder, cache);
    if (cache) {
      cache.inflight.set(key, running);
      void running.finally(() => cache.inflight.delete(key)).catch(() => {});
    }
  }
  const withFallback = running.then((lookup) => (lookup.outcome === "unavailable" ? (lastGood(ladder, cache, lookup) ?? lookup) : lookup));
  if (options.budgetMs === undefined) return withFallback;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DarwinLookup>((resolve) => {
    timer = setTimeout(() => {
      const timedOut: DarwinLookup = { outcome: "unavailable", candidate: null, search: null, attempts: [], configError: null, timedOut: true };
      resolve(lastGood(ladder, cache, timedOut) ?? timedOut);
    }, options.budgetMs);
    timer.unref?.();
  });
  const report = options.onBackgroundError ?? ((error: unknown) => console.error("Darwin lookup failed after its budget", error));
  withFallback.catch(report);
  try {
    return await Promise.race([withFallback, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The most specific last good answer, labeled cached, keeping why the live search did not answer. */
function lastGood(ladder: SearchRequest[], cache: DarwinLookupCache | undefined, failed: DarwinLookup): DarwinLookup | undefined {
  for (const request of ladder) {
    const hit = cache?.lastGood(request);
    if (hit) return { ...classify(hit.search), search: hit.search, attempts: failed.attempts, configError: failed.configError, cached: true, ...(failed.timedOut ? { timedOut: true } : {}) };
  }
  return undefined;
}

/**
 * Fills the cache with a live bare-trade answer for each trade, one at a time, so
 * a demo's first request does not wait on Darwin. Darwin's 500s come and go, so
 * each trade gets up to `rounds` ladders. Returns what each trade ended with.
 */
export async function warmDarwinLookups(
  darwin: Darwin,
  cache: DarwinLookupCache,
  trades: readonly string[],
  options: { rounds?: number } = {},
): Promise<Array<{ trade: string; outcome: DarwinOutcome; rounds: number }>> {
  const results: Array<{ trade: string; outcome: DarwinOutcome; rounds: number }> = [];
  for (const trade of [...new Set(trades)]) {
    let outcome: DarwinOutcome = "unavailable";
    let rounds = 0;
    while (outcome === "unavailable" && rounds < (options.rounds ?? 3)) {
      rounds += 1;
      const lookup = await runLadder(darwin, searchLadder({ trade }), cache);
      outcome = lookup.outcome;
      if (lookup.configError) break;
    }
    results.push({ trade, outcome, rounds });
  }
  return results;
}

async function runLadder(darwin: Darwin, ladder: SearchRequest[], cache?: DarwinLookupCache): Promise<DarwinLookup> {
  const attempts: DarwinAttempt[] = [];
  let configError: DarwinErrorKind | null = null;
  // Specific phrasings fail consistently; the bare trade fails only now and then
  // ("auto repair shop" returned 500, then 200 a minute later), so it gets a second try.
  const bare = ladder[ladder.length - 1]!;
  const plan = [...ladder.slice(0, -1).filter((r) => !cache?.recentlyFailed(r)), bare, bare];
  for (const request of plan) {
    const started = Date.now();
    try {
      const { search, requestId, latencyMs } = await darwin.search(request);
      attempts.push({ query: request.query, withContext: Boolean(request.context), ok: true, status: 200, errorKind: null, requestId, latencyMs });
      cache?.remember(request, search, requestId);
      return { ...classify(search), search, attempts, configError: null };
    } catch (error) {
      if (!(error instanceof DarwinError)) throw error;
      attempts.push({
        query: request.query,
        withContext: Boolean(request.context),
        ok: false,
        status: error.details.status ?? null,
        errorKind: error.kind,
        requestId: error.details.requestId ?? null,
        latencyMs: Date.now() - started,
      });
      // A rejected key will not improve with a different phrasing; anything else
      // (a 500, or a 400 caused by the context item) gets the next, simpler rung.
      if (CONFIG_ERRORS.has(error.kind)) {
        configError = error.kind;
        break;
      }
      if (request !== bare) cache?.rememberFailure(request);
    }
  }
  return { outcome: "unavailable", candidate: null, search: null, attempts, configError };
}

function classify(search: SearchResponse): Pick<DarwinLookup, "outcome" | "candidate"> {
  const candidate = search.response.agents.find(isStartable) ?? null;
  if (candidate) return { outcome: "startable", candidate };
  if (search.response.agents.length > 0) return { outcome: "listed_only", candidate: null };
  if (search.status === "needs_input") return { outcome: "needs_input", candidate: null };
  return { outcome: "no_match", candidate: null };
}

/**
 * What search_providers returns to the calling agent (the DarwinSummary contract).
 * "error" covers every rung failing; "disabled" (a null lookup) means DARWIN_ENABLED=false.
 * Reasons and uncertainties are Darwin's text about third parties, so they are sanitized.
 */
export function toDarwinSummary(lookup: DarwinLookup | null): DarwinSummary {
  if (!lookup) return { status: "disabled", agents: [], cached: false };
  const latency_ms = lookup.attempts.reduce((sum, a) => sum + a.latencyMs, 0);
  const search = lookup.search;
  if (!search) return { status: "error", agents: [], cached: false, latency_ms };
  const clean = (items: string[]) => items.slice(0, 5).map((t) => sanitizeUntrustedText(t, 300));
  return {
    status: search.status,
    search_id: search.searchId,
    ...(search.response.noMatchReason ? { no_match_reason: sanitizeUntrustedText(search.response.noMatchReason) } : {}),
    ...(search.response.question ? { question: sanitizeUntrustedText(search.response.question) } : {}),
    agents: search.response.agents.map((a) => ({
      agent_id: a.agentId,
      name: sanitizeUntrustedText(a.name, 120),
      readiness: a.readiness,
      can_start_thread: a.canStartThread,
      reasons: clean(a.reasons),
      uncertainties: clean(a.uncertainties),
    })),
    cached: lookup.cached ?? false,
    latency_ms,
  };
}

/**
 * The payload for the `darwin.searched` event, in the golden path's shape plus
 * the ladder trail. Ids and short labels only: no connectionPrompt, no provider
 * descriptions (untrusted), no searchToken (a credential).
 */
export function darwinEventPayload(lookup: DarwinLookup): Record<string, unknown> {
  const last = lookup.attempts.at(-1);
  const summary = toDarwinSummary(lookup);
  return {
    status: summary.status,
    http_status: last?.status ?? null,
    provenance: "live",
    latency_ms: summary.latency_ms,
    query: last?.query ?? null,
    search_id: summary.search_id ?? null,
    outcome: lookup.outcome,
    candidate_agent_id: lookup.candidate?.agentId ?? null,
    agents: summary.agents.map(({ agent_id, name, readiness, can_start_thread }) => ({ agent_id, name, readiness, can_start_thread })),
    attempts: lookup.attempts,
    config_error: lookup.configError,
    cached: summary.cached,
    timed_out: lookup.timedOut ?? false,
  };
}
