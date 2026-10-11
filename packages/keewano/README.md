# @platypus/keewano

What Platypus learns, per business, queryable in plain English.

**Owns:** typed custom events (CallPlaced, PriceQuoted, ConsentGiven, ReplySeconds and friends; never transcripts or raw text), a bridge from `/events/stream` to Keewano's REST ingress, a two-week backfill for the seeded businesses, and the `ask` client the gateway uses to answer a judge's question live.

**Depends on:** `@platypus/shared` only.

Status: shell. Built in workstream C.
