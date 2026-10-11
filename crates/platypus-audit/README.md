# platypus-audit

A second, independent implementation of the Platypus event-log auditor, in Rust.

`tags: rust, audit, n-version, differential-testing, event-sourcing`

## Why a second auditor in a second language

The auditor in `packages/shared/src/audit/audit.ts` is the judge of the non-negotiables: it replays the append-only event log and checks rules R1 to R8 (the owner's yes, the AI disclosure, consent, one live call per business, well-formed events, no sms to non-Dial numbers, no double booking, no transcript confirmations). A judge with a bug passes bad logs quietly.

So the rules are read twice. This crate re-implements every rule from scratch, in a language with a different type system and different defaults, and `pnpm ci:audit-diff` runs both auditors on more than a thousand logs. Two independent readings of the non-negotiables must agree on every log, so a bug in one shows up as a disagreement instead of a silent pass. This is N-version programming applied to the one component whose mistakes nobody else would catch.

What must agree, per log: `ok`, the multiset of (rule, severity, event_id), every rule's `checked`, `errors` and `warnings`, and all of `stats`. Messages may be worded differently.

## Run it

```bash
cargo run --release -- ../../packages/shared/src/testing/fixtures/golden-path.jsonl
cargo run --release -- events.jsonl --json      # the same JSON shape as AuditResult in TypeScript
cat events.jsonl | cargo run --release -- -     # read stdin
cargo test                                       # a passing and a failing log for every rule
pnpm ci:audit-diff                               # from the repo root: TS and Rust on every log
```

Exit codes: 0 when every rule holds, 1 on any violation, 2 when the log cannot be read or is not JSONL.

## Architecture

| File | What it holds |
|---|---|
| `src/lib.rs` | The replay: one pass over the events, the same state and the same branches as `audit.ts`, then R2 judged at the end. The constants copied from TypeScript (`DISCLOSURE`, `TRANSITIONS`, statuses, actors, exempt kinds, the 0.9 do-not-call confidence, the `NEEDS_REASON` types) live at the top. |
| `src/js.rs` | The JavaScript semantics the TypeScript auditor leans on: `String.prototype.trim` whitespace, UTF-16 string ordering, number coercion for `>=`, and `Date.parse` for ISO 8601 timestamps. |
| `src/report.rs` | The plain-text report, a port of `report.ts`. |
| `src/main.rs` | The CLI. `--print-constants` dumps the copied constants so the harness can check them for drift. |
| `tests/rules.rs` | Unit tests per rule. |
| `../../scripts/ci/audit-differential.ts` | The differential harness: constants drift check, then the golden path, single corruptions of it, hand-built scenarios and seeded random logs through both auditors. |

## Known differences

- `Date.parse` accepts many free-form formats through V8's legacy parser. This crate accepts the ISO 8601 shapes V8 accepts (which is all Platypus writes) and treats anything else as unreadable. A date-time with no offset is local time in JavaScript and UTC here; the harness pins `TZ=UTC`.
- The TypeScript auditor counts stats in plain objects, so a key such as `constructor` or `toString` (an actor, a channel, a route or an evidence kind) corrupts its count. This crate counts it correctly. The harness keeps one such log as a known TypeScript bug and checks that it still differs.
