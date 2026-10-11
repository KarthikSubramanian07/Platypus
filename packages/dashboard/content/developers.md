# Platypus for developers

Connect any AI agent to phone-only businesses. Platypus is an **MCP server**: your agent asks for a booking, and Platypus finds a route (an existing agent on Darwin, a text to an owner who opted in, or one honest AI call) and returns a typed outcome.

## When to use Platypus

Use Platypus when a user asks your agent to book, quote or schedule a **local service at a business that only takes bookings by phone**: auto repair, plumbing, HVAC, locksmiths, salons, clinics, movers. Don't use it for businesses that already have online booking or their own agent, for restaurants with a reservations platform, or for anything that needs payment today.

## Quickstart (sandbox, no keys)

You need Node 22.12 or newer and pnpm 10.

```bash
git clone https://github.com/KarthikSubramanian07/Platypus.git
cd Platypus
pnpm install
cp .env.example .env   # DEMO_MODE=fakes needs nothing else
pnpm dev               # MCP at http://localhost:8787/mcp, dashboard at http://localhost:5173
```

The sandbox runs the real gateway and booking state machine against FakeDial and FakeDarwin, so nothing rings and nothing costs money. Drive the whole golden path from the terminal with the bundled CLI:

```bash
pnpm --filter @platypus/gateway demo:cli oil      # book an oil change
pnpm --filter @platypus/gateway demo:cli brakes   # second booking, by text
pnpm --filter @platypus/gateway demo:cli tools    # list the tools
```

## Connect your agent

The gateway speaks MCP over **streamable HTTP** at `POST /mcp` (stateless; `GET` and `DELETE` return 405). Send:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <GATEWAY_TOKEN>`, required when the server sets `GATEWAY_TOKEN` |
| `x-platypus-agent` | A stable name for your agent, used for rate limits and the event log |

Browser origins other than localhost are refused, so a web page can't reach `/mcp` through DNS rebinding.

## Tools

| Tool | What it does |
| --- | --- |
| `search_providers` | Find local businesses for a job. Searches Darwin's agent index first, then returns phone-only and text-enabled businesses with routing signals (typical price, median reply time, acceptance) and a `next_step`. |
| `get_provider` | One business's public profile: services, hours, price ranges, whether it's text-enabled. |
| `get_availability` | Known open slots in a window. Empty doesn't mean unavailable: Platypus asks the owner. |
| `request_booking` | Ask for a booking. Returns at once with status `pending` and the route chosen: `darwin_act`, `call` or `text`. |
| `get_booking` | Current state of a booking. Poll it until the status is final. |
| `wait_for_booking` | Wait for the owner's answer. Returns as soon as the status changes, or after a timeout; call it again until the status is final. |
| `confirm_booking` | Accept a time the owner proposed in a counter-offer. |
| `reschedule_booking` | Ask to move a confirmed booking; it stays `rescheduled` until the owner agrees. |
| `cancel_booking` | Cancel a booking; the owner is told by text if they opted in. |
| `report_outcome` | After the appointment: `completed`, `no_show` or `issue`. Only real bookings feed reputation. |

Every tool has a Zod contract exported as JSON Schema in [`packages/shared/schemas/gateway-tools.json`](https://github.com/KarthikSubramanian07/Platypus/blob/main/packages/shared/schemas/gateway-tools.json). Pass an `idempotency_key` on `request_booking` so retries never double-book.

## Booking outcomes

Bookings are asynchronous: a phone call or a text reply takes seconds to minutes. A booking is **confirmed only when the owner says yes**, on the call or by text, never because a model said so. Final statuses are `confirmed`, `declined`, `expired` and `cancelled`; `countered` means the owner proposed another time, which you accept with `confirm_booking`.

## API keys

There is no hosted Platypus API yet. When you run the gateway yourself, set `GATEWAY_TOKEN` and give it to your agent as a bearer token. Live mode also needs Dial and Darwin credentials; `pnpm run doctor` checks them without printing secrets.

## More

- [README and architecture](https://github.com/KarthikSubramanian07/Platypus#architecture)
- [Darwin integration](https://github.com/KarthikSubramanian07/Platypus/blob/main/docs/darwin.md)
- [llms.txt](/llms.txt): this site for language models
- [Contact](/contact)
