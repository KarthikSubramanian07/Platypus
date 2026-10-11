# @platypus/voice

The phone call that turns a phone-only business into an agent-native one.

**Owns:** outbound Dial calls (hard-coded AI disclosure as the first sentence, 120-second cap, never a blind retry), the Context MCP server that exposes `VoiceTools` (`check_slot`, `hold_slot`, `create_booking`, `record_consent`, `set_text_number`) to the voice agent mid-call, and transcript mining.

**Depends on:** `@platypus/shared` only. Until the real gateway lands it uses `FakeGateway` from `@platypus/shared/testing` (flag `GATEWAY_IMPL=fake|real`).

Status: shell. Built on the phone side; see [docs/workstreams.md](../../docs/workstreams.md).
