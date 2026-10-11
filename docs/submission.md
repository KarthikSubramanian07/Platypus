# HackerSquad submission text

Paste each section into the matching field of the HackerSquad project form. Anything in `[square brackets]` must be filled in or confirmed before pasting.

## Project name

Platypus

## One-line description

One AI phone call makes a phone-only business bookable by every AI agent: the call books the first job and asks for permission to text, and every later booking is a one-letter text reply.

## Links

- Demo: https://tryplatypus.pages.dev/ (replays a recorded run of the golden path in the browser; there is no server behind it)
- Code: https://github.com/KarthikSubramanian07/Platypus
- Video: recorded in this form

## Problem

The SBA Office of Advocacy counts more than 33 million small businesses in the US ([33.2 million in its 2023 FAQ](https://advocacy.sba.gov/2023/03/07/frequently-asked-questions-about-small-business-2023/); later editions are higher). Most will never build an API, a booking widget or an agent of their own. They have a phone.

Personal AI agents can book a flight, but they cannot book a local mechanic. The new agent standards ask a business for a website, an API or its own agent, and a three-person shop has none of the three. Calling is the stopgap, and every agent that calls a shop starts from zero: the shop learns nothing about who is calling, and the next agent calls it again.

## Target user

Two people use Platypus.

- **The customer** already talks to a personal AI agent (Claude Desktop over MCP in our demo) and wants a local service booked: an oil change, a brake inspection.
- **The business owner** runs a phone-first shop and will never adopt booking software. Our demo trade is auto repair; the same flow fits other phone-first trades such as home services, salons, clinics and movers.

## How it works

1. The customer's agent calls the Platypus MCP tools: `search_providers`, then `request_booking`. Demo request: "Oil change tomorrow afternoon, under $120, near 1025 Sansome."
2. The gateway runs Darwin Search v3 to see whether an agent already covers the job. For our trades Darwin returns no ready agent, so the route is a phone call.
3. Dial places one outbound AI call. Its first sentence says it is an AI. It asks for a price and an opening, and books through our `check_slot`, `hold_slot` and `create_booking` tools while the owner is still on the line (Dial Context MCP).
4. It then asks: "Next time a customer's agent needs you, can I text you instead of calling?" A yes is stored with the owner's exact words and the call id, and the shop switches from phone-only to text-enabled.
5. The agent gets a typed result: shop, time, price, short code. A booking is confirmed only when the owner says yes, on the call or by text, never because the AI said so.
6. Every later request to that shop goes by text on [TEXT RAIL: iMessage | WhatsApp | Dial-to-Dial]. The owner replies Y, N or a time, and the booking is confirmed within seconds.

## Time saved

All figures are **estimates**, not measurements.

- **Today, customer:** call about 3 shops, 15 to 25 minutes per booking, including hold time, repeating the job and callbacks.
- **With Platypus, customer:** one sentence to the agent they already use, then review a typed result. Under 1 minute, including review and corrections (a correction is one more sentence). One-time setup to connect the agent: about 2 minutes.
- **With Platypus, owner:** about 75 seconds once, on the onboarding call, then 5 to 10 seconds per job by text, instead of a 3 to 5 minute phone call.
- **Net:** about 15 to 20 minutes saved per booking for the customer. That is the 15 to 25 minute baseline minus under 1 minute, rounded down at the top to leave room for the one-time setup.
- **How we measure it:** the dashboard measures the owner's opt-in rate (did they say yes to texting) and reply seconds (text sent to reply) live. The demo is one call, so it shows the measurement working, not a statistic. The baseline would be measured with real owners and customers, timing a phone booking against an agent booking.

## What is real today and what is mocked

[CONFIRM before submitting: every item under "Real" ran live in the video. Move anything that ran on a fake (`DIAL_IMPL=fake`, `GATEWAY_IMPL=fake`, `DARWIN_ENABLED=false`) to "Mocked".]

**Real**

- The foundation: contracts (Zod, exported as JSON Schema), a booking state machine where `confirm()` is the only way into `confirmed`, a database that refuses a consent row without the quoted sentence and call id, an append-only event log with a live stream, and CI.
- A live Dial outbound call to a real phone, with the AI disclosure as the first sentence and the booking made through our tools during the call.
- Darwin Search v3, queried live before the call. The dashboard shows what Darwin returned.
- The owner's text and Y reply on [TEXT RAIL: iMessage | WhatsApp | Dial-to-Dial].

**Mocked or not yet built**

- Sal's Auto is not a business. Karthik, who is not a mechanic, plays the owner on his own phone, and no oil change is booked at any real shop.
- The other five shops on the dashboard are fictional, with phone numbers reserved for fiction.
- Texts to regular phones need 10DLC registration, which we file after the event. Until then the text rail is the one named above, not plain SMS.
- Darwin has never returned `no_match` for our trades. It answers with a completed search and no ready agent, and we report exactly that. We do not use Darwin Act or Publish, and Darwin is never simulated.
- Only our own phones can be called or texted; an allow-list in the code enforces it.
- The public page replays a recording of the golden path.
- The time-saved numbers are estimates.

## Partner tools used

- **Dial** places the AI voice call. Its Context MCP lets the voice agent call our booking tools during the call, authorized per call by the caller's number. It also carries the follow-up messages to the owner and tells us which number can receive them.
- **Darwin** runs Search v3 before every call, with the trade, the service, the area, the budget and the deadline as context. It tells us whether an agent already covers the job, so we phone a business only when none does.

## The gap we hit with Darwin, and what would fix it

- **Coverage.** For local trades, Darwin lists agents but none is ready to act. For the demo's auto shop it returned one listed agent and zero that could start a thread, so a booking falls back to the phone. Platypus is our answer to that gap: one call turns a phone-only business into supply an agent can book. What would close it on Darwin's side: a way to list or host businesses (Darwin's "Publish", marked "Soon"), so every shop Platypus onboards shows up as a ready agent.
- **Reliability.** Search v3 returned HTTP 500 for specific phrasings that include a service or location (for example "auto repair shop: oil change" with context), while the bare trade succeeded. We handle it with a fallback ladder, specific query first, then the bare trade, and log the `x-request-id` of every failure. One trade (moving) failed on every rung in our live check. The first answer for the demo shop took about 10 seconds (a 500, then a 200), so we cache answers per trade and warm the cache on start. What would fix it: consistent handling of those phrasings and faster first answers.
- **Access.** Creating a Darwin developer account failed three times with "we can't verify your sign-in"; the Darwin team confirmed sign-in is being fixed and that Search needs no account, so everything above ran on anonymous Search. What would help: a status note on the sign-in page, and published anonymous rate limits so builders know how far unauthenticated Search goes.

## Technologies

TypeScript, Node 22, Hono, MCP (streamable HTTP), SQLite, Zod, Vite, Vitest, pnpm workspaces, Dial, Darwin, Claude. Claude Desktop is the customer's agent in the demo, and Claude classifies the owner's text replies.

## What's next

- Call ten real shop owners and measure the real opt-in rate and reply time.
- Register for 10DLC so the text rail is plain SMS to regular phones.
- List Platypus businesses through Darwin Publish when it ships, so each onboarded shop becomes executable local supply in Darwin.
- Build a Personal Agent Protocol adapter, so agents on that standard can reach these shops too.

Team: Karthik and Eddy.
