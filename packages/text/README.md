# @platypus/text

After one yes on the call, every future request is a text the owner answers with one word.

**Owns:** the signed Dial webhook receiver and the events-stream consumer (deduplicated by provider message id), STOP/HELP/PAUSE/UNDO/JOIN before any model call, reply classification (rules first, Claude second, code decides), and outbound messages on `TEXT_CHANNEL` (`imessage`, `whatsapp` or `dial`).

**Depends on:** `@platypus/shared`, plus `chrono-node` (times), `libphonenumber-js` (numbers), `@anthropic-ai/sdk` (the model layer), `hono` and `zod`.

## How a reply flows

```
Dial ──webhook (HMAC, 200 at once)──┐
Dial ──POST /events/wait loop───────┤ dedupe: event id, then messages.provider_message_id UNIQUE
                                    ▼
                         handleInbound (one at a time)
                                    │ store row, emit message.received
                                    ▼
     1. rules: keywords, reactions, yes/no lexicons, a reply that is only a time or a price
     2. Claude (only if 1 abstained and ANTHROPIC_API_KEY is set): class + extracted time/price
     3. thresholds: a model yes confirms only with an explicit yes, at 0.9+, matching the offer
                                    │ emit reply.classified {class, method, confidence}
                                    ▼
   accept → confirm(booking, {kind: "text", messageId})     decline → declined
   counter → countered (time resolved in the shop's zone)   unclear → one question, twice at most
```

## Outbound gates, in order

1. A consent on record, and the business is `text_enabled` (not `paused`, not `unlisted`). Otherwise `{needs_call: true, reason}`.
2. A number that can receive on the rail. iMessage and WhatsApp need Dial's lookup to say so (cached in the event log for 24 hours; a 502 is "ask again", never "no"). The `dial` rail sends `sms` only to numbers in `DIAL_OWNER_NUMBERS`.
3. `ALLOWED_NUMBERS` and the sms rule, checked again immediately before `POST /messages`.
4. One send. `POST /messages` is not idempotent, so `resendLast` asks `GET /messages` first.

## Evals

`evals/owner-replies.jsonl` holds 95 labeled replies. `pnpm test` holds the rule layer to 100% on the rows it must decide, requires it to abstain on the rest, and fails on any false accept. `pnpm --filter @platypus/text eval:model` runs the whole pipeline through Claude and prints a confusion matrix (it needs `ANTHROPIC_API_KEY` and spends credits).

## Environment

`DIAL_API_KEY`, `DIAL_FROM_NUMBER_ID`, `DIAL_NUMBER`, `DIAL_WEBHOOK_SECRET`, `TEXT_CHANNEL`, `ALLOWED_NUMBERS`, and optionally `DIAL_OWNER_NUMBERS`, `ANTHROPIC_API_KEY` and `CLASSIFIER_MODEL` (default `claude-haiku-5-5`). `createTextServiceFromEnv(deps)` reads them.
