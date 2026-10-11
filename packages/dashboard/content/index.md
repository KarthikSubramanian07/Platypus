# Platypus: AI booking for phone-only businesses

> We make Main Street agent-native. One honest AI phone call makes a phone-only business bookable by every AI agent; after one yes, every booking is a text the owner answers with one letter.

Your agent can book a flight. It can't book Main Street. Platypus calls a phone-only business once, books the job through its own tools while the owner is on the line, and asks to text next time. After one yes, every AI agent books that business by text.

## Time saved (transparent estimates)

| | Today | With Platypus |
| --- | --- | --- |
| Customer, per booking | 15 to 25 minutes calling around | under 1 minute of attention, setup, review and corrections included |
| Owner, per job | a 3 to 5 minute phone call mid-job | a 5 to 10 second text reply, after one 75-second call |
| Calls per business | one per booking, per agent | one, ever |

## How it works

1. **Ask.** An agent (Claude, Muse, Dots or any MCP client) calls `request_booking`. Platypus searches Darwin first, in case an agent already covers the job.
2. **Route.** `darwin_act` if a ready agent exists, `text` if the owner said yes before, otherwise `call`. Paused and do-not-call businesses are never contacted.
3. **Call once.** Dial rings the shop. The first sentence says it is an AI. Mid-call, the voice agent books through `check_slot`, `hold_slot` and `create_booking`.
4. **Consent.** "Yeah, text me." `record_consent` stores the owner's exact words and the call id. The business flips from phone-only to text-enabled.
5. **Text forever.** The next request is one text. The owner replies Y, N or a time, and the agent gets a typed outcome in seconds.

## Why it compounds

Consent compounds; calls don't. Every yes is supply no other agent can reach without calling. Signals come only from real bookings, Platypus is neutral across agent platforms, and owners pay only for confirmed jobs.

## Guarantees the code enforces

- A booking is never confirmed because the AI said so: only `confirm()` can confirm, and only with evidence (a quoted yes on a call, a Y by text, or an owner-approved rule).
- The database refuses a consent row without the owner's sentence and the call it came from.
- Every state change is an append-only event with an actor, a reason and a confidence.
- Only allowlisted numbers can ever ring, checked at the lowest layer.

## Built on

- [Dial](https://getdial.ai): outbound AI voice, Context MCP for mid-call tools, and owner texts.
- [Darwin](https://darwin.so): Search v3 before every booking; Act when a ready agent exists.
- [Alike](https://alike.help): shared decisions across the team's parallel coding sessions.

## Links

- [Developers](https://tryplatypus.pages.dev/developers): connect an agent.
- [About](https://tryplatypus.pages.dev/about), [Contact](https://tryplatypus.pages.dev/contact), [Privacy](https://tryplatypus.pages.dev/privacy)
- [Source on GitHub](https://github.com/KarthikSubramanian07/Platypus) (MIT)
- [llms.txt](https://tryplatypus.pages.dev/llms.txt)
