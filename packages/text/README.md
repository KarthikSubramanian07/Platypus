# @platypus/text

After one yes on the call, every future request is a text the owner answers with one word.

**Owns:** the signed Dial webhook receiver and event-stream consumer (deduplicated by provider message id), STOP/HELP/PAUSE before any model call, reply classification (deterministic first, Claude extraction second), and outbound messages on `TEXT_CHANNEL` (`imessage`, `whatsapp` or `dial`).

**Depends on:** `@platypus/shared` only.

Status: shell. Built in workstream A.
