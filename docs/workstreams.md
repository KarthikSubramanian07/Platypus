# How Platypus is being built

Two people build Platypus in parallel, each with their own coding session, and they don't talk to each other until integration. This page is what makes that work. It says who owns which files, where the two halves meet in code, and how work reaches `main`. **Where this page and a build prompt disagree, this page wins.**

## Start here: which side are you?

| Side | Owner | Branch | Packages and files you own |
|---|---|---|---|
| **Phone side** | Karthik | `phone-side` | `packages/voice`, `packages/text`, `packages/dashboard`, `scripts/dev.ts`, root `package.json` |
| **Agent side** | Eddy | `agent-side` | `packages/gateway`, `docs/video.md`, `docs/submission.md`, `packages/shared/src/testing/fake-owner-channels.ts` (new) |

The foundation in `packages/shared` is finished. Read the section for your side, then the three sections after it: the seams, file ownership, and merging.

## What already exists

- **Foundation (`main`):** the contracts, the append-only event log with a live stream, the booking state machine (`confirm()` is the only way into `confirmed`), SQLite, the fakes (`FakeDial`, `FakeGateway`, `FakeDarwin`), the golden-path fixture, and the dashboard shell.
- **Darwin (branch `darwin-integration`):** a typed Search v3 client with a fallback search ladder, plus `lookupDarwin`, `toDarwinSummary`, `darwinEventPayload` and the route decision `decideBookingRoute` in `packages/gateway/src/route.ts`. It is documented in `docs/darwin.md`. The agent side builds on this and does not rebuild it. Merge `origin/darwin-integration` into `agent-side` first; it reaches `main` with the agent side's first merge.

## The seams (the only places the two sides meet)

All four are fixed in `packages/shared/src/contracts/seams.ts` and `scripts/dev.ts`. Neither side changes them without the other's review.

1. **One process.** `pnpm dev` runs the event stream, the dashboard, the phone side's routes and the gateway in one process, so one database and one event bus serve everything. Each side plugs in by exporting a `mount` function from its package's `index.ts`; `scripts/dev.ts` already calls both. Event ids are only ordered within one process, so don't run a second process that writes events during the demo.
2. **`OwnerChannels`: how the gateway reaches an owner.** After `request_booking` picks a route, the gateway calls `startOnboardingCall({booking_id, business_id})` for route `call`, or `sendBookingRequest({booking_id, business_id})` for route `text`.
   - The phone side implements it for real. The call script, Dial, the number lookup, the consent check and the message copy all live on the phone side.
   - The agent side writes the fake over `FakeDial` and never builds a call instruction or owner message itself.
   - `DIAL_IMPL=real` makes `scripts/dev.ts` pass the phone side's version to the gateway. With `fake`, the gateway uses its own fake.
3. **`VoiceTools`: the tools used during a call.** They belong entirely to the phone side. `createFakeGateway` already books through the real state machine and authorizes every request, so the real version may reuse its logic. The agent side never touches `VoiceTools`.
4. **Events.** `packages/shared/src/testing/fixtures/golden-path.jsonl` defines every event type, actor and payload shape. The dashboard is built against it.
   - **Agent side emits:** `agent.tool_called`, `darwin.searched` (payload from `darwinEventPayload`), `signals.computed`, `booking.pending`, and `hold.placed` for route `text`.
   - **Phone side emits:** `call.*`, `voice.tool_called`, `consent.recorded`, `business.channel_changed`, `business.text_number_set`, `message.*` and `reply.classified`.
   - **The booking engine emits** `hold.*` and `booking.*` itself.
   - A new event type is fine. Changing an existing type's payload is a contract change.

## The phone side (Karthik)

Work in this order, against `FakeGateway` (`GATEWAY_IMPL=fake`). The full text is in Prompt 1; these overrides apply:

1. **`voice/call`:** the five-turn call, the disclosure hard-coded first, a 120-second cap (110 in `DEMO_MODE`), and no blind retries.
2. **`voice/context-mcp`:** `VoiceTools` over MCP, authorized with `authorizeVoiceRequest`, registered with `pnpm dial:register-mcp`.
3. **`text/inbound`, `text/classify`, `text/outbound`:** as in Prompt 1.
4. **Seam exports in `packages/voice/src/index.ts`:** `mount(app, deps)` for the webhooks and the Context MCP routes, and `createOwnerChannels(deps)`.
5. **The dashboard:** the Darwin panel, the call panel with the tool timeline, the business card flip, the owner-phone bubbles, and the Cloudflare Pages deploy.
   - Compute the supply table in the browser from the event stream. There is no shared signals function.
   - The supply table is the first thing to cut.
6. **Demo extras:** the kill switch, "resend last text", "replay last call", and `pnpm demo:reset`. `POST /demo/replay` already exists in `scripts/dev.ts`.

## The agent side (Eddy)

Work in this order, against `FakeDial` through the fake `OwnerChannels` (`DIAL_IMPL=fake`). The full text is in Prompt 2; these overrides apply:

1. **Merge `origin/darwin-integration`** into `agent-side`. Use `createDarwin`, `lookupDarwin`, `toDarwinSummary` and `decideBookingRoute` as they are.
2. **`fake-owner-channels.ts`:** `createFakeOwnerChannels(fakeDial, deps)` in `packages/shared/src/testing/`, plus one export line in `testing/index.ts`. This is the only shared file the agent side adds.
3. **`gateway/mcp`:** the `GatewayTools` contract over streamable HTTP, exposed as `mount(app, deps)` from `packages/gateway/src/index.ts`, serving `/mcp`.
   - Claude Desktop connects to the running `pnpm dev` with `npx -y mcp-remote http://localhost:8787/mcp`. Verify this early.
   - A stdio entry may exist for tests, but don't use it for the demo: its events would come from a second process.
