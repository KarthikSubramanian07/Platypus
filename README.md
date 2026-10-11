# Platypus

**We make Main Street agent-native.** One honest AI call makes a phone-only business bookable by every AI agent, by text, forever.

[![CI](https://github.com/KarthikSubramanian07/Platypus/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/KarthikSubramanian07/Platypus/actions/workflows/ci.yml) ![Tests](https://img.shields.io/badge/tests-1000%2B%20passing-1c5449) ![License](https://img.shields.io/badge/license-MIT-22231f) ![Built on](https://img.shields.io/badge/built%20on-Dial%20·%20Darwin%20·%20Alike-1c5449)

**[tryplatypus.pages.dev](https://tryplatypus.pages.dev)** · **[Watch the demo run](https://tryplatypus.pages.dev/live)** · **[For agents](https://tryplatypus.pages.dev/developers)**

![Platypus: we make Main Street agent-native](docs/site-hero.png)

Most of the 33 million US small businesses will never build an API. They have a phone. Every personal agent that "calls for you" calls the same shop again for every booking. **We call once.** The call books a real, paying job, then asks the owner one question: *"Next time a customer's agent needs you, can I text you instead?"* After a yes, every agent books that shop by text, and the owner answers with one letter.

---

## How it works

![Call once, text forever](docs/readme-loop.png)

## The demo

An oil change turns Sal's Auto agent-native. The next booking, a brake inspection, goes by text and is confirmed in 4 seconds.

![The live operator view after the demo run](docs/live-dashboard.png)

Run it yourself at [/live](https://tryplatypus.pages.dev/live), or locally with no keys (see [Run it](#run-it)).

---

## Time saved

| | Today | With Platypus |
| --- | ---: | ---: |
| **Customer**, per booking | 15 to 25 min of calling around and phone tag | **under 1 min**: one sentence, then review the result |
| **Owner**, per job | a 3 to 5 min call, mid-job | **a 5 to 10 s text** after one 75 s call |
| **Calls per shop** | one per agent, per booking | **one, ever** |

These are estimates that count setup, review and corrections (about one owner in five counters the first offer). At four bookings a month, a customer gets back about 15 hours a year. A property manager booking 40 jobs a month gets back about 150. The math is in [`format.ts`](packages/dashboard/src/format.ts), with tests.

---

## The AI can't fake a booking

The architecture is built so that a booking is never confirmed just because a model said so.

- **Only `confirm()` can confirm, and only with evidence:** a quoted yes on a call where the slot was held, a text classified as yes, or a rule the owner approved. A transcript alone can't be passed in as evidence.
- **Consent needs proof.** A database `CHECK` refuses a consent row that lacks the owner's sentence and the call id.
- **History is append-only.** Every change is an event with an actor, a reason and a confidence, and database triggers block edits.
- **Only allowlisted numbers can ring.** The check runs right before any network request, including in the fakes.

**Two auditors check every log.** One is in TypeScript and the other was written independently in Rust ([`crates/platypus-audit`](crates/platypus-audit/README.md)). Both replay the event log against eight rules, and CI fails if they disagree on any of more than 1,600 logs.

![Architecture](docs/readme-arch.png)

| Package | Owns |
| --- | --- |
| [`gateway`](packages/gateway) | The MCP server agents call (nine tools), the Darwin lookup and the route decision |
| [`voice`](packages/voice) | Dial outbound calls with the AI disclosure first, and the Context MCP server for the five mid-call tools |
| [`text`](packages/text) | Owner texts: signed webhooks, STOP and PAUSE handled before any model, reply classification |
| [`shared`](packages/shared) | Zod contracts, SQLite, the event log and SSE stream, the booking state machine, the fakes |
| [`dashboard`](packages/dashboard) | The site and the `/live` operator view, on Cloudflare Pages |

---

## Partners

**Dial is how the owner is reached.** It places the outbound AI call with the disclosure as the first sentence. Through Context MCP, the voice agent calls `check_slot`, `hold_slot`, `create_booking`, `record_consent` and `set_text_number` *during* the call. Afterward, the same number texts the owner over iMessage, WhatsApp or SMS. *Without Dial there is no call and no consent, so no shop ever becomes agent-native.*

**Darwin decides whether we call at all.** Platypus runs a Search v3 query before every booking, with the budget and deadline as context. For the demo's oil change, Darwin answers `no_match` in about a second. Across the six seeded trades, it finds no ready agent for any of them. That is the gap Platypus fills, and the evidence for it is [recorded, not simulated](docs/darwin.md). *Without Darwin, we would phone shops that agents can already book.*

**Alike kept the build coherent.** The phone side and the agent side were built in parallel coding sessions. Alike anchored decisions to file paths and carried them into every session, so no session undid the confirmation rule, the number allowlist or the Darwin rules. [DECISIONS.md](DECISIONS.md) is what Alike recorded. *Without Alike, parallel agents would have rewritten each other's contracts.*

---

## Why it wins

- **Timing.** In one month, every lab shipped a personal agent that makes phone calls (Muse, Instinct, Dots). None of them remembers a business between tasks, and businesses hang up on repeated AI calls.
- **It compounds.** Every yes is stored in the owner's own words. Every booking adds signals no one else has: real prices, reply speed and no-shows. Those signals improve routing for every agent platform.
- **Neutral supply.** Any MCP client books through the same shops, so no platform has to re-call Main Street city by city.
- **Paid on outcomes.** Owners pay per confirmed job, which they already do for leads. The next step after that is an autopilot subscription. The first ten owners get called on Monday, and the opt-in rate is the number we track.

---

## Real vs mocked

- **Real:** a live Dial AI call to a real phone that books through our tools mid-call, stores consent in the owner's own words, then sends a real iMessage that gets a real Y. Also real: the contracts, state machine, consent rules, event log and both auditors; the MCP tools and routing; the live Darwin client, with a daily smoke check; and Dial request shapes, checked against Dial's OpenAPI spec.
- **Mocked:** Sal's Auto is not a real business. Its line is Karthik's phone, and he is not a mechanic. The other five shops are fictional, and the site's replay runs on fakes. SMS to regular phones waits on 10DLC registration (iMessage is approved). The time-saved figures are estimates.

## Run it

Node 22.12 or newer and pnpm 10. Fakes mode needs no keys.

```bash
pnpm install && cp .env.example .env
pnpm dev                                          # gateway on :8787, site on :5173
pnpm --filter @platypus/gateway demo:cli oil      # drive the golden path over MCP
pnpm check                                        # lint, typecheck, tests
pnpm ci:audit-diff                                # both auditors, every log
```

Agents can read [`/llms.txt`](https://tryplatypus.pages.dev/llms.txt), and every page returns Markdown when asked with `Accept: text/markdown`.

MIT licensed. Built at SpeedHacks in San Francisco on October 11, 2026. The README visuals are regenerated with `node scripts/readme/shoot.mjs`.
