# @platypus/gateway

The front door for customer agents (Claude, Muse, Dots, Instinct, anything that speaks MCP).

**Owns:** the MCP server implementing `GatewayTools` from `@platypus/shared/contracts`, Darwin Search v3 routing, the `request_booking` route decision (`darwin_act`, `call` or `text`), and routing signals (typical price, median reply time, acceptance) computed from the local event log.

**Darwin:** `decideBookingRoute` in `src/route.ts` is the route decision, built on `lookupDarwin` from `@platypus/shared/darwin`. See [docs/darwin.md](../../docs/darwin.md).

**Depends on:** `@platypus/shared` only. Until the real voice package lands it uses `FakeDial` from `@platypus/shared/testing` (flag `DIAL_IMPL=fake|real`).

Also owns `docs/video.md` and `docs/submission.md`. Flags: `DIAL_IMPL=fake|real`, `DARWIN_ENABLED`, `DARWIN_ACT_ENABLED`.

## Connect Claude Desktop

`pnpm dev` must be running first: it serves the gateway at `http://localhost:8787/mcp`. Then add this to `~/Library/Application Support/Claude/claude_desktop_config.json` and restart Claude Desktop:

```json
{ "mcpServers": { "platypus": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:8787/mcp"] } } }
```

Other agents can name themselves with `--header "x-platypus-agent: <name>"`; the default is `claude-desktop`.

After `request_booking`, agents call `wait_for_booking`, which holds the call open until the status changes (55 s by default, under Claude Desktop's ~60 s tool-call limit; 120 s at most), so Claude reports "Booked" without being asked again.
