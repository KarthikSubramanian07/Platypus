import { z } from "zod";

/**
 * Darwin Search v3 response, as recorded from api.darwin.so on 2026-10-11.
 * Lenient (passthrough) so a new field from Darwin never breaks the demo.
 */
export const DarwinAgent = z
  .object({
    agentId: z.string(),
    capabilityId: z.string().optional(),
    rank: z.number().optional(),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    readiness: z.enum(["ready", "authentication_required", "recheck_required", "unavailable"]),
    canStartThread: z.boolean(),
    reasons: z.array(z.string()).default([]),
    uncertainties: z.array(z.string()).default([]),
    providerCheck: z.string().optional(),
    connectionMethods: z.array(z.record(z.string(), z.unknown())).default([]),
    connectionPrompt: z.string().nullable().optional(),
  })
  .passthrough();

export const DarwinSearchResponse = z
  .object({
    searchId: z.string(),
    responseId: z.string(),
    status: z.enum(["completed", "needs_input", "no_match"]),
    response: z
      .object({
        agents: z.array(DarwinAgent).default([]),
        assessment: z.object({ outcome: z.string(), explanation: z.string().optional() }).passthrough().nullable().optional(),
        question: z.string().nullable().optional(),
        noMatchReason: z.string().nullable().optional(),
        overview: z.string().nullable().optional(),
      })
      .passthrough(),
    searchToken: z.string().optional(),
  })
  .passthrough();
export type DarwinSearchResponse = z.infer<typeof DarwinSearchResponse>;

/** What the gateway tells the calling agent about Darwin. Status "error" and "disabled" are ours, never Darwin's. */
export const DarwinSummary = z.object({
  status: z.enum(["completed", "needs_input", "no_match", "error", "disabled"]),
  search_id: z.string().optional(),
  no_match_reason: z.string().optional(),
  question: z.string().optional(),
  agents: z
    .array(
      z.object({
        agent_id: z.string(),
        name: z.string().optional(),
        readiness: z.string(),
        can_start_thread: z.boolean(),
        reasons: z.array(z.string()),
        uncertainties: z.array(z.string()),
      }),
    )
    .default([]),
  cached: z.boolean().default(false).describe("True when this is the last live response replayed from disk, not a new search"),
  latency_ms: z.number().optional(),
});
export type DarwinSummary = z.infer<typeof DarwinSummary>;
