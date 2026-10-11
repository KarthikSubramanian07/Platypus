# @platypus/dashboard

The screen judges watch: the live event log, the Darwin panel, the call with its mid-call tool timeline, business cards flipping from PHONE-ONLY to TEXT-ENABLED, the supply table, and the owner's phone rendered as message bubbles.

**Depends on:** `@platypus/shared` only, and the `/events/stream` SSE endpoint. It never needs Dial or Darwin running: the golden-path fixture replays the whole demo.

Status: the shell (live event log with replay) is done. The full five-region dashboard and the Cloudflare Pages deployment are next; see [docs/workstreams.md](../../docs/workstreams.md).
