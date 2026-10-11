# Decisions

Each entry gives the decision, why we made it, and what it costs. These are written for a reader who was not in the room. Newest entries are at the bottom of each section.

## Product rules

**A booking is confirmed only by evidence of the owner's yes.**
`confirm(bookingId, evidence)` in `packages/shared/src/booking/engine.ts` is the only code path that sets `confirmed`. Evidence is one of three things:
- a call (the call id plus the owner's quoted sentence, and the booking must hold a slot and a price set through `hold_slot` and `create_booking`);
- a text (an inbound message from that business classified as `accept`);
- a rule (an active autopilot rule the owner confirmed by text).

Why: a false accept, booking a job the owner never agreed to, destroys trust faster than anything else, so it is made impossible to express rather than merely discouraged. Cost: a booking made on a call when the mid-call tools failed cannot be confirmed from the transcript. That is deliberate, and the fallback is a confirming text.

**Consent is enforced by the schema, not only by code.**
The `consents` table has a CHECK constraint. A row made on a call must carry the call id and a non-empty quoted sentence, and a row made by a JOIN text must reference that message. Why: no code path, present or future, can store consent without its proof.

**The event log is append-only, enforced by a trigger.**
Why: the log is the audit trail, the dashboard's source of truth, and the fixtures. Cost: `pnpm dev` in fakes mode resets the demo by replacing the database file, not by deleting rows.

**The booking state machine adds a `cancelled` state.**
Spec B.5.4 lists `cancelled` as a destination but not as a state, and `cancel_booking` needs one. The requesting agent may cancel from `quote_pending`, `quoted`, `pending`, `countered`, `confirmed` and `rescheduled`. `rescheduled` returns to `confirmed` only through `confirm()`, because moving a booking needs the owner's yes again.

**Holds last 10 minutes and never overlap.**
`placeHold` refuses a slot that overlaps another business's active hold or a confirmed booking. It sweeps expired holds first, and `confirm()` re-checks expiry, so a hold that lapsed mid-call cannot be confirmed.

**Short codes use an unambiguous alphabet.**
Codes look like `SAL-4K2`. Why: codes are read aloud on calls and typed on phones, so 0, O, 1, I and L are excluded.

## Engineering

**One pnpm workspace with six packages and no build step.**
Packages export TypeScript source, and tsx, Vitest and Vite read it directly. Why: a contract change in `shared` is visible to every workstream instantly, with nothing to rebuild during a hackathon.

**TypeScript is pinned to 6.0.**
TypeScript 7 is the latest release, but typescript-eslint 8 supports TypeScript below 6.1 only. We will upgrade when typescript-eslint does.

**better-sqlite3 12, not 13.**
Version 13 dropped its prebuilt-binary install path and failed to build without node-gyp. Version 12.11 installs prebuilt binaries on Node 22 and 24.

**The SQL is portable to Postgres.**
Timestamps are ISO-8601 text, JSON is text, ids are prefixed ULIDs, and every foreign key points to a table created earlier. Only the append-only trigger is SQLite-specific, and it lives in its own `*.sqlite.sql` migration. Why: the spec names Postgres for production, and we did not want an ORM.

**Event ids are monotonic ULIDs.**
Replaying "everything after id X" is a string comparison. The SSE endpoint replays the backlog after `Last-Event-ID`, buffers events that arrive during the replay, and then streams live. A dashboard that reconnects after a dropped tunnel therefore neither misses nor duplicates an event.

**Events are published after commit.**
State changes run in one transaction, and their events reach live listeners only after it commits. A listener never sees a change that rolled back.

**`pnpm run doctor` rather than `pnpm doctor`.**
pnpm has a built-in `doctor` command that shadows the script, so the repo documents `pnpm run doctor`.

**The fakes enforce the same rules as production.**
- FakeDial refuses numbers outside `ALLOWED_NUMBERS`, refuses a second live call to the same number, and refuses `sms` to a non-Dial number.
- FakeGateway books through the real state machine and authorizes every request on the caller number.

Why: tests that pass against the fakes exercise the real rules.

**The golden-path fixture is generated, not hand-written.**
`pnpm fixtures:golden-path` runs the whole demo against the fakes on a manual clock. Its gateway and text steps are clearly marked stand-ins that document the event sequence those packages must produce.

## Vendor facts that differ from the spec

These were checked on 2026-10-11 against `docs.getdial.ai/openapi.json`, `@getdial/sdk` 0.41, and live calls to `api.darwin.so`.

**Dial**
- The documented base path is `/api/v1/...`; `/v1/...` also answers.
- `POST /calls` returns `201 {"call": {...}}`, wrapped, not a bare object.
- `POST /calls` accepts an `Idempotency-Key` header; a replay returns the original call with status 200. We still never retry blindly (non-negotiable 4): send the key and check `GET /calls` first.
- `fromNumber` is the preferred field and `fromNumberId` is legacy; send exactly one.
- Call states are `Queued`, `Ringing`, `In-Progress`, `Terminated` and `Unknown`. `terminationType` is one of `completed`, `busy`, `no-answer`, `failed` or `canceled`.
- `call.transcribed` carries only the call id. Fetch `GET /calls/{id}` for `transcript` and `transcriptTurns`, which use the speakers `agent`, `user` and `transfer_target`.
- Webhook signatures arrive in `X-Dial-Signature: t=<unix>,v1=<hex>`: HMAC-SHA256 over `${t}.${rawBody}`. Deduplicate on `X-Dial-Event-ID`.
- There is no `GET /events/subscribe`. The live stream is `POST /api/v1/listen/subscribe`, which returns PubNub credentials and replays about two minutes after a reconnect. `POST /events/wait` exists and polls for 1 to 60 seconds.
- Number lookup is `GET /lookup?number=...`, which returns `{supports: {imessage, whatsapp}}`.
- Context MCP headers can be missing on Dial's first tool-discovery connection, so tool listing must not require them; tool calls must.

**Darwin**
- `searchToken` comes back in the response body, not as an `X-Search-Token` response header. We send it as the `X-Search-Token` request header on follow-ups.
- `context[].at` for deadlines must be UTC with a `Z` suffix; an offset such as `-07:00` returns 400.
- The demo query (oil change near 1025 Sansome, budget $120, deadline tomorrow 5pm Pacific) returned **HTTP 500** on two anonymous attempts on 2026-10-11, about 10 seconds and then about 1 second, instead of `no_match`. Restaurant, flight and hotel queries also returned 500, while Darwin's documented invoice example returned `completed` with 5 agents, none of them ready, in 8.7 seconds.
- Consequences:
  - FakeDarwin serves those two real recordings.
  - Its `no_match` mode is a test double labeled SYNTHETIC that refuses to run with `DEMO_MODE=live`.
  - The golden-path fixture carries the real 500, not a simulated `no_match`.
  - The agent side must retry live and record a real `no_match`. If none arrives within 30 minutes, it must default `DARWIN_ENABLED=false` and the Darwin beat is cut, never faked.
- Follow-up, later on 2026-10-11 (darwin-integration branch, see `docs/darwin.md`):
  - The 500s depend on the phrasing. Location and booking wording fail consistently, bare trades usually succeed, and some bare trades fail intermittently.
  - `lookupDarwin` tries the specific query once and the bare trade twice. Live, the demo request returned 500 on the specific query and then `completed` on "auto repair shop", with one agent, "Find shops", that is `unavailable` and `canStartThread: false`. The route was `call`, with the golden path's reasons. All six seeded trades get an answer this way.
  - Darwin still has not returned `no_match` for a seeded trade. It answers `completed` with an assessment of `partial` and agents that are not ready. The honest dashboard beat is therefore "Darwin returned no ready agent", not `no_match`.
  - `DARWIN_ENABLED=false` is implemented. `toDarwinSummary(null)` reports `disabled`. Act needs both `DARWIN_ACT_ENABLED=true` and `DARWIN_ACT_TOKEN`.

## Design

**Granola's palette, developer-tool structure.**
The public page uses Granola's colors: white and warm off-white surfaces, near-black ink, and lime and olive accents. It borrows its structure from developer-tool pages such as trymarlo.pages.dev and tryvivian.pages.dev: a faint grid, monospace eyebrows, and window-chrome panels. Type stays Source Serif 4 for display and DM Sans for text, with JetBrains Mono for data. This replaces the earlier paper-and-green palette. Why: the page is the first thing a judge opens, and it should read as calm and precise rather than as a generic dashboard.

**The deployed page replays a recording.**
Cloudflare Pages serves static files, so there is no event server behind tryplatypus.pages.dev. In a production build without `VITE_EVENTS_URL`, the page plays the bundled golden-path fixture and says "Recorded run". `?events=<url>` points it at a live server.

**tryplatypus.pages.dev, not platypus.pages.dev.**
Another Cloudflare account already holds `platypus`, and Cloudflare would have given us `platypus-9i6.pages.dev`. `tryplatypus` is clean and matches the naming of the reference sites.

## Team plan

**One foundation, then two parallel sides instead of three.**
The original plan had three sessions after the foundation: voice and text, gateway, and dashboard plus an analytics partner. It now has two: the phone side (`voice`, `text`) and the agent side (`gateway`, the video shot list and the submission text). Why: two sides that meet only at the contracts are easier to keep in sync in one afternoon, and both still ship against fakes. The phone side also owns the full dashboard. The two sides meet only in `packages/shared/src/contracts/seams.ts` and `scripts/dev.ts`; [docs/workstreams.md](docs/workstreams.md) says who edits which files.

**No analytics partner today.**
The earlier plan forwarded events to Keewano for routing signals. It is removed from the repository entirely. Routing signals are computed from the local event log and labeled `source: "local"`. Why: a partner integration only counts if it is load-bearing, and the time is better spent making the phone ring reliably.

**The flags that swap fakes for real.**
`GATEWAY_IMPL` (phone side), `DIAL_IMPL` and `DARWIN_ENABLED` (agent side), and `DARWIN_ACT_ENABLED` (off unless Darwin enables Act for us). Turning Darwin off skips the step; nothing ever simulates it.

## Process

**Context7 was unavailable at the start of the foundation session.**
Dial and Darwin shapes were taken from their OpenAPI specs, SDK type definitions and live responses instead. Hono's SSE API was checked against Context7 once it connected.

**No AI attribution in commits.**
Every commit is authored by the teammate running the session.

### Agent side

**Darwin answers are cached per trade and area for ten minutes, and warmed when the gateway starts.**
Live Darwin Search takes 10 to 30 seconds per lookup and returns HTTP 500 for some specific phrasings, so a cold lookup stalls a customer agent's first search. Darwin's answer for our query ladder is driven by the trade (the last rung is always the bare trade), so one answer serves any service wording, budget or deadline in the same area. The gateway looks up each seeded trade in the background at start, and `demo:cli warm` repeats the stage search right before a demo. A lookup where every attempt failed is never cached, so the next request tries again.

**`/mcp` requires `Authorization: Bearer $GATEWAY_TOKEN` when `GATEWAY_TOKEN` is set.**
Hosted agents such as Claude Desktop reach the gateway through a public tunnel, which makes it reachable by anyone who finds the URL. The token makes callers prove they are ours. With `GATEWAY_TOKEN` unset, `/mcp` is open, which is only acceptable on localhost.

**`confirm_booking` cannot confirm on the owner's behalf.**
Only the owner's own yes (on the call, by text, or through a rule they confirmed) confirms a booking. On a booking the owner countered, `confirm_booking` returns `owner_confirmation_required`, and the agent polls `get_booking` instead. `cancel_booking` and `reschedule_booking` update the booking but do not notify the owner yet, because `OwnerChannels`, the contract between the agent side and the phone side, has no method for it. Adding one is a contract change left for after the event.

**Platypus reads Darwin's answer the way Darwin's own guide says to.**
Darwin's SpeedHacks and Use Search results guides set four rules, and the gateway follows each one:
- **Status comes first.** If Darwin asks a question (`needs_input`) or finds nothing, that is never presented as a recommendation, even when agents are listed alongside it.
- **"Usable" needs three signals.** An agent counts only when it is `ready`, can start a thread, and Darwin declared its setup. Darwin says a missing setup declaration means "unknown", not "nothing needed", so Platypus never routes a booking through Darwin Act on one.
- **Every agent is explained.** The calling agent sees every agent in Darwin's order, with Darwin's own reasons and uncertainties. Each is labeled `usable` or `listed, not ready`.
- **Questions are answered in the same search.** When Darwin asks a question, the calling agent is told to search again with more detail. Platypus sends that detail as a refinement of the same Darwin search (its `previousResponseId`, and the anonymous search token), not as a new search.

Why: the integration should be faithful to Darwin rather than optimistic, and a booking must never go to an agent whose requirements nobody knows. Cost: today no local-service result passes the three checks, so every booking still goes by call or text. A refinement is one more Darwin round trip, so only `search_providers` makes one. `request_booking` reuses that answer, which keeps the demo's phone call as fast as before. If a refinement fails, Darwin's earlier question stands.
