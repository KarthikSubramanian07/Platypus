import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { insertRow, openDb, seed, getBusinessBySlug } from "../db/index";
import { newId } from "../ids";
import {
  authorizeVoiceRequest,
  Classification,
  CLASSIFICATION_CLASSES,
  contractJsonSchemas,
  DialEvent,
  GATEWAY_TOOL_NAMES,
  GATEWAY_TOOLS,
  Signals,
  TextOutbound,
  VOICE_TOOL_NAMES,
  VOICE_TOOLS,
  VoiceAuthorizationError,
} from "./index";

describe("tool registries", () => {
  it("expose exactly the gateway tools from the spec", () => {
    expect(GATEWAY_TOOL_NAMES).toEqual([
      "search_providers",
      "get_provider",
      "get_availability",
      "request_booking",
      "get_booking",
      "confirm_booking",
      "reschedule_booking",
      "cancel_booking",
      "report_outcome",
    ]);
  });

  it("expose exactly the voice tools from the spec", () => {
    expect(VOICE_TOOL_NAMES).toEqual(["check_slot", "hold_slot", "create_booking", "record_consent", "set_text_number"]);
  });

  it("tell the calling model that results are asynchronous and what the outcomes mean", () => {
    for (const name of ["request_booking", "get_booking"] as const) {
      expect(GATEWAY_TOOLS[name].description).toMatch(/asynchronous/);
      expect(GATEWAY_TOOLS[name].description).toMatch(/confirmed \(the owner said yes/);
    }
  });

  it("require an idempotency key on every write", () => {
    for (const name of ["request_booking", "confirm_booking", "reschedule_booking", "cancel_booking"] as const) {
      expect(GATEWAY_TOOLS[name].input.safeParse({}).success).toBe(false);
      expect(Object.keys(GATEWAY_TOOLS[name].input.shape)).toContain("idempotency_key");
    }
  });

  it("reject create_booking without the owner's words", () => {
    expect(VOICE_TOOLS.create_booking.input.safeParse({ hold_id: "h", price_cents: 8900, verbal_confirmation: "" }).success).toBe(false);
  });
});

describe("value contracts", () => {
  it("never allow sms as an outbound rail", () => {
    expect(TextOutbound.safeParse({ to: "+15550100001", body: "Hi", channel: "sms" }).success).toBe(false);
    expect(TextOutbound.safeParse({ to: "+15550100001", body: "Hi", channel: "imessage" }).success).toBe(true);
  });

  it("cap outbound texts at 300 characters", () => {
    expect(TextOutbound.safeParse({ to: "+15550100001", body: "x".repeat(301), channel: "dial" }).success).toBe(false);
  });

  it("enumerate every reply class", () => {
    expect(CLASSIFICATION_CLASSES).toHaveLength(10);
    expect(Classification.parse({ class: "counter", confidence: 0.9, extracted: { time: "2pm", price_cents: 30000 } }).class).toBe("counter");
  });

  it("label where signals came from", () => {
    expect(Signals.safeParse({ typical_price_cents: 8900 }).success).toBe(false);
    expect(Signals.parse({ typical_price_cents: 8900, source: "local" }).source).toBe("local");
  });

  it("parse a Dial call.ended envelope", () => {
    const parsed = DialEvent.parse({
      id: "evt_1",
      object: "event",
      type: "call.ended",
      version: 1,
      createdAt: "2026-10-11T19:00:00Z",
      relatedObject: { id: "call_1", type: "call", url: "/api/v1/calls/call_1" },
      data: { callId: "call_1", from: "+1", to: "+2", direction: "outbound", durationSeconds: 71, status: "completed", canceled: false, transcriptAvailable: true },
    });
    expect(parsed.type).toBe("call.ended");
  });
});

describe("JSON Schema export", () => {
  it("is committed and up to date (run pnpm contracts:export)", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../../schemas");
    for (const [file, schema] of Object.entries(contractJsonSchemas())) {
      expect(JSON.parse(readFileSync(join(dir, file), "utf8")), file).toEqual(JSON.parse(JSON.stringify(schema)));
    }
  });
});

describe("authorizeVoiceRequest", () => {
  function setup() {
    const db = openDb(":memory:");
    seed(db, { allowedNumbers: ["+15550100001"] });
    const sal = getBusinessBySlug(db, "sals-auto")!;
    const mira = getBusinessBySlug(db, "mira-hair-studio")!;
    const now = new Date().toISOString();
    const call = insertRow(db, "calls", {
      id: newId("call"),
      business_id: sal.id,
      booking_id: null,
      dial_call_id: "dial_1",
      direction: "outbound",
      to_e164: sal.phone_e164,
      status: "In-Progress",
      script_version: null,
      started_at: now,
      ended_at: null,
      duration_seconds: null,
      end_reason: null,
      transcript: null,
      transcript_turns: null,
      mined: null,
      friction_score: null,
      created_at: now,
      updated_at: now,
    });
    return { db, sal, mira, call };
  }

  it("accepts the business on the live call", () => {
    const { db, sal, call } = setup();
    expect(authorizeVoiceRequest(db, { caller_number: sal.phone_e164, direction: "outbound" }, sal.id).id).toBe(call.id);
  });

  it("rejects a tool call naming another business", () => {
    const { db, sal, mira } = setup();
    expect(() => authorizeVoiceRequest(db, { caller_number: sal.phone_e164, direction: "outbound" }, mira.id)).toThrow(VoiceAuthorizationError);
  });

  it("rejects a number with no live call, and a missing header", () => {
    const { db, sal } = setup();
    expect(() => authorizeVoiceRequest(db, { caller_number: "+15550109999", direction: "outbound" }, sal.id)).toThrow(/No live call/);
    expect(() => authorizeVoiceRequest(db, { caller_number: "", direction: "outbound" }, sal.id)).toThrow(/Missing/);
  });

  it("rejects once the call has ended", () => {
    const { db, sal, call } = setup();
    db.prepare("UPDATE calls SET status = 'Terminated' WHERE id = ?").run(call.id);
    expect(() => authorizeVoiceRequest(db, { caller_number: sal.phone_e164, direction: "outbound" }, sal.id)).toThrow(/No live call/);
  });
});