4. **`request_booking`:** look up Darwin, call `decideBookingRoute`, create the pending booking, place the hold for route `text`, then call `OwnerChannels`. Act only behind `DARWIN_ACT_ENABLED`. Never simulate a Darwin response.
5. **`search_providers` signals:** computed from the local event log, `source: "local"`.
6. **`docs/video.md`:** a single-take run sheet, not an edited shot list.
   - HackerSquad records the shared screen, camera and mic live in the browser. There is no upload and no editing, and the limit is 5 minutes. Re-recording is allowed, and processing takes a few minutes before Submit unlocks.
   - Follow HackerSquad's order: the problem, the tech stack, the live demo.
   - Map each beat to its screen and its speaker: Eddy drives Claude Desktop and closes; Karthik answers his phone as the owner (the Dial number calls his phone).
   - Checklist: share the entire screen, Do Not Disturb on, phone on speaker by the laptop mic, webcam pointed at the phone, hotspot as backup, `pnpm demo:reset` before each take, and a QuickTime capture running as the finals backup.
7. **`docs/submission.md`:** the problem, target user, how it works, time saved with the baseline and the word "estimate", what is real and what is mocked, and the partners used (Dial, Darwin).

## Who edits what

| Path | Owner | Rule for everyone else |
|---|---|---|
| `packages/voice`, `packages/text`, `packages/dashboard` | Phone side | Don't edit |
| `packages/gateway`, `docs/video.md`, `docs/submission.md` | Agent side | Don't edit |
| `scripts/dev.ts`, root `package.json`, `.env.example` | Phone side | The agent side asks in its merge's description instead of editing |
| `packages/shared/src/contracts/*` | Nobody alone | Adding a field or a type is fine and needs no review. Changing or removing one needs the other side's review |
| `packages/shared/src/testing/fake-owner-channels.ts` | Agent side | Don't edit |
| Everything else in `packages/shared` | Frozen | Bug fixes only, each in its own small commit |
| `DECISIONS.md` | Both | Append only, under `### Phone side` or `### Agent side`. `.gitattributes` keeps both sides of any overlap when merging locally |
| `pnpm-lock.yaml` | Both | Add dependencies only to your own package (`pnpm --filter @platypus/<pkg> add ...`). On a lockfile conflict, take `main`'s version and run `pnpm install`. Never hand-merge it |

## Merging

- Work on your own branch. Every 45 minutes, and at 12:30, 2:30 and 3:15 at the latest: run `git fetch`, rebase onto `origin/main`, run `pnpm check`, then fast-forward `main` and push.
- Never force-push `main`. Merge locally rather than with GitHub's merge button, so `.gitattributes` applies.
- `pnpm check` must be green before anything reaches `main`.

## Staying in sync through Alike

Both sessions run with Alike, so they share decisions without anyone relaying them.
- **At the start of a session:** open your work with `resolve_work_item` on your branch (`phone-side` or `agent-side`).
- **When you make a call that affects the other side, record it:** use `record_decision` with a `governs` path anchor for each file or folder it covers. The other side's sessions then see it when they touch that code.
- **The seams and ownership on this page are already recorded as decisions.** Read any Alike pointer that touches your files before changing them.
- **Messages to the other person** (`inform_colleague`, `ask_colleague`) go out only after your human says yes.

## Integration (3:15, both sides)

1. Merge both branches into `main`.
2. Set `DIAL_IMPL=real`, `GATEWAY_IMPL=real` and `DEMO_MODE=live`, and set `DARWIN_ENABLED` based on whether Darwin is still working.
3. Run `pnpm demo:reset`, then `pnpm dev` on the machine with the Dial keys and tunnel. Set `GATEWAY_TOKEN` there, and point Eddy's Claude Desktop at `npx -y mcp-remote https://<PUBLIC_BASE_URL>/mcp --header "Authorization:Bearer <GATEWAY_TOKEN>"` (or `http://localhost:8787/mcp` when it runs on the same laptop).
4. Run the golden path three times with the real phone. Anything that fails twice goes back to its fake, and the video and the stage both say so.

## Flags

| Flag | Values | Default | Effect |
|---|---|---|---|
| `DEMO_MODE` | `fakes`, `live` | `fakes` | Fakes need no external service. FakeDarwin refuses to run in `live` |
| `GATEWAY_IMPL` | `fake`, `real` | `fake` | Phone side only: which `VoiceTools` the Context MCP server serves |
| `DIAL_IMPL` | `fake`, `real` | `fake` | Which `OwnerChannels` the gateway receives from `scripts/dev.ts` |
| `DARWIN_ENABLED` | `true`, `false` | `true` | `false` skips the Darwin step entirely; it is never simulated |
| `DARWIN_ACT_ENABLED` | `true`, `false` | `false` | Only if Darwin enables Act for us |
| `TEXT_CHANNEL` | `imessage`, `whatsapp`, `dial` | `imessage` | The owner's text rail. Never `sms` before 10DLC registration |

## Deadlines (HackerSquad, all PDT)

- **3:45:** feature freeze.
- **4:00:** record the video in the HackerSquad project form.
- **4:30:** submit, and check the status says submitted.
- **4:50:** last edit.
- **5:00:** the hard deadline. Late projects aren't judged.
