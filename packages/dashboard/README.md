# @platypus/dashboard

The screens judges watch. Two Vite pages, one event stream:

- **`/`**: the public page, with a live event log and the golden-path stepper.
- **`/live`**: the operator dashboard on screen during the demo. It shows the Darwin panel, the call with its mid-call tool timeline, the business cards flipping from PHONE-ONLY to TEXT-ENABLED, the bookings with their evidence, the owner's phone as message bubbles, the supply table and the compact event log.

![The /live dashboard after the owner's Y](../../docs/live-dashboard.png)

**Depends on:** `@platypus/shared` only, and the `/events/stream` SSE endpoint. It never needs Dial or Darwin running: the golden-path fixture replays the whole demo.

Live at [tryplatypus.pages.dev](https://tryplatypus.pages.dev) and [tryplatypus.pages.dev/live](https://tryplatypus.pages.dev/live), deployed by `.github/workflows/deploy-dashboard.yml`. A static build plays the recorded golden path and says "Recorded run"; `?events=<url>` connects either page to a live event server.

## How /live works

```
/events/stream ──► events.ts ──► reduce(state, event) ──► live.ts regions
  (SSE, or the       connect, parse,    state.ts: pure,         keyed DOM updates,
   bundled fixture)  reconnect          deduped by event id     textContent only
```

- **`src/state.ts`** folds events into `DashboardState`. It is pure and keyed by entity id (business, booking, call, message), so a refresh that replays the history, a reconnect that re-sends, and a second `/demo/replay` run all land on the same picture. Unknown fields and event types are ignored, never guessed at. The supply table (median reply seconds, last price, opt-in per script version) is computed here in the browser.
- **`src/events.ts`** is shared by both pages. It picks live or recorded mode, parses frames defensively, and reopens a dropped stream with `?after=<last id>`, including when a dev proxy keeps a dead stream open (no heartbeat for 35 s).
- **`src/live.ts`** renders each region in place, so a tool lights up and a card flips once, when its event lands. A history replayed after a refresh draws without animation.

| Region | Reads | Shows |
|---|---|---|
| Darwin | `agent.tool_called`, `darwin.searched`, `booking.pending` | The ask, status, HTTP status, latency, ranked agents with readiness and reasons, the question or no-match reason, the search ladder, `recorded` and `cached` badges, and the route decision. "Not searched yet" until Darwin answers |
| Call | `call.*`, `voice.tool_called`, `booking.*` | Queued, Ringing, In progress and Ended, a live timer against the duration cap, five fixed tool slots (failed slots show the error), the booked price and slot, a "from transcript" label, and the transcript with timings |
| Businesses | `business.*`, `consent.recorded` | Six cards that flip to text-enabled, with the rail, the masked best cell and the owner's exact words |
| Bookings | `booking.*`, `hold.placed`, `message.*` | Short code, status, route, price, slot, and the evidence: "Confirmed by call" with the quote, or "Confirmed by text" with the reply |
| Owner's phone | `message.*`, `reply.classified` | The owner's thread as bubbles, with delivery times and how each reply was read. This is the visible rail when `TEXT_CHANNEL=dial` |
| Supply | everything above | Channel, median reply, last price, opt-in per script version, or "none" when there is no data |
| Event stream | every event | Newest first, with actor and confidence |

The header shows the connection state (Live, Recorded run or Reconnecting), a "fixture replay" tag when the events are a replay, **Replay**, and **Kill call**. Kill call needs two clicks and is enabled only while a call is in progress. It posts `/demo/kill-call` and is hidden on the recorded run.

Layouts: the right half of a 1440×900 laptop (Darwin, the call and the cards above the fold), a full-width three-column view, and a single column on phones.
