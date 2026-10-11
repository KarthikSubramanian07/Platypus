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
  /** A result Darwin says is usable right now (see isStartable). */
  | "startable"
  /** Darwin lists matching agents, but none is usable. */
  | "listed_only"
  /** Darwin asked a question. A later search_providers with more detail refines the same search. */
  | "needs_input"
  | "no_match"
  /** Every rung failed. Platypus routes on its own; Darwin is never on the critical path. */
  | "unavailable";

export interface DarwinAttempt {
  query: string;
  withContext: boolean;
  /** Set when this attempt refined an earlier search of the same trade and area. */
  previousResponseId?: string;
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
  /** True when this answer came from DarwinLookupCache rather than a new search. */
  cached?: boolean;
  /** "recorded" when the client replays recordings (DEMO_MODE=fakes). Absent means live. */
  provenance?: "live" | "recorded";
  /** The most specific request behind this answer, so a later search can tell whether it adds detail. */
  asked?: string;
}

const CONFIG_ERRORS: ReadonlySet<DarwinErrorKind> = new Set(["unauthorized", "forbidden"]);

/** Darwin: missing setup metadata means unknown, not unnecessary. */
export function setupKnown(agent: SearchAgent): boolean {
  return agent.requiredSetup !== null && agent.requiredSetup !== undefined;
}

/**
 * Darwin's guide: read readiness, canStartThread and requiredSetup before saying an agent can be
 * used. Act checks the route and authority again when a thread starts, so this makes Act eligible,
 * not certain.
 */
export function isStartable(agent: SearchAgent): boolean {
  return agent.canStartThread && agent.readiness === "ready" && setupKnown(agent);
}

/**
 * Darwin's docs ask callers to cache identical read-only searches, and a live
 * lookup takes 10 to 30 seconds when a rung returns 500. Answers are kept per
 * trade and area (see darwinCacheKey) for `ttlMs`; "unavailable" is never cached
 * so the next request tries again.
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
 * Darwin's answer for the ladder is driven by the trade (the last rung is always the
 * bare trade), so one answer serves every service wording, budget and deadline for
 * that trade in that area. This is what lets a warm-up lookup serve the stage search.
 */
export function darwinCacheKey(input: Pick<DarwinLookupInput, "trade" | "area">): string {
  const area = input.area ? sanitizeUntrustedText(input.area, 120).toLowerCase() : "";
  return JSON.stringify([tradeQuery(input.trade), area]);
}

/**
 * Asks Darwin whether an agent-native route already exists for this request.
 * Never throws for Darwin-side failures: the booking always has a fallback.
 * Emits no event: callers that answer an agent (consultDarwin) log darwin.searched themselves.
 *
 * With `refine`, a cached needs_input answer for the same trade and area is not replayed when
 * this search adds detail: the detail goes to Darwin as a refinement of that search instead.
 * Only search_providers refines; request_booking never waits on a new Darwin round trip for it.
 */
export async function lookupDarwin(
  darwin: Darwin,
  input: DarwinLookupInput,
  options: { cache?: DarwinLookupCache; refine?: boolean } = {},
): Promise<DarwinLookup> {
  const key = darwinCacheKey(input);
  const ladder = searchLadder(input);
  const asked = JSON.stringify(ladder[0]);
  const cached = options.cache?.get(key);
  // The service is the free text that can answer Darwin's question; a search without one adds nothing.
  const refinable = Boolean(input.service?.trim()) && cached?.outcome === "needs_input" && cached.search && cached.asked !== asked;
  if (cached && !(options.refine && refinable)) return { ...cached, cached: true };
  const lookup: DarwinLookup = cached
    ? await refine(darwin, cached, ladder[0]!, asked)
    : { ...(await runLadder(darwin, ladder)), asked, provenance: darwin.recorded ? ("recorded" as const) : ("live" as const) };
  // A failed refinement keeps Darwin's earlier answer, now marked as asked with this detail, so
  // repeating the same search replays it instead of paying for another failing round trip.
  options.cache?.set(key, lookup.cached ? { ...cached!, asked } : lookup);
  return lookup;
}

/**
 * Darwin asked a question; this search's detail answers it as a refinement of the same search
 * (previousResponseId, plus X-Search-Token when the search was anonymous). If Darwin refuses or
 * fails (an expired continuation, a 500), its earlier answer still stands and is returned as cached.
 */
async function refine(darwin: Darwin, previous: DarwinLookup, request: SearchRequest, asked: string): Promise<DarwinLookup> {
  const prior = previous.search!;
  const refinement: SearchRequest = { ...request, previousResponseId: prior.responseId };
  const token = prior.searchToken;
  const started = Date.now();
  try {
    const result = await darwin.search(refinement, token ? { searchToken: token } : {});
    // Keep the token that authorizes this search when Darwin does not repeat it: Act needs it too.
    const search = result.search.searchToken || !token ? result.search : { ...result.search, searchToken: token };
    const attempts = [succeeded(refinement, result.requestId, result.latencyMs)];
    return { ...classify(search), search, attempts, configError: null, asked, provenance: previous.provenance };
  } catch (error) {
    if (!(error instanceof DarwinError)) throw error;
    return { ...previous, asked, cached: true, attempts: [failed(refinement, error, started)] };
  }
}

const tried = (request: SearchRequest) => ({
  query: request.query,
  withContext: Boolean(request.context),
  ...(request.previousResponseId ? { previousResponseId: request.previousResponseId } : {}),
});

