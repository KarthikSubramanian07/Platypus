# @platypus/shared

The contract every Platypus package builds against. Import from these subpaths:

| Import | What you get |
| --- | --- |
| `@platypus/shared/contracts` | Zod schemas and TypeScript types: `GATEWAY_TOOLS`, `VOICE_TOOLS`, `TextInbound`, `TextOutbound`, `Signals`, `Classification`, Dial and Darwin wire shapes, and `authorizeVoiceRequest`. JSON Schema copies are in `schemas/`. |
| `@platypus/shared/db` | `openDb()` (migrations run on open), the typed repository, and `seed()`. |
| `@platypus/shared/events` | `emit()`, `listEvents()`, `EventBus`, and `createEventsApp()` (SSE at `/events/stream`). |
| `@platypus/shared/booking` | The state machine, `createBooking`, `transition`, `confirm` (the only way into `confirmed`), and holds. |
| `@platypus/shared/testing` | `FakeDial`, `createFakeGateway`, `createFakeDarwinFetch`, `runGoldenPath`, `replayEvents`, and `fixtures/golden-path.jsonl`. |
| `@platypus/shared/safety` | `assertAllowedNumber` and `sanitizeUntrustedText`. |

Change a contract by opening a PR that the other workstreams review. Run `pnpm contracts:export` after changing a schema; a test fails if `schemas/` is stale.
