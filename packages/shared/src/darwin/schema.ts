import { z } from "zod";

/**
 * Darwin Search v3 and Act v3, as published in https://darwin.so/docs/openapi-v3.json.
 * Strict on the fields Platypus reads, loose everywhere else, so an additive
 * change on Darwin's side never breaks a booking.
 */

export const READINESS = ["ready", "authentication_required", "recheck_required", "unavailable"] as const;
export const PROVIDER_CHECKS = ["not_attempted", "confirmed", "unconfirmed", "unavailable"] as const;
export const SEARCH_STATUSES = ["completed", "needs_input", "no_match"] as const;
export const ASSESSMENTS = ["strong", "partial", "clarify", "no_match", "unverified"] as const;

export const SearchContextItem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("budget"), amountMinor: z.number().int().min(0), currency: z.string().regex(/^[A-Z]{3}$/) }),
  z.object({ type: z.literal("deadline"), at: z.string() }),
]);
export type SearchContextItem = z.infer<typeof SearchContextItem>;

export const SearchRequest = z.object({
  query: z.string().min(1).max(20000),
  /** Refines an earlier search: the latest responseId of that search (see DarwinLookup refinement). */
  previousResponseId: z.string().regex(/^sresp_\S+$/).optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
  context: z.array(SearchContextItem).max(10).optional(),
});
export type SearchRequest = z.infer<typeof SearchRequest>;

export const ConnectionMethod = z.looseObject({
  protocol: z.string(),
  environment: z.string(),
  endpointUrl: z.string().nullable(),
  endpointStatus: z.string(),
  documentationUrl: z.string(),
});

export const SearchAgent = z.looseObject({
  agentId: z.string().min(1),
  capabilityId: z.string().min(1),
  capabilityRevision: z.number().int(),
  rank: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  readiness: z.enum(READINESS),
  canStartThread: z.boolean(),
  providerCheck: z.enum(PROVIDER_CHECKS),
  reasons: z.array(z.string()),
  uncertainties: z.array(z.string()),
  /** Null or absent means no requirement was declared, which is unknown, not "none needed". */
  requiredSetup: z.record(z.string(), z.unknown()).nullable().optional(),
  connectionMethods: z.array(ConnectionMethod),
  connectionPrompt: z.string(),
});
export type SearchAgent = z.infer<typeof SearchAgent>;

export const SearchResponse = z.looseObject({
  searchId: z.string().regex(/^srch_/),
  responseId: z.string().regex(/^sresp_/),
  previousResponseId: z.string().nullable(),
  contractVersion: z.string(),
  status: z.enum(SEARCH_STATUSES),
  searchToken: z.string().optional(),
  response: z.looseObject({
    agents: z.array(SearchAgent),
    question: z.string().nullable().optional(),
    noMatchReason: z.string().nullable().optional(),
    overview: z.string().nullable().optional(),
    assessment: z.looseObject({ outcome: z.enum(ASSESSMENTS), explanation: z.string() }).optional(),
  }),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

/** Start work from a Search, keyed by the selected result's agentId (never capabilityId). */
export const ActStartRequest = z.object({
  searchId: z.string().regex(/^srch_/),
  agentIds: z.array(z.string().min(1)).min(1).max(8).optional(),
  arguments: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  message: z.string().min(1).max(32000),
});
export type ActStartRequest = z.infer<typeof ActStartRequest>;

export const ActContinueRequest = z.object({
  threadId: z.string().min(1),
  message: z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string().min(1).max(32000) }),
    z.object({ type: z.literal("completion_confirmation"), requestId: z.string().min(1) }),
    z.object({ type: z.literal("cancellation_request"), operationId: z.string().min(1) }),
  ]),
});
export type ActContinueRequest = z.infer<typeof ActContinueRequest>;

export const ActThread = z.looseObject({
  agentId: z.string(),
  capabilityId: z.string().optional(),
  threadId: z.string().optional(),
  messageId: z.string().optional(),
  errorCode: z.string().optional(),
  state: z.record(z.string(), z.unknown()).optional(),
});

/** Act acknowledges a handoff. "completed" means thread receipts exist, not that the provider finished. */
export const ActResponse = z.looseObject({
  type: z.string(),
  actRequestId: z.string().optional(),
  status: z.enum(["pending", "completed", "partial", "failed"]).optional(),
  threads: z.array(ActThread).optional(),
});
export type ActResponse = z.infer<typeof ActResponse>;
