import { serve, type ServerType } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getBooking } from "@platypus/shared/booking";
import { getRow, selectRows } from "@platypus/shared/db";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callFixture, TOMORROW_AFTERNOON, AGENT_NUMBER, type CallFixture } from "../tools/call-fixture";
import { createVoiceTools } from "../tools/voice-tools";
import { createContextMcpRoutes } from "./routes";
import { generateContextMcpSecret, generateContextMcpToken } from "./secret";
import type { ToolCallLog } from "./server";

const SECRET = generateContextMcpSecret();
const TOKEN = generateContextMcpToken();
const TWO_PM = { start: "2026-10-12T21:00:00.000Z", end: "2026-10-12T21:45:00.000Z" };

let f: CallFixture;
let server: ServerType;
let url: URL;
let logs: ToolCallLog[];
const clients: Client[] = [];

beforeEach(async () => {
  f = callFixture();
  logs = [];
  const tools = createVoiceTools({ db: f.db, bus: f.bus, clock: f.clock, textChannel: "imessage" });
  const app = new Hono();
  app.route("/", createContextMcpRoutes({ tools, secret: SECRET, token: TOKEN, allowedHosts: ["127.0.0.1", "localhost"], onToolCall: (l) => logs.push(l) }));
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => resolve(info.port));
  });
  url = new URL(`http://127.0.0.1:${port}/mcp/${SECRET}`);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await new Promise<void>((r) => server.close(() => r()));
});

const auth = { Authorization: `Bearer ${TOKEN}` };
const dialHeaders = (caller: string, direction = "outbound") => ({
  ...auth,
  "X-Dial-Direction": direction,
  "X-Dial-User-Number": caller,
  "X-Dial-Agent-Number": AGENT_NUMBER,
});

