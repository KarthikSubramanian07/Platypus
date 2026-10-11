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

### Phone side

**The server is exposed through a tunnel during the demo, so every route has an owner and a guard.**
`pnpm live` publishes the dev server at a `trycloudflare.com` URL that anyone can find. These are the routes it serves, and what protects each one:

| Route | Who calls it | Guard |
|---|---|---|
| `/health` | Anyone | Says only `ok` and the mode. |
| `/webhooks/dial` | Dial | HMAC-SHA256 signature, compared in constant time, with a five-minute timestamp window. Dedupe uses the event id inside the signed body, and the body is capped at 1 MB before it is read. |
| `/mcp/<CONTEXT_MCP_SECRET>` | Dial's voice agent, mid-call | An unguessable path plus a bearer token, both compared in constant time, with a Host allowlist. Bodies are capped at 64 KB and requests at 120 a minute. Every tool call is authorized against the live call. |
| `/mcp` | Customer agents | `GATEWAY_TOKEN` (agent side). |
| `/events`, `/events/stream`, `/events.jsonl`, `/audit`, `/demo/*` | The team | This machine only, or `DASHBOARD_TOKEN`. See below. |

**The event log, the audit and the demo controls answer only the team.**
Events carry call transcripts, owner replies and consent quotes, and `/demo/owner-reply` can text a "Y" that confirms a booking. These operator routes let a request in only when it comes from this machine, or when it presents `DASHBOARD_TOKEN`:
- **From this machine** means a loopback Host header and a loopback peer, with no Cloudflare tunnel headers. A browser request must also carry a loopback Origin or one listed in `DASHBOARD_ORIGINS` (the deployed site is listed by default).
- **The token** can come as `Authorization: Bearer` or as `?token=`. EventSource and no-cors POSTs cannot set headers, so `/live?events=<tunnel>&token=<value>` forwards the token to that one server, and the page never stores it.

The Origin check matters even on localhost. Without it, any web page open on the presenter's laptop could POST to `http://localhost:8787/demo/owner-reply`. The server listens on 127.0.0.1 only (set `HOST` to change that), so nobody on the venue Wi-Fi can reach it. Without `DASHBOARD_TOKEN`, the tunnel cannot reach these routes at all.

Why not mask the payloads for public viewers instead: a dashboard that hides the transcript and the consent quote shows nothing worth watching. The log already masks phone numbers (`+1415•••0101`) and replaces them with hashes. Those hashes are pseudonyms, not encryption, so the log as a whole stays private.

**Owners are protected by limits per phone and per business, not only per agent.**
Agents name themselves in a header, and an agent can cancel a request and make it again. The gateway's per-agent limits therefore cannot stop one agent from ringing an owner in a loop. Two limits sit below them, and both count rows in the database, so a restart does not reset them:
- One phone number gets at most six calls from us in any hour.
- One business is texted about at most ten new jobs in any hour.

A refused text never turns into a call. The booking stays pending, and the refusal is recorded as an event. Do-not-call, consent, STOP and PAUSE are checked before either limit.

**Agent and owner text is cleaned the same way at every boundary.**
`sanitizeUntrustedText` runs on everything an agent or an owner supplies before it is stored, texted to an owner, or placed into a prompt:
- It folds fullwidth letters to ASCII, so `ｈｔｔｐｓ：／／` reads as `https://`.
- It removes control characters and invisible characters: zero-width spaces, bidi overrides and the byte-order mark.
- It strips links, including domains in any script.
- It caps the length.

The voice agent's instruction also removes quotes, `#`, braces and angle brackets from agent fields, and caps each field at 60 characters, so a field cannot end a quoted line or fake a heading. Claude prompts put untrusted text inside tags after escaping `<` and `>`, including in transcript mining. Without that escaping, an owner who says "`</transcript>`" would escape the data block.

**The site sends a strict Content-Security-Policy.**
`public/_headers` allows only this origin's scripts and styles, plus inline style attributes for CSS variables. It allows self-hosted fonts, and event streams only to this site, `localhost` or `*.trycloudflare.com`. A named tunnel on another domain must be added to `connect-src`. The dashboard builds DOM only with `textContent`, and a test fails if any source file uses an HTML-parsing sink.

**The event-log auditor is written twice, in TypeScript and in Rust, and CI fails if they disagree.**
The auditor is the only thing that checks the non-negotiables after the fact, and a bug in it would pass bad logs silently. `crates/platypus-audit` re-implements rules R1 to R8 independently, and `pnpm ci:audit-diff` runs both on more than a thousand logs: the golden path, the golden path with one targeted corruption each, hand-built scenarios, and seeded random logs. Both must agree on `ok`, on every (rule, severity, event id), on every rule's counts and on the stats. The harness also checks that the constants the Rust side copied (the disclosure, the state machine, statuses, actors, exempt kinds, the do-not-call threshold, the types that need a reason) still match the TypeScript sources. Why Rust and not a second TypeScript file: a second reading in the same language tends to repeat the same mistakes, while a different type system and different defaults make different ones. The harness already found one: the TypeScript stats counters broke on keys such as `toString` and `__proto__`; that is fixed in its own commit, and those keys stay in the corpus.

**Accepted risks.**
- Webhook dedupe is in memory. A signed request replayed within its five-minute window after a restart is processed again. Inbound messages are still deduped by Dial's message id (a UNIQUE column), and call events are idempotent.
- `DASHBOARD_TOKEN` in a URL can end up in browser history and in the tunnel's logs. Use a fresh token for each event, and do not reuse `GATEWAY_TOKEN`.
- The gateway compares `GATEWAY_TOKEN` with an early length check, which reveals the token's length but nothing else. The gateway is the agent side's package, and a random token of 16 or more characters makes this harmless.
