import { systemClock, type Clock } from "../clock";
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
  maxResults?: number;
}

/**
 * Ordered from most to least specific. Darwin returns a deterministic HTTP 500 for
 * some specific phrasings (for example "hair salon in San Francisco"), and the bare
 * trade succeeds for every seeded trade, so the last rung is always the bare trade.
 */
export function searchLadder(input: DarwinLookupInput): SearchRequest[] {
  const trade = tradeQuery(input.trade);
  const service = input.service ? sanitizeUntrustedText(input.service, 120) : "";
  const area = input.area ? sanitizeUntrustedText(input.area, 120) : "";
  const maxResults = input.maxResults ?? 5;
  const context: SearchContextItem[] = area ? [{ type: "text", text: area }] : [];
  const rungs: SearchRequest[] = [];
  if (service || area) {
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
  for (const request of ladder) {
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
 * The payload for the `darwin.searched` event. Ids and counts only: no
 * connectionPrompt, no provider text (untrusted), no searchToken (a credential).
 */
export function darwinEventPayload(lookup: DarwinLookup): Record<string, unknown> {
  return {
    outcome: lookup.outcome,
    search_id: lookup.search?.searchId ?? null,
    response_id: lookup.search?.responseId ?? null,
    status: lookup.search?.status ?? null,
    assessment: lookup.search?.response.assessment?.outcome ?? null,
    agent_count: lookup.search?.response.agents.length ?? 0,
    candidate: lookup.candidate
      ? {
          agent_id: lookup.candidate.agentId,
          capability_id: lookup.candidate.capabilityId,
          capability_revision: lookup.candidate.capabilityRevision,
          name: sanitizeUntrustedText(lookup.candidate.name, 120),
        }
      : null,
    attempts: lookup.attempts,
    config_error: lookup.configError,
  };
}
