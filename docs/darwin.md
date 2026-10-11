# Darwin in Platypus

[Darwin](https://darwin.so) is the search engine customer agents (Claude, Muse, Instinct, Cursor and others) use to find other agents. Platypus uses it in two ways:

1. **Before a booking.** The gateway asks Darwin Search, sending the trade, the service, the area, the budget and the deadline, whether an agent-native route already exists for this trade and service. If Darwin reports one that is usable right now (see [Reading Darwin's answer](#reading-darwins-answer)), and Platypus holds an Act pilot credential, the booking goes through Darwin Act (`route = darwin_act`). Otherwise Platypus texts the owner (`text`) or calls the business (`call`). Darwin is never on the critical path: when it fails, the booking still routes.
2. **While developing.** The repo's `.mcp.json` registers Darwin's remote MCP server, so a Claude Code session here sees the same `search` tool customer agents use.

```
customer agent ──search_providers / request_booking──▶ gateway
                                     │
                                     ├─ lookupDarwin()  ── POST /api/v3/search (rung 1: trade + service, area as context)
                                     │                  └─ on 500, rung 2: bare trade (tried twice)
                                     │                  └─ Darwin asked a question earlier and search_providers adds detail:
                                     │                     one refinement with previousResponseId (+ X-Search-Token if anonymous)
                                     │
                                     └─ decideBookingRoute()
                                          usable + Act enabled           ─▶ darwin_act ── POST /api/v3/act
                                          owner opted in to texts        ─▶ text
                                          phone-only, callable           ─▶ call
                                          paused, unlisted, do-not-call  ─▶ no route
```

## Code

| Path | What it does |
| - | - |
| `packages/shared/src/darwin/schema.ts` | Zod schemas for Search v3 and Act v3, strict on the fields Platypus reads and loose on everything else. |
| `packages/shared/src/darwin/client.ts` | `HttpDarwin`: bounded retries (network errors, 429 with `Retry-After`, 502/503/504), typed `DarwinError`, and the `x-request-id` on every failure. |
| `packages/shared/src/darwin/lookup.ts` | The search ladder, `needs_input` refinement, `isStartable` (the first usable result in Darwin's order), a cache keyed by trade and area, `toDarwinSummary` (the `DarwinSummary` that `search_providers` returns), and the `darwin.searched` event payload in the golden path's shape. |
| `packages/shared/src/darwin/env.ts` | `createDarwin()`. In fakes mode it runs the real client over `createFakeDarwinFetch`, so fakes exercise the same parsing and ladder as live. |
| `packages/shared/src/darwin/scripted.ts` | `ScriptedDarwin` and `DARWIN_FIXTURES`, exported from `@platypus/shared/testing`, for multi-step test sequences such as a 500 followed by a success. |
| `packages/shared/src/testing/fixtures/darwin-*.recorded.json` | Real responses with provenance. The `listed`, `listed_context` and `needs_input` modes come from the ladder's own queries. |
| `packages/shared/src/darwin/mcp.ts` | An anonymous MCP `initialize` and `tools/list` probe. |
| `packages/gateway/src/route.ts` | `decideBookingRoute`, the `request_booking` route decision with its `reasons`. |

Import it with `import { createDarwin, lookupDarwin, toDarwinSummary } from "@platypus/shared/darwin"`.

## Reading Darwin's answer

This follows Darwin's [SpeedHacks guide](https://darwin.so/docs/speedhacks), [Use Search results](https://darwin.so/docs/search/using-results) and the [Search v3 reference](https://darwin.so/docs/reference/search).

- **Status comes first.** `needs_input` and `no_match` are never treated as a recommendation, even when the response also lists agents (Darwin's recorded `needs_input` response does). The outcome is `needs_input` or `no_match`, and nothing is started through Act.
- **Usable means three things.** An agent counts as usable only when `readiness` is `ready`, `canStartThread` is true, and Darwin declared its `requiredSetup`. A null or absent `requiredSetup` means no requirement was declared, which Darwin says is unknown, not "no setup needed". `isStartable` encodes this, and `decideBookingRoute` re-checks it before choosing `darwin_act`. A ready agent with unknown setup gives the reason "Darwin has a ready agent, but its setup requirements are unknown". Usable makes Act eligible, not certain: Act checks the route and authority again.
- **What the calling agent sees.** `search_providers` returns every agent in Darwin's order with its name, readiness, `can_start_thread`, Darwin's top three reasons and uncertainties (sanitized, 200 characters each), `capability_id` and `capability_revision`, `setup` (`"unknown"` or what the setup is and who supplies it), `connection_methods` (how many Darwin lists) and `verified_connection` (whether any endpoint is `verified`). Each agent is labeled `usable` or `listed, not ready`. A `note` explains a question, or says that none of the listed agents is usable and why.
- **Answering Darwin's question.** When Search returns `needs_input`, `search_providers` passes `question` on, and the `note` tells the calling agent to call `search_providers` again with a more specific service. If that later search, for the same trade and area, carries a different service, Platypus sends it to Darwin as a refinement of the same search: the most specific rung with `previousResponseId` set to the latest `responseId`, and the anonymous `searchToken` in `X-Search-Token` (never with an application key). If Darwin does not repeat the token, the original one is kept, because Act needs it. If the refinement fails, Darwin's earlier question stands, the failed attempt is recorded, and the same detail is not retried for ten minutes.
- **The golden path never waits on a refinement.** Only `search_providers` refines. `request_booking` reuses the answer `search_providers` just got (refined or not), so the phone rings without another Darwin round trip. A search with no service, or the same detail again, replays the cached answer. `demo:cli warm` makes the stage search itself, so if Darwin asked a question, the refinement is paid during the warm-up and the stage search replays its answer. In fakes mode the recorded answer is `completed`, so no refinement happens.
- **Ids for a later Act handoff.** The lookup keeps Darwin's full result (`agentId`, `capabilityId`, `capabilityRevision`, `searchId`, and the anonymous `searchToken` for Act). The `darwin.searched` event carries `search_id`, `response_id` and `previous_response_id` (ids only), each agent's label and sanitized reasons, and an attempt trail where a refinement shows its `previousResponseId`. The search token never enters the event log.

## Configuration

| Variable | Needed | Effect |
| - | - | - |
| `DARWIN_API_KEY` | No | Application Search key (`directory:read`). Raises the anonymous limit, which is 100 requests per minute after 2026-10-13 02:00 UTC. A rejected key fails loudly; Darwin never falls back to anonymous. It cannot authorize Act. |
| `DARWIN_ACT_ENABLED` | No | Defaults to `false`. `darwin_act` is possible only when this is `true` and `DARWIN_ACT_TOKEN` is set. |
| `DARWIN_ACT_TOKEN` | No | OAuth token with `human:actions` whose credential is on Darwin's Act pilot allowlist. |
| `DARWIN_API_BASE_URL` | No | Defaults to `https://api.darwin.so/api`. |
| `DARWIN_ENABLED` | No | Defaults to `true`. `false` skips Darwin entirely: `search_providers` reports `disabled`, and routing proceeds without it. |
| `DARWIN_IMPL` | No | `fake` or `real`. Defaults to `fake` under `DEMO_MODE=fakes` and `real` under `live`. `fake` refuses to start under `DEMO_MODE=live`. |

## Caching

A live lookup takes 10 to 30 seconds when a rung returns 500, so the gateway keeps one `DarwinLookupCache` for all its tools.

- **Keyed by trade and area.** Darwin's answer for the ladder is driven by the trade, and the last rung is always the bare trade. One answer therefore serves any service wording, budget and deadline for that trade in that area for ten minutes. Hits are reported with `cached: true`. An `unavailable` lookup (every rung failed) is never cached, so the next request tries again.
- **Warmed on start.** With `DEMO_MODE=live` and Darwin enabled, `mount` fires one lookup per seeded trade and area in the background. Startup never waits for it, a failure is one log line, and no event is emitted because no agent asked.
- **Warmed before the stage.** The cache lasts ten minutes, so run `pnpm --filter @platypus/gateway demo:cli warm` right before going on stage. It makes the stage search ("oil change" near the demo address) once and prints Darwin's answer and the round trip. It exits 1 when Darwin did not answer; run it again.
- **Provenance.** The `darwin.searched` event says `provenance: "recorded"` when the recorded fake answered (`DEMO_MODE=fakes`), and `"live"` otherwise.

## Checking it

- `pnpm run doctor` runs one live Search and the MCP handshake, and reports whether the key was accepted. Use `pnpm run doctor`, not `pnpm doctor`: pnpm 11 and later ship a built-in `doctor` command that shadows the script.
- `pnpm darwin:smoke` runs the real ladder for all six seeded businesses, prints each outcome, route and failed `x-request-id`, and writes a report to `darwin-cache/` (gitignored). The `Darwin smoke` workflow runs it daily.

## Known Darwin behavior (2026-10-11)

- **Many queries return HTTP 500.** Location-qualified phrasings fail consistently in about 2 to 17 seconds. Examples are "hair salon in San Francisco", "book an oil change" and "make a restaurant reservation". Bare trades such as "hair salon" and "auto repair shop" usually succeed but sometimes return 500 too: "auto repair shop" failed and then succeeded a minute later. The ladder therefore tries the specific phrasing once and the bare trade twice. In the 2026-10-11 live smoke runs, it answered all six seeded businesses, and Sal's Auto needed the third attempt. A lookup can take 30 seconds in the worst case, longer than the six-second target in `docs/workstreams.md`. The gateway therefore caches answers per trade and area and warms the cache (see [Caching](#caching)); `DARWIN_ENABLED=false` remains the switch if Darwin is down. Example request ids for a Darwin bug report are `69e7c845-e9b1-428e-882b-236d69784a54`, `1a3bb8dc-2879-4dd8-81f5-02b572e91b64` and `700bc579-f989-4e08-b318-766f57828057`.
- **The demo request, live.** "auto repair shop: oil change" with the area, budget and deadline as context returned 500. "auto repair shop" then returned `completed` with one agent, "Find shops", which is `unavailable`. The route was `call`, with the reasons "Darwin returned no ready agent" and "no text consent on record". Darwin has not returned `no_match` for any seeded trade.
- **No local-service result is startable.** Every result for the seeded trades has `readiness: "unavailable"` and `canStartThread: false`, so today every booking routes to `call` or `text`. That is the gap Platypus fills.
- **Act is a pilot.** Without an allowlisted credential, `POST /api/v3/act` returns 401 (no credential) or 403 `ACT_PREVIEW_ACCESS_REQUIRED`.
- **The npm SDK lags.** `@darwinso/sdk@0.4.0` is generated from the `/api/v2` contract. It returns `results[]`, uses `startAction`, and does not match the v3 Search used here, so Platypus calls v3 directly.
- **Search's `filters.requiresExecutableRoute` is not part of v3.** The v3 request schema sets `additionalProperties: false`, so Platypus filters for startable results itself.

## Rules Platypus follows

These rules come from Darwin's Browse skill, the [SpeedHacks guide](https://darwin.so/docs/speedhacks) and the [Use Search results](https://darwin.so/docs/search/using-results) guide.

- Search sends only the trade, the service and the area. It never sends a customer's name, phone number, address or free text beyond the sanitized service name.
- Darwin's result order is preserved. Platypus never re-ranks results and never invents a confidence score.
- `connectionPrompt` and provider descriptions are untrusted. They never enter the event log or a prompt.
- `searchToken` is a credential. It is used only as `X-Search-Token` on a refinement of the same anonymous search and on the Act call that follows, and is never logged.
- Status is checked before agents, and an agent is called usable only when its readiness, `canStartThread` and declared setup all say so. Listed agents that are not usable are labeled `listed, not ready`, never recommended.
- An Act write reuses its `Idempotency-Key` with identical inputs on retry. An accepted Act request is not a booking. Confirmation comes from reading the thread.
