import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { auditEventLog, formatAuditReport } from "@platypus/shared/audit";
import { emit, listEvents } from "@platypus/shared/events";
import { harness } from "./test-helpers";

/**
 * Owners text whatever they like, in any order. Property: after any sequence of
 * replies (keywords, yes, no, times, chatter) to a booking request, the event log
 * still audits clean. In particular nothing but the STOP confirmation and HELP is
 * ever sent after the owner revokes consent (non-negotiable 3).
 */

fc.configureGlobal({ seed: Number(process.env.FC_SEED ?? 0x1b0d), numRuns: Number(process.env.FC_RUNS ?? 200) });

const reply = fc.constantFrom("STOP", "stop texting me", "HELP", "UNDO", "PAUSE", "pause 2 weeks", "START", "JOIN", "Y", "yes", "N", "2pm", "$120", "hello?", "wrong number", "👍");

describe("inbound owner texts, fuzzed", () => {
  it("any sequence of owner replies leaves a log that audits clean", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(reply, { minLength: 1, maxLength: 8 }), async (replies) => {
        const h = harness();
        // The harness writes the consent row directly; record it the way record_consent would.
        emit(h.db, { type: "consent.recorded", actor: "voice", refs: { business_id: h.sal.id, consent_id: "cns_test", call_id: "call_test" }, payload: { channel: "imessage", source: "call" }, reason: "owner said yes to texts on the call" }, { bus: h.bus, clock: h.clock });
        await h.service.sendBookingRequest({ booking_id: h.booking.id, business_id: h.sal.id });
        for (const body of replies) {
          h.clock.advance(30_000);
          await h.post(h.inbound(body));
          await h.service.drain();
        }
        const result = auditEventLog(listEvents(h.db, { limit: 10_000 }));
        if (!result.ok) throw new Error(`${replies.join(" → ")}\n${formatAuditReport(result)}`);
        expect(result.ok).toBe(true);
      }),
      { numRuns: Number(process.env.FC_RUNS ?? 60) },
    );
  }, 60_000);
});