async function connect(headers: Record<string, string>, mode: "legacy" | "auto") {
  const client = new Client({ name: "dial-test", version: "0" }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  clients.push(client);
  return client;
}

type Result = Awaited<ReturnType<Client["callTool"]>>;
const text = (r: Result) => (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
const structured = <T>(r: Result) => r.structuredContent as T;

describe.each(["legacy", "auto"] as const)("Context MCP over HTTP, version negotiation %s", (mode) => {
  it("lists all five tools without Dial headers, and with unexpanded templates", async () => {
    for (const headers of [auth, { ...auth, "X-Dial-User-Number": "{{user_number}}", "X-Dial-Direction": "{{direction}}" }]) {
      const client = await connect(headers, mode);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["check_slot", "create_booking", "hold_slot", "record_consent", "set_text_number"]);
      const hold = tools.find((t) => t.name === "hold_slot")!;
      expect(hold.description).toMatch(/Hold the time/);
      expect(hold.inputSchema.required).toEqual(["business_id", "slot"]);
      expect(hold.outputSchema).toBeDefined();
    }
  });

  it("books the golden path through the tools: confirmed with call evidence, consent stored, channel flipped", async () => {
    const client = await connect(dialHeaders(f.sal.phone_e164), mode);
    const checked = await client.callTool({ name: "check_slot", arguments: { business_id: f.sal.id, window: TOMORROW_AFTERNOON } });
    expect(checked.isError).toBeFalsy();
    expect(structured<{ slots: unknown[] }>(checked).slots).toHaveLength(5);
    expect(text(checked)).toMatch(/^Open: Mon, Oct 12, 12:00 PM; 1:00 PM; 2:00 PM; 3:00 PM\./);

    const held = await client.callTool({ name: "hold_slot", arguments: { business_id: f.sal.id, slot: TWO_PM } });
    const { hold_id } = structured<{ hold_id: string }>(held);
    expect(text(held)).toMatch(/^Held Mon, Oct 12, 2:00 PM for 10 minutes/);

    const booked = await client.callTool({ name: "create_booking", arguments: { hold_id, price_cents: 8900, verbal_confirmation: "Yep, booked." } });
    const { booking_id, short_code } = structured<{ booking_id: string; short_code: string }>(booked);
    expect(text(booked)).toContain(`Reference ${short_code}`);
    expect(JSON.parse(text(booked).split("\n")[1]!)).toEqual({ booking_id, short_code });

    const consent = await client.callTool({ name: "record_consent", arguments: { business_id: f.sal.id, channel: "imessage", quote: "Yeah, text me." } });
    const number = await client.callTool({ name: "set_text_number", arguments: { business_id: f.sal.id, e164: f.sal.phone_e164 } });
    expect(consent.isError).toBeFalsy();
    expect(number.isError).toBeFalsy();

    const booking = getBooking({ db: f.db }, booking_id);
    expect(booking).toMatchObject({ status: "confirmed", price_cents: 8900, slot_start: TWO_PM.start });
    expect(booking.confirmation_evidence).toEqual({ kind: "call", callId: f.call.id, quotedSentence: "Yep, booked." });
    expect(getRow(f.db, "consents", structured<{ consent_id: string }>(consent).consent_id)).toMatchObject({ call_id: f.call.id, quoted_sentence: "Yeah, text me." });
    expect(getRow(f.db, "businesses", f.sal.id)).toMatchObject({ channel_state: "text_enabled", channel_pref: "imessage", text_number_e164: f.sal.phone_e164 });

    // Events in the golden-path order: engine events first, then the tool's own log line.
    const sequence = f.events().filter((e) => !e.type.startsWith("business.listed") && e.type !== "booking.pending").map((e) => (e.type === "voice.tool_called" ? `tool:${String(e.payload.tool)}` : e.type));
    expect(sequence).toEqual([
      "tool:check_slot",
      "hold.placed",
      "tool:hold_slot",
      "booking.slot_agreed",
      "hold.converted",
      "booking.confirmed",
      "tool:create_booking",
      "consent.recorded",
      "business.channel_changed",
      "tool:record_consent",
      "business.text_number_set",
      "tool:set_text_number",
    ]);
    // The live bus saw the same events, in the same order, as the log.
    expect(f.published.map((e) => e.id)).toEqual(f.events().map((e) => e.id));
    expect(logs.map((l) => [l.tool, l.ok, l.caller_masked])).toContainEqual(["create_booking", true, "+1415•••0101"]);
  });

  it("returns the same booking when create_booking is retried", async () => {
    const client = await connect(dialHeaders(f.sal.phone_e164), mode);
    const held = await client.callTool({ name: "hold_slot", arguments: { business_id: f.sal.id, slot: TWO_PM } });
    const args = { hold_id: structured<{ hold_id: string }>(held).hold_id, price_cents: 8900, verbal_confirmation: "Yep, booked." };
    const a = await client.callTool({ name: "create_booking", arguments: args });
    const b = await client.callTool({ name: "create_booking", arguments: args });
    expect(b.isError).toBeFalsy();
    expect(b.structuredContent).toEqual(a.structuredContent);
    expect(f.events("booking.confirmed")).toHaveLength(1);
  });

  it("refuses a caller with no live call, in a sentence the agent can say", async () => {
    const client = await connect(dialHeaders("+14155550999"), mode);
    const res = await client.callTool({ name: "check_slot", arguments: { business_id: f.sal.id, window: TOMORROW_AFTERNOON } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^These tools only work on Platypus's live outbound call/);
    expect(text(res)).not.toMatch(/Error|SQL|stack/);
    expect(f.events("voice.tool_called").at(-1)!.payload).toMatchObject({ ok: false, code: "unauthorized", caller_masked: "+1415•••0999" });
  });

  it("refuses a tool call that names another business and changes nothing", async () => {
    const client = await connect(dialHeaders(f.sal.phone_e164), mode);
    const before = { holds: selectRows(f.db, "holds").length, consents: selectRows(f.db, "consents").length, mira: getRow(f.db, "businesses", f.mira.id) };
    const hold = await client.callTool({ name: "hold_slot", arguments: { business_id: f.mira.id, slot: TWO_PM } });
    const consent = await client.callTool({ name: "record_consent", arguments: { business_id: f.mira.id, channel: "imessage", quote: "Sure" } });
    for (const res of [hold, consent]) {
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/not the business on this call/);
    }
    expect({ holds: selectRows(f.db, "holds").length, consents: selectRows(f.db, "consents").length, mira: getRow(f.db, "businesses", f.mira.id) }).toEqual(before);
    expect(f.events().filter((e) => e.type !== "voice.tool_called").map((e) => e.type)).not.toContain("hold.placed");
  });

  it("tells the agent to offer another slot when the time is taken", async () => {
    const client = await connect(dialHeaders(f.sal.phone_e164), mode);
    const held = await client.callTool({ name: "hold_slot", arguments: { business_id: f.sal.id, slot: TWO_PM } });
    await client.callTool({ name: "create_booking", arguments: { hold_id: structured<{ hold_id: string }>(held).hold_id, price_cents: 8900, verbal_confirmation: "Yes" } });
    // The same call now tries a time that overlaps the confirmed booking.
    const clash = await client.callTool({ name: "hold_slot", arguments: { business_id: f.sal.id, slot: { start: "2026-10-12T21:30:00.000Z", end: "2026-10-12T22:15:00.000Z" } } });
    expect(clash.isError).toBe(true);
    expect(text(clash)).toBe("That time is taken. Offer the next open slot from check_slot.");
  });

  it("refuses every tool once the call has ended, and on inbound calls", async () => {
    const inbound = await connect(dialHeaders(f.sal.phone_e164, "inbound"), mode);
    const res1 = await inbound.callTool({ name: "check_slot", arguments: { business_id: f.sal.id, window: TOMORROW_AFTERNOON } });
    expect(res1.isError).toBe(true);
    expect(text(res1)).toMatch(/outbound Platypus call/);

    f.endCall();
    const client = await connect(dialHeaders(f.sal.phone_e164), mode);
    const res2 = await client.callTool({ name: "hold_slot", arguments: { business_id: f.sal.id, slot: TWO_PM } });
    expect(res2.isError).toBe(true);
    expect(selectRows(f.db, "holds")).toHaveLength(0);
  });

  it("refuses tool calls without Dial headers and turns bad input into a speakable error", async () => {
    const bare = await connect(auth, mode);
    const res1 = await bare.callTool({ name: "set_text_number", arguments: { business_id: f.sal.id, e164: "+14155550123" } });
    expect(res1.isError).toBe(true);

    const client = await connect(dialHeaders(f.sal.phone_e164), mode);
    const res2 = await client.callTool({ name: "set_text_number", arguments: { business_id: f.sal.id, e164: "555" } });
    expect(res2.isError).toBe(true);
    expect(text(res2)).toBe("Some details were missing or malformed. Check the tool's fields and try once more.");
    expect(f.events("voice.tool_called").at(-1)!.payload).toMatchObject({ code: "invalid_input" });
  });
});

describe("HTTP guards", () => {
  const initialize = (headers: Record<string, string>, target: URL = url) =>
    fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "0" } } }),
    });

  it("answers a legacy initialize statelessly with JSON", async () => {
    const res = await initialize(auth);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("answers a missing or wrong bearer with a plain 403 and no OAuth challenge", async () => {
    const attempts: Record<string, string>[] = [{}, { Authorization: "Bearer nope" }, { Authorization: TOKEN }];
    for (const headers of attempts) {
      const res = await initialize(headers);
      expect(res.status).toBe(403);
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(await res.text()).toBe("Forbidden");
    }
  });

  it("404s a wrong path, even with the right token", async () => {
    const res = await initialize(auth, new URL(`/mcp/${generateContextMcpSecret()}`, url));
    expect(res.status).toBe(404);
  });

  it("405s GET and DELETE", async () => {
    expect((await fetch(url, { headers: { ...auth, accept: "text/event-stream" } })).status).toBe(405);
    expect((await fetch(url, { method: "DELETE", headers: auth })).status).toBe(405);
  });

  it("403s a foreign Host header", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      const r = request(url, { method: "POST", headers: { host: "evil.example", "content-type": "application/json", ...auth } }, (res) => resolve(res.statusCode ?? 0));
      r.end("{}");
    });
    expect(status).toBe(403);
  });

  it("refuses to build routes with a weak secret or token", () => {
    const tools = createVoiceTools({ db: f.db, bus: f.bus, textChannel: "imessage" });
    expect(() => createContextMcpRoutes({ tools, secret: "short", token: TOKEN })).toThrow(/path secret/);
    const weakToken = Buffer.alloc(24, 7).toString("base64url"); // valid base64url, but only 24 bytes
    expect(() => createContextMcpRoutes({ tools, secret: SECRET, token: weakToken })).toThrow(/at least 32 random bytes/);
  });
});
