import fc from "fast-check";
import { isE164 } from "@platypus/shared/config";
import { DIAL_HEADERS, VoiceAuthorizationError, type VoiceToolContext } from "@platypus/shared/contracts";
import { updateRow } from "@platypus/shared/db";
import { describe, expect, it } from "vitest";
import { callFixture, TOMORROW_AFTERNOON } from "../tools/call-fixture";
import { createVoiceTools } from "../tools/voice-tools";
import { readDialContext } from "./dial-context";

/**
 * Context MCP tools are wired to every call on the Dial account, so every request
 * is authorized on its own. Property: a tool runs only when the caller number is
 * valid E.164, the direction is outbound, and there is a live outbound call to
 * that number with the business the tool names. Every other combination is refused,
 * and every attempt, refused or not, is in the event log.
 */

fc.configureGlobal({ seed: Number(process.env.FC_SEED ?? 0xa17), numRuns: Number(process.env.FC_RUNS ?? 200) });

type CallState = "live" | "ended" | "inbound_row";
type Who = "sal" | "mira" | "random" | "junk";

const caller = fc.oneof(
  fc.constantFrom<Who>("sal", "mira").map((who) => ({ who, raw: null as string | null })),
  fc.stringMatching(/^\+[1-9]\d{6,14}$/).map((raw) => ({ who: "random" as Who, raw })),
  fc.oneof(fc.string({ maxLength: 16 }), fc.constantFrom("", "{{user_number}}", "+0123456789", "4155550101", "+1 415 555 0101", "+14155550101\uFF11")).map((raw) => ({ who: "junk" as Who, raw })),
);
const direction = fc.constantFrom("outbound", "inbound", "Outbound", "", "sideways");
const businessArg = fc.constantFrom("sal", "mira", "unknown", "omitted");
const callState = fc.constantFrom<CallState>("live", "ended", "inbound_row");

describe("Context MCP authorization, property-based", () => {
  it("runs a tool only for a valid outbound caller on a live call with the named business", async () => {
    await fc.assert(
      fc.asyncProperty(caller, direction, businessArg, callState, async (c, dir, biz, state) => {
        const f = callFixture();
        const tools = createVoiceTools({ db: f.db, bus: f.bus, clock: f.clock, textChannel: "imessage" });
        if (state === "ended") f.endCall();
        if (state === "inbound_row") updateRow(f.db, "calls", f.call.id, { direction: "inbound" });

        const number = c.who === "sal" ? f.sal.phone_e164 : c.who === "mira" ? f.mira.phone_e164 : c.raw!;
        const ctx = { caller_number: number, direction: dir } as VoiceToolContext;
        const businessId = biz === "sal" ? f.sal.id : biz === "mira" ? f.mira.id : biz === "unknown" ? "biz_unknown" : undefined;
        const input = { ...(businessId ? { business_id: businessId } : {}), window: TOMORROW_AFTERNOON };

        // The oracle: the only live outbound call in the fixture is to Sal's number, about Eddy's Auto.
        const authorized = isE164(number) && dir === "outbound" && state === "live" && number === f.sal.phone_e164 && biz === "sal";
        const before = f.events("voice.tool_called").length;
        const outcome = await tools.check_slot(input as never, ctx).then(
          () => "ran",
          (error: unknown) => error,
        );
        if (authorized) expect(outcome).toBe("ran");
        else if (outcome === "ran") throw new Error(`authorized ${JSON.stringify({ c, dir, biz, state })}`);
        else if (businessId !== undefined || !isE164(number) || dir !== "outbound" || state !== "live" || number !== f.sal.phone_e164) {
          expect(outcome).toBeInstanceOf(VoiceAuthorizationError);
        }
        expect(f.events("voice.tool_called")).toHaveLength(before + 1);
        expect(f.events("voice.tool_called").at(-1)!.payload.ok).toBe(authorized);
        f.db.close();
      }),
    );
  });

  it("never lets one live call book for another business, whatever the tool", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("check_slot", "hold_slot", "record_consent", "set_text_number"), async (tool) => {
        const f = callFixture();
        const tools = createVoiceTools({ db: f.db, bus: f.bus, clock: f.clock, textChannel: "imessage" });
        const inputs: Record<string, unknown> = {
          check_slot: { business_id: f.mira.id, window: TOMORROW_AFTERNOON },
          hold_slot: { business_id: f.mira.id, slot: { start: "2026-10-12T21:00:00.000Z", end: "2026-10-12T21:45:00.000Z" } },
          record_consent: { business_id: f.mira.id, channel: "imessage", quote: "Yeah, text me." },
          set_text_number: { business_id: f.mira.id, e164: f.mira.phone_e164 },
        };
        const run = (tools as unknown as Record<string, (i: unknown, c: VoiceToolContext) => Promise<unknown>>)[tool]!;
        await expect(run(inputs[tool], f.ctx)).rejects.toThrow(/different business/);
        expect(f.events("hold.placed")).toHaveLength(0);
        expect(f.events("consent.recorded")).toHaveLength(0);
        f.db.close();
      }),
      { numRuns: 20 },
    );
  });

  it("reads Dial identity only from a valid E.164 number and a known direction", () => {
    fc.assert(
      fc.property(fc.option(fc.oneof(fc.string({ maxLength: 18 }), fc.stringMatching(/^\+[1-9]\d{6,14}$/))), fc.option(fc.constantFrom("outbound", "INBOUND", "inbound", "both", "{{direction}}", "")), (num, dir) => {
        const headers = new Headers();
        if (num !== null) {
          try {
            headers.set(DIAL_HEADERS.userNumber, num);
          } catch {
            return; // not a legal header value; fetch would never deliver it
          }
        }
        if (dir !== null) headers.set(DIAL_HEADERS.direction, dir);
        const ctx = readDialContext(headers);
        const trimmed = num?.trim() ?? "";
        const d = dir?.trim().toLowerCase();
        const expectOk = trimmed !== "" && isE164(trimmed) && (d === "outbound" || d === "inbound");
        expect(ctx !== null).toBe(expectOk);
        if (ctx) expect(ctx.caller_number).toBe(trimmed);
      }),
    );
  });
});
