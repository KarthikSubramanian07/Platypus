# Darwin in Platypus

[Darwin](https://darwin.so) is the search engine customer agents (Claude, Muse, Instinct, Cursor and others) use to find other agents. Platypus uses it in two ways:

1. **Before a booking.** The gateway asks Darwin Search, sending the trade, the service, the budget and the deadline (never a location), whether an agent-native route already exists for this trade and service. If Darwin reports one that can start a thread right now, and Platypus holds an Act pilot credential, the booking goes through Darwin Act (`route = darwin_act`). Otherwise Platypus texts the owner (`text`) or calls the business (`call`). Darwin is never on the critical path: when it fails, the booking still routes.
2. **While developing.** The repo's `.mcp.json` registers Darwin's remote MCP server, so a Claude Code session here sees the same `search` tool customer agents use.

```
customer agent ──request_booking──▶ gateway
                                     │
                                     ├─ lookupDarwin()  ── cache hit? answer now (labeled cached)
                                     │                  ── POST /api/v3/search (rung 1: trade + service, budget and deadline as context)
                                     │                  └─ on 500, rung 2: bare trade (tried twice)
                                     │                  past budgetMs: last real answer (cached) or "did not answer in time";
                                     │                  the search keeps going and refills the cache
                                     │
                                     └─ decideBookingRoute()
                                          startable + Act enabled       ─▶ darwin_act ── POST /api/v3/act
                                          owner opted in to texts        ─▶ text
                                          phone-only, callable           ─▶ call
                                          paused, unlisted, do-not-call  ─▶ no route
```

## Code

| Path | What it does |
| - | - |
| `packages/shared/src/darwin/schema.ts` | Zod schemas for Search v3 and Act v3, strict on the fields Platypus reads and loose on everything else. |
| `packages/shared/src/darwin/client.ts` | `HttpDarwin`: bounded retries (network errors, 429 with `Retry-After`, 502/503/504), typed `DarwinError`, and the `x-request-id` on every failure. |
| `packages/shared/src/darwin/lookup.ts` | The search ladder, the choice of startable result (first in Darwin's order, `canStartThread && readiness === "ready"`), `DarwinLookupCache` (per-request answers, skipping of failed phrasings, the last good answer, optional file persistence), the `budgetMs` deadline, `warmDarwinLookups`, `toDarwinSummary` (the `DarwinSummary` that `search_providers` returns), and the `darwin.searched` event payload in the golden path's shape. |
| `packages/shared/src/darwin/env.ts` | `createDarwin()`. In fakes mode it runs the real client over `createFakeDarwinFetch`, so fakes exercise the same parsing and ladder as live. |
| `packages/shared/src/darwin/scripted.ts` | `ScriptedDarwin` and `DARWIN_FIXTURES`, exported from `@platypus/shared/testing`, for multi-step test sequences such as a 500 followed by a success. |
| `packages/shared/src/testing/fixtures/darwin-*.recorded.json` | Real responses with provenance. The `listed`, `listed_context` and `needs_input` modes come from the ladder's own queries. |
| `packages/shared/src/darwin/mcp.ts` | An anonymous MCP `initialize` and `tools/list` probe. |
| `scripts/darwin-warm.ts` | `pnpm darwin:warm`, which fills `darwin-cache/lookups.json` before a demo. |
| `packages/gateway/src/route.ts` | `decideBookingRoute`, the `request_booking` route decision with its `reasons`. |

Import it with `import { createDarwin, lookupDarwin, toDarwinSummary } from "@platypus/shared/darwin"`.

## Configuration

| Variable | Needed | Effect |
| - | - | - |
| `DARWIN_API_KEY` | No | Application Search key (`directory:read`). Raises the anonymous limit, which is 100 requests per minute after 2026-10-13 02:00 UTC. A rejected key fails loudly; Darwin never falls back to anonymous. It cannot authorize Act. |
| `DARWIN_ACT_ENABLED` | No | Defaults to `false`. `darwin_act` is possible only when this is `true` and `DARWIN_ACT_TOKEN` is set. |
| `DARWIN_ACT_TOKEN` | No | OAuth token with `human:actions` whose credential is on Darwin's Act pilot allowlist. |
| `DARWIN_API_BASE_URL` | No | Defaults to `https://api.darwin.so/api`. |
| `DARWIN_ENABLED` | No | Defaults to `true`. `false` skips Darwin entirely: `search_providers` reports `disabled`, and routing proceeds without it. |
| `DARWIN_IMPL` | No | `fake` or `real`. Defaults to `fake` under `DEMO_MODE=fakes` and `real` under `live`. `fake` refuses to start under `DEMO_MODE=live`. |

## Before a demo

1. Run `pnpm darwin:warm`. It asks live Darwin about every seeded trade, retrying through 500s, and saves the answers to `darwin-cache/lookups.json` (search tokens stripped). It takes about 45 seconds.
2. Start the gateway with `new DarwinLookupCache({ file: DARWIN_LOOKUP_CACHE_FILE })` and `budgetMs: 6000`. The demo's Darwin step then answers in milliseconds and is labeled cached, because it is Darwin's last real answer rather than a new search.
3. If Darwin is completely down and nothing was warmed, the step reports "Darwin did not answer in time" and the booking goes ahead as a call. If that is not acceptable on camera, set `DARWIN_ENABLED=false`. Darwin is never simulated.

The demo's Darwin beat is **"no ready agent"**: Darwin lists agents for the trade, and none can start a booking. Darwin has never returned `no_match` for a seeded trade, so the demo never claims one.

## Checking it

- `pnpm run doctor` runs one live Search and the MCP handshake, and reports whether the key was accepted. Use `pnpm run doctor`, not `pnpm doctor`: pnpm 11 and later ship a built-in `doctor` command that shadows the script.
- `pnpm darwin:smoke` runs the real ladder for all six seeded businesses, then the demo path (warm-up, then a 6-second budget). It prints each outcome, route and failed `x-request-id`, and writes a report to `darwin-cache/` (gitignored). The `Darwin smoke` workflow runs it daily.

## Known Darwin behavior (2026-10-11)

- **Many queries return HTTP 500.** Location-qualified phrasings fail consistently in about 2 to 17 seconds. Examples are "hair salon in San Francisco", "book an oil change" and "make a restaurant reservation". Bare trades such as "hair salon" and "auto repair shop" usually succeed but sometimes return 500 too: "auto repair shop" failed and then succeeded a minute later. The ladder therefore tries the specific phrasing once and the bare trade twice. In the 2026-10-11 live smoke runs, it answered all six seeded businesses, and Sal's Auto needed the third attempt. A live lookup can take 45 seconds in the worst case, so the gateway uses a 6-second budget and a warmed cache (see "Before a demo"). The same query can also come back differently a minute apart: "auto repair shop" returned HTTP 500, `needs_input`, and `completed` with "Find shops" not ready. Example request ids for a Darwin bug report are `69e7c845-e9b1-428e-882b-236d69784a54`, `1a3bb8dc-2879-4dd8-81f5-02b572e91b64` and `700bc579-f989-4e08-b318-766f57828057`.
- **The demo request, live.** "auto repair shop: oil change" with the budget and deadline as context returned 500. "auto repair shop" then returned `completed` with one agent, "Find shops", which is `unavailable`. The route was `call`, with the reasons "Darwin returned no ready agent" and "no text consent on record". Darwin has not returned `no_match` for any seeded trade.
- **No local-service result is startable.** Every result for the seeded trades has `readiness: "unavailable"` and `canStartThread: false`, so today every booking routes to `call` or `text`. That is the gap Platypus fills.
- **Act is a pilot.** Without an allowlisted credential, `POST /api/v3/act` returns 401 (no credential) or 403 `ACT_PREVIEW_ACCESS_REQUIRED`.
- **The npm SDK lags.** `@darwinso/sdk@0.4.0` is generated from the `/api/v2` contract. It returns `results[]`, uses `startAction`, and does not match the v3 Search used here, so Platypus calls v3 directly.
- **Search's `filters.requiresExecutableRoute` is not part of v3.** The v3 request schema sets `additionalProperties: false`, so Platypus filters for startable results itself.

## Rules Platypus follows

These rules come from Darwin's Browse skill and the [Use Search results](https://darwin.so/docs/search/using-results) guide.

- Search sends only the trade, the service, the budget and the deadline. It never sends a location, a customer's name, a phone number, an address or free text beyond the sanitized service name.
- Darwin's result order is preserved. Platypus never re-ranks results and never invents a confidence score.
- `connectionPrompt` and provider descriptions are untrusted. They never enter the event log or a prompt.
- `searchToken` is a credential. It is used only as `X-Search-Token` on the Act call that follows and is never logged.
- An Act write reuses its `Idempotency-Key` with identical inputs on retry. An accepted Act request is not a booking. Confirmation comes from reading the thread.