const succeeded = (request: SearchRequest, requestId: string | null, latencyMs: number): DarwinAttempt => ({
  ...tried(request),
  ok: true,
  status: 200,
  errorKind: null,
  requestId,
  latencyMs,
});

const failed = (request: SearchRequest, error: DarwinError, started: number): DarwinAttempt => ({
  ...tried(request),
  ok: false,
  status: error.details.status ?? null,
  errorKind: error.kind,
  requestId: error.details.requestId ?? null,
  latencyMs: Date.now() - started,
});

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
      attempts.push(succeeded(request, requestId, latencyMs));
      return { ...classify(search), search, attempts, configError: null };
    } catch (error) {
      if (!(error instanceof DarwinError)) throw error;
      attempts.push(failed(request, error, started));
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
  // Darwin's guide: check status first. A question or a no_match means the list is no recommendation.
  if (search.status !== "completed") return { outcome: search.status, candidate: null };
  const candidate = search.response.agents.find(isStartable) ?? null;
  if (candidate) return { outcome: "startable", candidate };
  if (search.response.agents.length > 0) return { outcome: "listed_only", candidate: null };
  return { outcome: "no_match", candidate: null };
}

/**
 * What search_providers returns to the calling agent (the DarwinSummary contract).
 * "error" covers every rung failing; "disabled" (a null lookup) means DARWIN_ENABLED=false.
 * Agents keep Darwin's order. Each says why Darwin listed it (top reasons and uncertainties,
 * sanitized because they are Darwin's text about third parties) and whether it is usable;
 * one that is not is labeled "listed, not ready" and is never a recommendation.
 */
export function toDarwinSummary(lookup: DarwinLookup | null): DarwinSummary {
  if (!lookup) return { status: "disabled", agents: [], cached: false };
  const latency_ms = lookup.attempts.reduce((sum, a) => sum + a.latencyMs, 0);
  const search = lookup.search;
  if (!search) return { status: "error", agents: [], cached: lookup.cached ?? false, latency_ms };
  const clean = (items: string[]) => items.slice(0, 3).map((t) => sanitizeUntrustedText(t, 200));
  const agents = search.response.agents.map((a) => {
    const usable = isStartable(a);
    return {
      agent_id: a.agentId,
      name: sanitizeUntrustedText(a.name, 120),
      readiness: a.readiness,
      can_start_thread: a.canStartThread,
      reasons: clean(a.reasons),
      uncertainties: clean(a.uncertainties),
      capability_id: a.capabilityId,
      capability_revision: a.capabilityRevision,
      usable,
      label: usable ? ("usable" as const) : ("listed, not ready" as const),
      setup: describeSetup(a),
      connection_methods: a.connectionMethods.length,
      verified_connection: a.connectionMethods.some((m) => m.endpointStatus === "verified"),
    };
  });
  const note = noteFor(search, agents.some((a) => a.usable));
  return {
    status: search.status,
    search_id: search.searchId,
    ...(search.response.noMatchReason ? { no_match_reason: sanitizeUntrustedText(search.response.noMatchReason) } : {}),
    ...(search.response.question ? { question: sanitizeUntrustedText(search.response.question) } : {}),
    agents,
    ...(note ? { note } : {}),
    cached: lookup.cached ?? false,
    latency_ms,
  };
}

/** "unknown" when Darwin declared nothing: that is not a promise that no setup or payment is needed. */
function describeSetup(agent: SearchAgent): string {
  const setup = agent.requiredSetup;
  if (!setup) return "unknown";
  const field = (key: string) => (typeof setup[key] === "string" ? sanitizeUntrustedText(setup[key], 160) : "");
  const by = field("suppliedBy");
  const description = field("description");
  return `${field("kind") || "declared"}${by ? ` supplied by ${by}` : ""}${description ? `: ${description}` : ""}`;
}

function noteFor(search: SearchResponse, anyUsable: boolean): string | undefined {
  if (search.status === "needs_input") {
    return "Darwin needs more detail before it recommends any agent. Answer its question by calling search_providers again with a more specific service; Platypus sends that to Darwin as a refinement of this search.";
  }
  if (search.response.agents.length && !anyUsable) {
    return 'Darwin lists these agents, but none is usable now. An agent is usable only when its readiness is ready, it can start a thread, and Darwin declared its setup; setup "unknown" means Darwin does not know what it needs.';
  }
  return undefined;
}

/**
 * The payload for the `darwin.searched` event, in the golden path's shape plus
 * the ladder trail. Ids, labels and Darwin's sanitized reasons only: no
 * connectionPrompt, no provider descriptions (untrusted), no searchToken (a credential).
 */
export function darwinEventPayload(lookup: DarwinLookup): Record<string, unknown> {
  const last = lookup.attempts.at(-1);
  const summary = toDarwinSummary(lookup);
  return {
    status: summary.status,
    http_status: last?.status ?? null,
    provenance: lookup.provenance ?? "live",
    latency_ms: summary.latency_ms,
    query: last?.query ?? null,
    search_id: summary.search_id ?? null,
    response_id: lookup.search?.responseId ?? null,
    previous_response_id: lookup.search?.previousResponseId ?? null,
    outcome: lookup.outcome,
    candidate_agent_id: lookup.candidate?.agentId ?? null,
    ...(summary.question ? { question: summary.question } : {}),
    agents: summary.agents.map(({ agent_id, name, readiness, can_start_thread, label, reasons, uncertainties }) => ({
      agent_id,
      name,
      readiness,
      can_start_thread,
      label,
      reasons,
      uncertainties,
    })),
    attempts: lookup.attempts,
    config_error: lookup.configError,
  };
}
