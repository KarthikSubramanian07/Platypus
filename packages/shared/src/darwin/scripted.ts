import { loadDarwinRecording, type FakeDarwinMode } from "../testing/fake-darwin";
import { DarwinError, type ActOptions, type Darwin, type DarwinSearchResult, type SearchOptions } from "./client";
import { ActResponse, SearchResponse, type ActContinueRequest, type ActStartRequest, type SearchAgent, type SearchRequest } from "./schema";

const recorded = (mode: FakeDarwinMode) => SearchResponse.parse(loadDarwinRecording(mode).body);

/**
 * Real Darwin Search v3 responses from testing/fixtures, recorded on 2026-10-11.
 * Parsing them with the client's schema doubles as a contract test.
 */
export const DARWIN_FIXTURES = {
  hairSalon: recorded("listed"),
  movingCompanyWithContext: recorded("listed_context"),
  needsInput: recorded("needs_input"),
  invoiceMatch: recorded("match"),
} as const;

/**
 * A copy of a recorded result that Darwin says can start a thread, with its setup declared
 * (an undeclared setup is unknown, so not usable). No live result looks like this today.
 */
export function startableAgent(base: SearchAgent = DARWIN_FIXTURES.hairSalon.response.agents[0]!): SearchAgent {
  return {
    ...structuredClone(base),
    readiness: "ready",
    canStartThread: true,
    providerCheck: "confirmed",
    requiredSetup: { kind: "provider_configuration", suppliedBy: "provider", description: "The provider configured its booking route." },
  };
}

export function searchWith(agents: SearchAgent[], base: SearchResponse = DARWIN_FIXTURES.hairSalon): SearchResponse {
  const copy = structuredClone(base);
  copy.response.agents = agents.map((a, i) => ({ ...a, rank: i + 1 }));
  return copy;
}

export type FakeSearchStep = SearchResponse | DarwinError | ((request: SearchRequest) => SearchResponse | DarwinError);

export interface ScriptedDarwinOptions {
  /** Consumed one per search() call. When empty, every search returns `fallback`. */
  script?: FakeSearchStep[];
  fallback?: SearchResponse;
  canAct?: boolean;
}

/**
 * A Darwin whose answers a test scripts one search at a time, for sequences a
 * single recording cannot express (a 500, then a success). Records every request
 * so tests can assert on the exact query that would have left Platypus.
 * For a fetch-level fake of api.darwin.so, use createFakeDarwinFetch from ../testing.
 */
export class ScriptedDarwin implements Darwin {
  readonly searches: SearchRequest[] = [];
  /** The options of each search() call, in the same order as `searches`. */
  readonly searchOptions: SearchOptions[] = [];
  readonly acts: Array<{ request: ActStartRequest | ActContinueRequest; options: ActOptions }> = [];
  readonly canAct: boolean;
  private readonly script: FakeSearchStep[];
  private readonly fallback: SearchResponse;

  constructor(options: ScriptedDarwinOptions = {}) {
    this.script = [...(options.script ?? [])];
    this.fallback = options.fallback ?? DARWIN_FIXTURES.hairSalon;
    this.canAct = options.canAct ?? false;
  }

  async search(request: SearchRequest, options: SearchOptions = {}): Promise<DarwinSearchResult> {
    this.searches.push(structuredClone(request));
    this.searchOptions.push({ ...options });
    let step = this.script.shift() ?? this.fallback;
    if (typeof step === "function") step = step(request);
    if (step instanceof DarwinError) throw step;
    return { search: structuredClone(step), requestId: `fake-${this.searches.length}`, latencyMs: 0 };
  }

  async act(request: ActStartRequest | ActContinueRequest, options: ActOptions): Promise<ActResponse> {
    if (!this.canAct) throw new DarwinError("act_not_configured", "ScriptedDarwin was created without canAct", { operation: "act" });
    this.acts.push({ request: structuredClone(request), options });
    const n = this.acts.length;
    const agentId = "agentIds" in request && request.agentIds?.[0] ? request.agentIds[0] : "fake-agent";
    return ActResponse.parse({
      type: "request",
      actRequestId: `act_fake_${n}`,
      status: "completed",
      threads: [{ agentId, threadId: "threadId" in request ? request.threadId : `thr_fake_${n}`, messageId: `msg_fake_${n}` }],
    });
  }
}

/** Shorthand for scripting the failures Darwin actually returns. */
export const darwinFailures = {
  /** What Darwin sends for some location-qualified queries today. */
  server500: (requestId = "fake-500") =>
    new DarwinError("server", "Darwin search failed with HTTP 500: Internal server error", { status: 500, requestId, operation: "search" }),
  unavailable503: () => new DarwinError("server", "Darwin search failed with HTTP 503", { status: 503, operation: "search" }),
  rateLimited: (retryAfterMs = 1000) =>
    new DarwinError("rate_limited", "Darwin search failed with HTTP 429", { status: 429, retryAfterMs, operation: "search" }),
  unauthorized: () =>
    new DarwinError("unauthorized", "Darwin search failed with HTTP 401", { status: 401, operation: "search" }),
  network: () => new DarwinError("network", "Darwin search could not be reached (TimeoutError)", { operation: "search" }),
};
