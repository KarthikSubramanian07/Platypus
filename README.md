# Platypus: AI booking for phone-only businesses

**We make Main Street agent-native.** One honest AI call makes any phone-only business bookable by every AI agent. Call once, agent-native forever.

[![CI](https://github.com/KarthikSubramanian07/Platypus/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/KarthikSubramanian07/Platypus/actions/workflows/ci.yml) [![CodeQL](https://github.com/KarthikSubramanian07/Platypus/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/KarthikSubramanian07/Platypus/actions/workflows/codeql.yml) ![Tests](https://img.shields.io/badge/tests-800%20passing-1c5449) ![License](https://img.shields.io/badge/license-MIT-22231f) ![Built on](https://img.shields.io/badge/built%20on-Dial%20·%20Darwin%20·%20Alike-1c5449)

**Live:** [tryplatypus.pages.dev](https://tryplatypus.pages.dev) replays the demo in your browser. **Operator view:** [tryplatypus.pages.dev/live](https://tryplatypus.pages.dev/live).

![Platypus: we make Main Street agent-native](docs/site-hero.png)

Your agent can book a flight. It can't book Main Street. Most of the 33 million US small businesses will never build an API or an agent. They have a phone.

Platypus calls a phone-only business **once**. The call says it's an AI in its first sentence, books a paying job through our own tools while the owner is on the line, and asks: *"Next time a customer's agent needs you, can I text you instead?"* A yes is stored in the owner's own words. From then on, every agent books that business by text, and the owner answers with one letter.

> **Everyone else calls a business every time. We call it once.** Consent compounds; calls don't.

---

## For judges

| Criterion | Weight | Where to look |
| --- | --- | --- |
| **Time saved** | 40% | [Time saved](#time-saved): 15 to 25 minutes of calling around becomes under a minute of attention, setup, review and corrections counted. The owner's 3 to 5 minute call becomes a 5 to 10 second text. |
| **Technical execution** | 25% | [Guarantees](#guarantees-the-code-enforces): an evidence-only `confirm()`, consent the database refuses without proof, an append-only event log, a phone allowlist at the lowest layer. 800 tests, coverage floors, CodeQL and a secret scan on every push. |
| **Market and path** | 15% | [Why it compounds](#why-it-compounds) and [Business model](#business-model-and-whats-next): home services first, owners pay per confirmed job, ten real owners on Monday. |
| **Originality** | 10% | The call is the onboarding, not the product. It books a real job *and* converts the business in the same 75 seconds. Nobody installs anything. |
| **Product and demo** | 10% | [The demo](#the-demo), the [live page](https://tryplatypus.pages.dev), and `pnpm dev` with no keys. |
| **Best use of Dial, Darwin, Alike** | prizes | [Partners](#partners): each one is load-bearing, with what breaks without it. |

---

## The demo

One oil change makes a shop agent-native, then a second booking goes by text.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#f9f8f3', 'primaryTextColor': '#22231f', 'primaryBorderColor': '#1c5449', 'lineColor': '#1c5449', 'secondaryColor': '#cfe6dc', 'tertiaryColor': '#f4f1ea', 'clusterBkg': '#f4f1ea', 'clusterBorder': '#9fd3c1', 'actorBkg': '#cfe6dc', 'actorTextColor': '#22231f', 'actorBorder': '#1c5449', 'actorLineColor': '#9fd3c1', 'noteBkgColor': '#cfe6dc', 'noteBorderColor': '#1c5449', 'signalColor': '#1c5449', 'labelBoxBkgColor': '#f9f8f3', 'xyChart': {'plotColorPalette': '#1c5449'}}}}%%
sequenceDiagram
    autonumber
    actor C as Customer
    participant A as Claude (MCP client)
    participant G as Platypus gateway
    participant D as Darwin Search v3
    participant V as Dial voice + Context MCP
    actor O as Shop owner
    C->>A: "Oil change tomorrow afternoon, under $120"
    A->>G: search_providers, then request_booking
    G->>D: Is there already an agent for this?
    D-->>G: Listed agents, none ready
    Note over G: No ready agent, no text consent: route = call
    G->>V: Place the call
    V->>O: "Hi, I'm an AI assistant calling for a customer..."
    V->>G: check_slot, hold_slot, create_booking (mid-call)
    O->>V: "Yeah, text me next time."
    V->>G: record_consent (quoted sentence + call id)
    Note over G: Shop flips PHONE-ONLY to TEXT-ENABLED
    A->>G: get_booking
    G-->>A: Booked: Sal's Auto, tomorrow 2:00pm, $89, SAL-4K2
    C->>A: "Also book a brake inspection there next week"
    A->>G: request_booking
    G->>O: One text, no call
    O->>G: "Y"
    Note over G: confirm(evidence: text). Confirmed in seconds.
```

![The event log replaying the golden path](docs/dashboard-shell.png)

What's real and what's mocked is in [Real vs mocked](#real-vs-mocked).

---

## Time saved

Transparent estimates, with setup, review and corrections counted. Opt-in rate and reply seconds are measured live on the dashboard.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#f9f8f3', 'primaryTextColor': '#22231f', 'primaryBorderColor': '#1c5449', 'lineColor': '#1c5449', 'secondaryColor': '#cfe6dc', 'tertiaryColor': '#f4f1ea', 'clusterBkg': '#f4f1ea', 'clusterBorder': '#9fd3c1', 'actorBkg': '#cfe6dc', 'actorTextColor': '#22231f', 'actorBorder': '#1c5449', 'actorLineColor': '#9fd3c1', 'noteBkgColor': '#cfe6dc', 'noteBorderColor': '#1c5449', 'signalColor': '#1c5449', 'labelBoxBkgColor': '#f9f8f3', 'xyChart': {'plotColorPalette': '#1c5449'}}}}%%
xychart-beta horizontal
    title "Minutes of attention per booking (estimate)"
    x-axis ["Calling around today", "With Platypus"]
    y-axis "Minutes" 0 --> 22
    bar [20, 0.8]
```

| | Today | With Platypus |
| --- | ---: | ---: |
| Customer, per booking | 15 to 25 min calling three shops, phone tag, confirming | 0.8 min: one sentence, review the typed result, one correction in five |
| Owner, per job | 3 to 5 min on the phone, mid-job | 5 to 10 s to reply Y, after one 75 s call |
| Calls per shop | one per agent, per booking | one, ever |

Four bookings a month gives a customer back about 15 hours a year; a property manager booking 40 trade jobs a month, about 150. The math is in [`format.ts`](packages/dashboard/src/format.ts), with tests.

![Time-saved ledger and calculator](docs/site-time-saved.png)

---

## Why it compounds

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#f9f8f3', 'primaryTextColor': '#22231f', 'primaryBorderColor': '#1c5449', 'lineColor': '#1c5449', 'secondaryColor': '#cfe6dc', 'tertiaryColor': '#f4f1ea', 'clusterBkg': '#f4f1ea', 'clusterBorder': '#9fd3c1', 'actorBkg': '#cfe6dc', 'actorTextColor': '#22231f', 'actorBorder': '#1c5449', 'actorLineColor': '#9fd3c1', 'noteBkgColor': '#cfe6dc', 'noteBorderColor': '#1c5449', 'signalColor': '#1c5449', 'labelBoxBkgColor': '#f9f8f3', 'xyChart': {'plotColorPalette': '#1c5449'}}}}%%
flowchart LR
    A[Agent asks for a booking] --> B{Owner already<br/>said yes?}
    B -- no --> C[One honest call<br/>books a paying job]
    C --> D[Owner: 'Yeah, text me']
    D --> E[(Consent graph<br/>quote + call id)]
    B -- yes --> F[One text, one letter]
    E --> F
    F --> G[(Signals from real bookings<br/>price, reply speed, no-shows)]
    G --> H[Better routing for<br/>every agent platform]
    H --> A
```

- **The consent graph.** Every yes, in the owner's own words, with the call it came from. Nobody else holds it.
- **Signals only real bookings create.** What a shop really charges, how fast it replies, whether it shows up. Nothing to game.
- **Neutral by design.** Muse, Dots, Claude and Instinct route through the same supply instead of each re-calling the same shop.
- **Jobs, not leads.** Owners pay only for confirmed bookings.

<details>
<summary>Why now, and the landscape</summary>

In one month every lab shipped a personal agent, then added phone calls: Muse (Sep 8), Instinct Concierge (Sep 16), OpenAI Dots (Sep 29), and the Personal Agent Protocol (Oct 6), which only covers businesses with a website, an API or an agent. Businesses hang up on AI calls; Meta put human contractors on Muse's calls for exactly that reason.

| Category | Examples | What they do | Platypus |
| --- | --- | --- | --- |
| Personal agents that call | Muse, Instinct, Google Ask for Me | Call for one task, every time. Nothing persists. | Calls once to onboard, then texts. Neutral supply for all of them. |
| AI receptionists | Rosie, Yelp Host | Answer human calls for the business. | Serves the agents calling in. |
| Marketplaces | Yelp, Thumbtack, Angi | Own discovery; gate or charge agents. | Open to every agent; the business keeps its customer. |
| Agent standards | PAP, UCP, ACP | Businesses with systems. | The adapter for everyone without one. |
| Booking software | ServiceTitan, Jobber | Businesses that adopt software. | The ones that never will. |

Google's call is a lookup. Ours is onboarding.
</details>

---

## How it works

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#f9f8f3', 'primaryTextColor': '#22231f', 'primaryBorderColor': '#1c5449', 'lineColor': '#1c5449', 'secondaryColor': '#cfe6dc', 'tertiaryColor': '#f4f1ea', 'clusterBkg': '#f4f1ea', 'clusterBorder': '#9fd3c1', 'actorBkg': '#cfe6dc', 'actorTextColor': '#22231f', 'actorBorder': '#1c5449', 'actorLineColor': '#9fd3c1', 'noteBkgColor': '#cfe6dc', 'noteBorderColor': '#1c5449', 'signalColor': '#1c5449', 'labelBoxBkgColor': '#f9f8f3', 'xyChart': {'plotColorPalette': '#1c5449'}}}}%%
flowchart TB
    subgraph Agents["Customer agents"]
        direction LR
        CL[Claude] ~~~ MU[Muse] ~~~ ANY[any MCP client]
    end
    subgraph GW["gateway"]
        direction LR
        T["9 MCP tools · idempotency keys · rate limits"] --> R{"decideBookingRoute"} --> DW[("Darwin Search v3")]
    end
    subgraph PH["phone side, on Dial"]
        direction LR
        VO["voice: outbound AI call, Context MCP with 5 mid-call tools"] ~~~ TX["text: signed webhooks, STOP / HELP / PAUSE first"]
    end
    subgraph SH["shared"]
        direction LR
        CF["confirm() evidence gate"] --> SM["booking state machine"] --> EV[("append-only event log")] --> SSE[["SSE stream"]]
    end
    DB["dashboard and /live"]

    Agents -- "MCP" --> GW
    GW -- "call, or text if the owner opted in" --> PH
    PH -- "every change is an event" --> SH
    SH --> DB
```

| Package | What it owns |
| --- | --- |
| [`shared`](packages/shared) | Zod contracts (exported as JSON Schema), SQLite with portable SQL, the append-only event log and SSE stream, the booking state machine, the Darwin client, and the fakes |
| [`gateway`](packages/gateway) | The MCP server agents talk to: nine tools, Darwin search, the route decision, a demo CLI |
| [`voice`](packages/voice) | Dial outbound calls with the disclosure hard-coded first, and the Context MCP server for the five mid-call tools |
| [`text`](packages/text) | Owner texts: signed webhooks, STOP/HELP/PAUSE before any model, reply classification |
| [`dashboard`](packages/dashboard) | The public site and the `/live` operator view, deployed to Cloudflare Pages |

<details>
<summary>Routing and the booking state machine</summary>

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#f9f8f3', 'primaryTextColor': '#22231f', 'primaryBorderColor': '#1c5449', 'lineColor': '#1c5449', 'secondaryColor': '#cfe6dc', 'tertiaryColor': '#f4f1ea', 'clusterBkg': '#f4f1ea', 'clusterBorder': '#9fd3c1', 'actorBkg': '#cfe6dc', 'actorTextColor': '#22231f', 'actorBorder': '#1c5449', 'actorLineColor': '#9fd3c1', 'noteBkgColor': '#cfe6dc', 'noteBorderColor': '#1c5449', 'signalColor': '#1c5449', 'labelBoxBkgColor': '#f9f8f3', 'xyChart': {'plotColorPalette': '#1c5449'}}}}%%
flowchart TD
    A[request_booking] --> B{Business paused,<br/>unlisted or do-not-call?}
    B -- yes --> X[No route: never contacted]
    B -- no --> C{Darwin: a ready agent<br/>that can start now?}
    C -- "yes, and Act is enabled" --> DA[darwin_act]
    C -- no --> D{Owner consented<br/>to texts?}
    D -- yes --> T[text: one message, reply Y/N/time]
    D -- no --> CA[call: one honest AI call]
    CA --> E{"Owner: 'Yeah, text me'"}
    E -- yes --> F[consent stored with quote + call id<br/>business is now text-enabled]
```

`confirmed` can be entered only through `confirm()`, with evidence; `transition()` refuses it. `completed`, `no_show`, `disputed`, `declined`, `expired` and `cancelled` are terminal. This is [`TRANSITIONS`](packages/shared/src/booking/machine.ts), drawn:

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#f9f8f3', 'primaryTextColor': '#22231f', 'primaryBorderColor': '#1c5449', 'lineColor': '#1c5449', 'secondaryColor': '#cfe6dc', 'tertiaryColor': '#f4f1ea', 'clusterBkg': '#f4f1ea', 'clusterBorder': '#9fd3c1', 'actorBkg': '#cfe6dc', 'actorTextColor': '#22231f', 'actorBorder': '#1c5449', 'actorLineColor': '#9fd3c1', 'noteBkgColor': '#cfe6dc', 'noteBorderColor': '#1c5449', 'signalColor': '#1c5449', 'labelBoxBkgColor': '#f9f8f3', 'xyChart': {'plotColorPalette': '#1c5449'}}}}%%
stateDiagram-v2
    [*] --> quote_pending
    quote_pending --> quoted
    quote_pending --> declined
    quoted --> pending
    pending --> confirmed: confirm(evidence)
    pending --> countered
    pending --> declined
    countered --> confirmed: confirm(evidence)
    confirmed --> rescheduled
    rescheduled --> confirmed: confirm(evidence)
    confirmed --> completed
    confirmed --> no_show
    confirmed --> disputed
    quote_pending --> expired
    quoted --> expired
    pending --> expired
    countered --> expired
    pending --> cancelled
    countered --> cancelled
    confirmed --> cancelled
    rescheduled --> cancelled
```
</details>

---

## Guarantees the code enforces

> A booking is never confirmed because the AI said so. Curse you, Hallucinat-inator!

![The four guarantees, each with the code that enforces it](docs/site-guarantees.png)

- **Only `confirm()` can confirm, and only with evidence**: a quoted yes on a call where the slot was held, a text classified as yes, or a rule the owner approved. A transcript alone cannot be expressed as evidence.
- **Consent needs its proof.** A `CHECK` constraint refuses a consent row without the owner's sentence and the call id.
- **Every change is an append-only event** with an actor, a reason and a confidence, enforced by database triggers.
- **Only allowlisted numbers can ring**, checked immediately before any network request, including in the fakes.
- Agent and owner text is data, not instructions. Mid-call tools are authorized per request. Darwin is never simulated in live mode.

---

## Partners

![Dial, Darwin and Alike](docs/site-partners.png)

**Dial: the owner's channel.** Outbound AI voice with the disclosure as sentence one. Context MCP lets the voice agent call `check_slot`, `hold_slot`, `create_booking`, `record_consent` and `set_text_number` *during* the call, authorized by caller number. The same number texts afterward over iMessage, WhatsApp or Dial through HMAC-signed, deduplicated webhooks. *Without Dial: no call, no consent, no business ever becomes agent-native.*

**Darwin: discovery, and the gap we fill.** Search v3 before every booking, with budget and deadline as context. A search ladder rides out Darwin's 500s, honors `Retry-After`, caches, and is smoke-tested live daily. Today no listed agent is ready for our trades, which is exactly the gap. *Without Darwin: we'd call shops that are already agent-native.* Details in [docs/darwin.md](docs/darwin.md).

**Alike: memory for the build itself.** The team built the phone side and the agent side in parallel coding sessions. Decisions anchored to file paths reached every session, so nobody undid the confirmation rule, the number allowlist or the Darwin cut rule. [DECISIONS.md](DECISIONS.md) is what Alike recorded. *Without Alike: parallel agents rewrite each other's contracts and nobody notices until 4:59pm.*

---

## Business model and what's next

Owners pay **per confirmed booking** (they already pay per lead), then an **autopilot subscription** (rules by text, live availability, quotes), and agent platforms pay for **routing signals and SLAs**. Pricing is a hypothesis to test with the first ten owners.

1. The live Dial call and owner texts, end to end.
2. Ten real owners called on Monday; opt-in rate is the number we live on.
3. SMS to regular phones after 10DLC registration.
4. Autopilot rules, then a Personal Agent Protocol adapter.
5. Darwin Publish: every flipped business becomes executable supply.

**Risks we say out loud.** Owners hang up on AI: we only need one call to work, and it brings a paying job. Platforms may build this: we stay neutral so they use us instead of rebuilding supply city by city. AI calls carry stricter rules: published lines only, disclosed first, "don't call again" honored instantly, texts only after a recorded yes.

---

## Real vs mocked

| Real | Mocked or not yet built |
| --- | --- |
| Contracts, booking state machine, holds, consent rules, event log, SSE stream, CI | Sal's Auto is not a real business. Its line is a second Dial number, answered by Dial's AI playing the owner, until Dial approves a real number. |
| The gateway's nine MCP tools, routing and the demo CLI | The site's replay runs on FakeDial; the live Dial call is on the phone side. |
| The live Darwin Search v3 client, search ladder and daily smoke check | Darwin has returned listed agents, none ready, rather than `no_match`. |
| Dial shapes checked against Dial's OpenAPI spec and SDK | Texts to regular phones wait on 10DLC. Five of six seeded businesses use 555 numbers. |
| The site negotiates Markdown for agents and returns real 404s, verified in production | Time saved is an estimate, with every assumption above. |

---

## Run it

Node 22.12 or newer and pnpm 10. Fakes mode needs no keys.

```bash
pnpm install && cp .env.example .env
pnpm dev                                          # gateway on :8787, site on :5173
pnpm --filter @platypus/gateway demo:cli oil      # drive the golden path over MCP
pnpm check                                        # lint, typecheck, tests
```

**For agents:** [`/llms.txt`](https://tryplatypus.pages.dev/llms.txt) says when to use Platypus; every page answers `Accept: text/markdown`; [`/developers`](https://tryplatypus.pages.dev/developers) has the MCP endpoint and all nine tools.

MIT. See [LICENSE](LICENSE). Built at SpeedHacks, San Francisco, October 11, 2026. A semi-aquatic, egg-laying agent of action.
