# How Platypus is being built

The build is split so that people can work in parallel without blocking each other. Every package talks only to `@platypus/shared` (the contracts, the event log and the booking state machine) and ships against a fake of whatever it depends on. Swapping a fake for the real implementation is one environment flag.

## The three phases

| Phase | Owner | Packages | Builds against | Done when |
| --- | --- | --- | --- | --- |
| **Foundation** (complete) | Karthik | `shared`, the repository, CI, the dashboard shell | nothing | `pnpm test` is green, `pnpm dev` replays the golden path into the dashboard, and the contracts are on `main` |
| **Phone side** | Karthik | `voice`, `text` | `FakeGateway` until the real gateway lands (`GATEWAY_IMPL=fake\|real`) | A real call to a teammate's phone books through the mid-call tools, consent and the best cell are stored with the quoted sentence, a real reply of Y confirms within 5 seconds, and STOP unlists with no model call |
| **Agent side** | Eddy | `gateway`, `docs/video.md`, `docs/submission.md` | `FakeDial` and `FakeDarwin` until the phone side and a live Darwin search land (`DIAL_IMPL=fake\|real`, `DARWIN_ENABLED`) | Claude Desktop runs the golden path end to end against the fakes with every event on the dashboard, the live Darwin search returns in under 6 seconds or is switched off, and the video shot list and submission text are approved |

Integration comes last: set every flag to real, run `pnpm demo:reset`, and run the golden path three times from Claude Desktop with the real phone. Anything that fails twice goes back to its fake, and the video and the stage both say so.

## The phone side

- **`voice/call`** places the outbound call with Dial. The disclosure sentence is hard-coded before the model can speak. The script is five turns: disclose; price and slot; confirm the vehicle and book; ask for consent; ask for the best cell to text. It repeats numbers back, uses `en-US`, and caps the call at 120 seconds (110 in `DEMO_MODE`). It never retries blindly: it checks the call list for a live call before any second attempt. After the call, the transcript turns are mined for prices, lead times, hours and the consent sentence. Each finding becomes an event with a confidence, never a confirmation.
- **`voice/context-mcp`** is a public MCP server, behind `PUBLIC_BASE_URL` on an unguessable path, that exposes exactly the `VoiceTools` contract to Dial's voice agent during a call. Every request is authorized on `X-Dial-User-Number` with `authorizeVoiceRequest`. `pnpm dial:register-mcp` registers it with Dial. Every tool call is logged as a `voice.tool_called` event so the dashboard can draw the mid-call timeline.
- **`text/inbound`** has two consumers with the same deduplication by provider message id: the signed Dial webhook (acknowledged in under 200 ms and processed asynchronously) and the Dial event stream, so the demo survives a dropped tunnel. STOP, HELP and PAUSE are handled before any model call.
- **`text/classify`** applies deterministic rules first (Y, N, STOP, HELP, PAUSE, UNDO, times, prices), then Claude extraction. Below the confidence threshold, it asks the owner a clarifying question. An eval set of at least 40 labeled replies fails the build if the deterministic classes score under 95%.
- **`text/outbound`** sends on `TEXT_CHANNEL` (`imessage`, `whatsapp` or `dial`), checks Dial's number lookup before the first message, and falls back to the cell from `set_text_number`. If no rail reaches the owner, it emits a `needs_call` routing event instead of sending.
- **Demo extras:** a kill switch that ends the live call, "resend last text", and "replay last call".

## The agent side

- **`gateway/mcp`** implements exactly the `GatewayTools` contract over streamable HTTP and stdio. Tool descriptions say that results are asynchronous, tell the client to poll `get_booking`, and spell out the typed outcome vocabulary. Every write carries an idempotency key, rate limits apply per agent, and agent text is untrusted. The README will carry a Claude Desktop config snippet.
- **`gateway/darwin`** calls Darwin Search v3 with budget and deadline context and `maxResults` 5. It works anonymously and keeps the search token for follow-ups. It branches on the result:
  - `completed`: show agents in Darwin's order, and route `darwin_act` when one is ready and can start a thread.
  - `needs_input`: pass Darwin's question back to the calling agent.
  - `no_match`: show the reason, and route to a call or a text depending on consent.

  It never presents an empty list as a recommendation. The last live response is cached and labeled "cached" if it is ever shown. Act, the beta handoff, sits behind `DARWIN_ACT_ENABLED`, and an accepted thread is not treated as a completed job.
- **`gateway/routing`** has `request_booking` choose the route: `darwin_act` if a ready agent exists, `text` if consent exists on `TEXT_CHANNEL`, otherwise `call`. It emits `booking.pending` with the route and the reasons. `search_providers` returns routing signals for each business.
- **Docs:** `docs/video.md` holds the five-minute video shot list with timings, screens, speakers and captions, plus a recording checklist. `docs/submission.md` drafts the HackerSquad submission. `pnpm demo:replay` shows a clean run on camera.

## The dashboard

The foundation ships a shell: the live event log with replay. The full dashboard adds these regions:
- a Darwin panel;
- a call panel with the mid-call tool timeline and transcript turns;
- business cards that flip from PHONE-ONLY to TEXT-ENABLED;
- the supply table;
- an owner-phone panel that renders texts as message bubbles;
- a Cloudflare Pages deployment.

The current prompts do not assign an owner for this work yet.

## Flags

| Flag | Values | Default | Effect |
| --- | --- | --- | --- |
| `DEMO_MODE` | `fakes`, `live` | `fakes` | Fakes need no external service; FakeDarwin refuses to run in `live` |
| `GATEWAY_IMPL` | `fake`, `real` | `fake` | Which `VoiceTools` the phone side calls |
| `DIAL_IMPL` | `fake`, `real` | `fake` | Which telephony the agent side drives |
| `DARWIN_ENABLED` | `true`, `false` | `true` until proven otherwise | Off means the Darwin step is skipped, never simulated |
| `DARWIN_ACT_ENABLED` | `true`, `false` | `false` | Only if Darwin enables Act for us |
| `TEXT_CHANNEL` | `imessage`, `whatsapp`, `dial` | `imessage` | Owner text rail; never `sms` before 10DLC |

## Changing a contract

Contracts live in `packages/shared/src/contracts`. A change goes through a pull request that the other side reviews in five minutes, followed by `pnpm contracts:export`. A test fails if the exported JSON Schema is stale.
