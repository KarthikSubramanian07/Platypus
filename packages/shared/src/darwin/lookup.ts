import { systemClock, type Clock } from "../clock";
import type { DarwinSummary } from "../contracts/darwin";
import { sanitizeUntrustedText } from "../safety";
import { DarwinError, type Darwin, type DarwinErrorKind } from "./client";
import type { SearchAgent, SearchContextItem, SearchRequest, SearchResponse } from "./schema";

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
  /** City or service area. Never a street address, name or phone number. */
  area?: string;
  /** Sent as a budget context item, in USD cents. */
  budgetCents?: number;
  /** Sent as a deadline context item. Darwin rejects offsets, so it is normalized to UTC with a Z suffix. */
  deadline?: string | Date;
  maxResults?: number;
}

/**
 * Ordered from most to least specific. Darwin consistently returns HTTP 500 for
 * some specific phrasings (for example "hair salon in San Francisco"), while the
 * bare trade usually succeeds, so the last rung is always the bare trade.
 */
export function searchLadder(input: DarwinLookupInput): SearchRequest[] {
  const trade = tradeQuery(input.trade);
  const service = input.service ? sanitizeUntrustedText(input.service, 120) : "";
  const area = input.area ? sanitizeUntrustedText(input.area, 120) : "";
  const maxResults = input.maxResults ?? 5;
  const context: SearchContextItem[] = [];
  if (area) context.push({ type: "text", text: area });
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
  /** Every rung failed. Platypus routes on its own; Darwin is never on the critical path. */
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
}

const CONFIG_ERRORS: ReadonlySet<DarwinErrorKind> = new Set(["unauthorized", "forbidden"]);

export function isStartable(agent: SearchAgent): boolean {
  return agent.canStartThread && agent.readiness === "ready";
}

/**
 * Darwin's docs ask callers to cache identical read-only searches, and a lookup
 * whose first rung fails can take 20 seconds. Answers are kept for `ttlMs`;
 * "unavailable" is never cached so the next request tries again.
 */
export class DarwinLookupCache {
  private readonly entries = new Map<string, { at: number; lookup: DarwinLookup }>();

  constructor(
    private readonly ttlMs: number = 10 * 60_000,
    private readonly clock: Clock = systemClock,
  ) {}

  get(key: string): DarwinLookup | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.clock.now().getTime() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.lookup;
  }

  set(key: string, lookup: DarwinLookup): void {
    if (lookup.outcome === "unavailable") return;
    this.entries.set(key, { at: this.clock.now().getTime(), lookup });
  }
}

/**
 * Asks Darwin whether an agent-native route already exists for this request.
 * Never throws for Darwin-side failures: the booking always has a fallback.
 */
export async function lookupDarwin(
  darwin: Darwin,
  input: DarwinLookupInput,
  options: { cache?: DarwinLookupCache } = {},
): Promise<DarwinLookup> {
  const ladder = searchLadder(input);
  const key = JSON.stringify(ladder);
  const cached = options.cache?.get(key);
  if (cached) return cached;
  const lookup = await runLadder(darwin, ladder);
  options.cache?.set(key, lookup);
  return lookup;
}

async function runLadder(darwin: Darwin, ladder: SearchRequest[]): Promise<DarwinLookup> {
  const attempts: DarwinAttempt[] = [];
  let configError: DarwinErrorKind | null = null;
  // Specific phrasings fail consistently; the bare trade fails only now and then
  // ("auto repair shop" returned 500, then 200 a minute later), so it gets a second try.
  const plan = [...ladder, ladder[ladder.length - 1]!];
  for (const request of plan) {
    const started = Date.now();
    try {
      const { search, requestId, latencyMs } = await darwin.search(request);
      attempts.push({ query: request.query, withContext: Boolean(request.context), ok: true, status: 200, errorKind: null, requestId, latencyMs });
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
export function toDarwinSummary(lookup: DarwinLookup | null, options: { cached?: boolean } = {}): DarwinSummary {
  if (!lookup) return { status: "disabled", agents: [], cached: false };
  const latency_ms = lookup.attempts.reduce((sum, a) => sum + a.latencyMs, 0);
  const search = lookup.search;
  if (!search) return { status: "error", agents: [], cached: options.cached ?? false, latency_ms };
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
    cached: options.cached ?? false,
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
  };
}
