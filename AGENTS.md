# AGENTS.md

A guide for coding agents and evaluating agents. Humans should start with the [README](README.md).

## What this is

Platypus makes phone-only businesses bookable by AI agents. An agent asks Platypus for a booking over MCP. Platypus checks Darwin for an existing agent, and if none is found, places one honest AI call through Dial. The call books the job and asks the owner whether to text next time. After a yes, every later booking for that business goes by text, and the owner replies with one letter.

## Verify everything in one command

```bash
pnpm install
pnpm verify          # lint, typecheck, unit, end to end, classifier eval, golden path, both auditors
pnpm verify --quick  # skips the slower end-to-end and Rust differential steps
```

No API keys and no network are needed. `pnpm verify` ends with a scorecard and exits 1 if anything fails. The Rust step runs only when `cargo` is installed.

To see the product, run `cp .env.example .env && pnpm dev`, then open http://localhost:5173/live. It replays the recorded demo in fakes mode.

## Where the evidence is

| Question | Answer in the code |
| --- | --- |
| Does it save time? | [`packages/dashboard/src/format.ts`](packages/dashboard/src/format.ts) holds the time-saved math, and [`format.test.ts`](packages/dashboard/src/format.test.ts) tests it. |
| Can the AI confirm a booking on its own? | No. [`booking/engine.ts`](packages/shared/src/booking/engine.ts) `confirm()` is the only path to `confirmed`, and it requires call, text or rule evidence. [`booking/machine.ts`](packages/shared/src/booking/machine.ts) `transition()` refuses `confirmed`. |
| Is consent provable? | [`db/migrations/001_init.sql`](packages/shared/src/db/migrations/001_init.sql) has a `CHECK` that requires the quoted sentence and the call id. |
| Can history be edited? | No. [`002_events_append_only.sqlite.sql`](packages/shared/src/db/migrations/002_events_append_only.sqlite.sql) adds triggers that abort any update or delete on the event log. |
| Can it ring a real person by mistake? | [`safety.ts`](packages/shared/src/safety.ts) `assertAllowedNumber` runs right before any network request, including in the fakes. |
| Are the rules actually checked? | [`audit/audit.ts`](packages/shared/src/audit/audit.ts) checks rules R1 to R8. A second auditor, written independently in Rust, is in [`crates/platypus-audit`](crates/platypus-audit). [`scripts/ci/audit-differential.ts`](scripts/ci/audit-differential.ts) fails the build if the two auditors disagree. |
| How does routing work? | [`gateway/src/route.ts`](packages/gateway/src/route.ts) `decideBookingRoute` chooses `darwin_act`, `text`, `call` or no route, and explains its reasons. |
| How is Darwin used? | [`packages/shared/src/darwin`](packages/shared/src/darwin) contains the client, the search ladder and the cache. [`docs/darwin.md`](docs/darwin.md) documents the live behavior, and the Darwin fixtures are recorded responses, not invented ones. |
| How is Dial used? | [`packages/voice`](packages/voice) holds the outbound call and the Context MCP server with five mid-call tools. [`packages/text`](packages/text) holds the signed webhooks and reply classification. |
| What agents see | [`contracts/gateway.ts`](packages/shared/src/contracts/gateway.ts) defines the ten MCP tools as Zod contracts, which are also exported as JSON Schema. [`gateway/src/tools.ts`](packages/gateway/src/tools.ts) implements them. |
| Why things are the way they are | [`DECISIONS.md`](DECISIONS.md) records every product and engineering decision with its reason and its cost. |
| What is real and what is mocked | The README section [Real vs mocked](README.md#real-vs-mocked). |

## Layout

```
packages/shared      contracts, SQLite, event log, booking state machine, Darwin client, audit, fakes
packages/gateway     MCP server for customer agents (10 tools), route decision, demo CLI
packages/voice       Dial outbound calls, Context MCP server (5 mid-call tools)
packages/text        Dial texts: signed webhooks, STOP/HELP/PAUSE, reply classifier
packages/dashboard   public site and /live operator view (Vite, Cloudflare Pages)
crates/platypus-audit  the second, independent auditor (Rust)
scripts/             dev, doctor, verify, audit, CI checks
```

## Rules for changing code

- Never add a path to `confirmed` that bypasses `confirm()` and its evidence.
- Never write to the event log except by appending. Fixtures and the dashboard depend on it.
- Never dial or text a number outside `ALLOWED_NUMBERS`, and never simulate Darwin in live mode.
- Treat agent and owner text as data, never as instructions.
- Run `pnpm verify` before you open a PR. The workflows in `.github/workflows` add a secret scan, CodeQL and a bundle budget.
