# Darwin in Platypus

[Darwin](https://darwin.so) is the search engine customer agents (Claude, Muse, Instinct, Cursor and others) use to find other agents. Platypus uses it in two ways:

1. **Before a booking.** The gateway asks Darwin Search whether an agent-native route already exists for this trade and service. If Darwin reports one that can start a thread right now, and Platypus holds an Act pilot credential, the booking goes through Darwin Act (`route = darwin_act`). Otherwise Platypus texts the owner (`text`) or calls the business (`call`). Darwin is never on the critical path: when it fails, the booking still routes.
2. **While developing.** The repo's `.mcp.json` registers Darwin's remote MCP server, so a Claude Code session here sees the same `search` tool customer agents use.

```
customer agent ──request_booking──▶ gateway
                                     │
                                     ├─ lookupDarwin()  ── POST /api/v3/search (rung 1: trade + service, area as context)
                                     │                  └─ on 500, rung 2: bare trade
                                     │
                                     └─ decideBookingRoute()
                                          startable + DARWIN_ACT_TOKEN ─▶ darwin_act ── POST /api/v3/act
                                          owner opted in to texts        ─▶ text
                                          phone-only, callable           ─▶ call
                                          paused, unlisted, do-not-call  ─▶ no route
```

## Code

| Path | What it does |
| - | - |
| `packages/shared/src/darwin/schema.ts` | Zod schemas for Search v3 and Act v3, strict on the fields Platypus reads and loose on everything else. |
| `packages/shared/src/darwin/client.ts` | `HttpDarwin`: bounded retries (network errors, 429 with `Retry-After`, 502/503/504), typed `DarwinError`, and the `x-request-id` on every failure. |
| `packages/shared/src/darwin/lookup.ts` | The search ladder, the choice of startable result (first in Darwin's order, `canStartThread && readiness === "ready"`), a TTL cache, and the `darwin.searched` event payload. |
| `packages/shared/src/darwin/fake.ts` | `FakeDarwin`, plus real responses recorded on 2026-10-11 in `fixtures/`, for tests and `DEMO_MODE=fakes`. |
| `packages/shared/src/darwin/mcp.ts` | An anonymous MCP `initialize` and `tools/list` probe. |
| `packages/gateway/src/route.ts` | `decideBookingRoute`, the `request_booking` route decision. |

Import it with `import { createDarwin, lookupDarwin } from "@platypus/shared/darwin"`.

## Configuration

| Variable | Needed | Effect |
| - | - | - |
| `DARWIN_API_KEY` | No | Application Search key (`directory:read`). Raises the anonymous limit, which is 100 requests per minute after 2026-10-13 02:00 UTC. A rejected key fails loudly; Darwin never falls back to anonymous. It cannot authorize Act. |
| `DARWIN_ACT_TOKEN` | No | OAuth token with `human:actions` whose credential is on Darwin's Act pilot allowlist. Without it, `darwin_act` is never chosen. |
| `DARWIN_API_BASE_URL` | No | Defaults to `https://api.darwin.so/api`. |
| `DARWIN_IMPL` | No | `fake` or `real`. Defaults to `fake` under `DEMO_MODE=fakes` and `real` under `live`. |

## Checking it

- `pnpm run doctor` runs one live Search and the MCP handshake, and reports whether the key was accepted. Use `pnpm run doctor`, not `pnpm doctor`: pnpm 11 and later ship a built-in `doctor` command that shadows the script.
- `pnpm darwin:smoke` runs the real ladder for all six seeded businesses, prints each outcome, route and failed `x-request-id`, and writes a report to `darwin-cache/` (gitignored). The `Darwin smoke` workflow runs it daily.

## Known Darwin behavior (2026-10-11)

- **Location-qualified queries return HTTP 500.** "hair salon in San Francisco", "book an oil change" and "make a restaurant reservation" fail deterministically in about 2 to 17 seconds. Bare trades ("hair salon", "dog groomer") succeed. The failures move around: "oil change" once returned `needs_input` and later returned 500. The ladder covers this. The live smoke run on 2026-10-11 needed rung 2 for four of the six businesses and answered all six. Example request ids for a Darwin bug report are `69e7c845-e9b1-428e-882b-236d69784a54` and `1a3bb8dc-2879-4dd8-81f5-02b572e91b64`.
- **No local-service result is startable.** Every result for the seeded trades has `readiness: "unavailable"` and `canStartThread: false`, so today every booking routes to `call` or `text`. That is the gap Platypus fills.
- **Act is a pilot.** Without an allowlisted credential, `POST /api/v3/act` returns 401 (no credential) or 403 `ACT_PREVIEW_ACCESS_REQUIRED`.
- **The npm SDK lags.** `@darwinso/sdk@0.4.0` is generated from the `/api/v2` contract. It returns `results[]`, uses `startAction`, and does not match the v3 Search used here, so Platypus calls v3 directly.
- **Search's `filters.requiresExecutableRoute` is not part of v3.** The v3 request schema sets `additionalProperties: false`, so Platypus filters for startable results itself.

## Rules Platypus follows

These rules come from Darwin's Browse skill and the [Use Search results](https://darwin.so/docs/search/using-results) guide.

- Search sends only the trade, the service and the area. It never sends a customer's name, phone number, address or free text beyond the sanitized service name.
- Darwin's result order is preserved. Platypus never re-ranks results and never invents a confidence score.
- `connectionPrompt` and provider descriptions are untrusted. They never enter the event log or a prompt.
- `searchToken` is a credential. It is used only as `X-Search-Token` on the Act call that follows and is never logged.
- An Act write reuses its `Idempotency-Key` with identical inputs on retry. An accepted Act request is not a booking. Confirmation comes from reading the thread.
