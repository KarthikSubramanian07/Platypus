# @platypus/gateway

The front door for customer agents (Claude, Muse, Dots, Instinct, anything that speaks MCP).

**Owns:** the MCP server implementing `GatewayTools` from `@platypus/shared/contracts`, Darwin Search v3 routing, the `request_booking` route decision (`darwin_act`, `call` or `text`), and routing signals (typical price, median reply time, acceptance) computed from the local event log.

**Depends on:** `@platypus/shared` only. Until the real voice package lands it uses `FakeDial` from `@platypus/shared/testing` (flag `DIAL_IMPL=fake|real`).

Also owns `docs/video.md` and `docs/submission.md`. Flags: `DIAL_IMPL=fake|real`, `DARWIN_ENABLED`, `DARWIN_ACT_ENABLED`.

Status: shell. Built on the agent side; see [docs/workstreams.md](../../docs/workstreams.md).
