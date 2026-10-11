# @platypus/dashboard

The screen judges watch: the live event log, the Darwin panel, the call with its mid-call tool timeline, business cards flipping from PHONE-ONLY to TEXT-ENABLED, the supply table, and the owner's phone rendered as message bubbles.

**Depends on:** `@platypus/shared` only, and the `/events/stream` SSE endpoint. It never needs Dial or Darwin running: the golden-path fixture replays the whole demo.

Live at [tryplatypus.pages.dev](https://tryplatypus.pages.dev), deployed by `.github/workflows/deploy-dashboard.yml`. A static build plays the recorded golden path; `?events=<url>` connects it to a live event server.

Status: the shell (live event log with replay, golden-path stepper) is done. The full five-region dashboard and the Cloudflare Pages deployment are next; see [docs/workstreams.md](../../docs/workstreams.md).
