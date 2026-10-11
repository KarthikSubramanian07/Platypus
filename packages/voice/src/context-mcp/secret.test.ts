import { describe, expect, it } from "vitest";
import { readDialContext } from "./dial-context";
import { generateContextMcpSecret, generateContextMcpToken, maskSecret, resolveContextMcpCredentials, safeEqual, secretProblem } from "./secret";

describe("Context MCP credentials", () => {
  it("generates strong base64url values", () => {
    expect(secretProblem(generateContextMcpSecret(), 24)).toBeUndefined();
    expect(secretProblem(generateContextMcpToken(), 32)).toBeUndefined();
    expect(generateContextMcpSecret()).not.toBe(generateContextMcpSecret());
  });

  it("refuses to start in live mode with a missing or short value", () => {
    const token = generateContextMcpToken();
    expect(() => resolveContextMcpCredentials({ DEMO_MODE: "live", CONTEXT_MCP_TOKEN: token })).toThrow(/CONTEXT_MCP_SECRET is missing/);
    expect(() => resolveContextMcpCredentials({ DEMO_MODE: "live", CONTEXT_MCP_SECRET: "abc", CONTEXT_MCP_TOKEN: token })).toThrow(/at least 24 random bytes/);
    expect(() => resolveContextMcpCredentials({ DEMO_MODE: "live", CONTEXT_MCP_SECRET: "has spaces and !!", CONTEXT_MCP_TOKEN: token })).toThrow(/base64url/);
  });

  it("uses the env values when they are strong", () => {
    const secret = generateContextMcpSecret();
    const token = generateContextMcpToken();
    expect(resolveContextMcpCredentials({ DEMO_MODE: "live", CONTEXT_MCP_SECRET: secret, CONTEXT_MCP_TOKEN: token })).toEqual({ secret, token, ephemeral: false });
  });

  it("generates throwaway values in fakes mode, but still rejects weak ones", () => {
    const creds = resolveContextMcpCredentials({ DEMO_MODE: "fakes" });
    expect(creds.ephemeral).toBe(true);
    expect(secretProblem(creds.secret, 24)).toBeUndefined();
    expect(() => resolveContextMcpCredentials({ CONTEXT_MCP_SECRET: "short" })).toThrow();
  });

  it("masks and compares without leaking", () => {
    expect(maskSecret("abcdefghijklmnop")).toBe("abcd…(16 chars)");
    expect(safeEqual("same", "same")).toBe(true);
    expect(safeEqual("same", "different-length")).toBe(false);
  });
});

describe("readDialContext", () => {
  const h = (o: Record<string, string>) => new Headers(o);

  it("reads a real outbound call", () => {
    expect(readDialContext(h({ "X-Dial-Direction": "outbound", "X-Dial-User-Number": "+14155550101", "X-Dial-Agent-Number": "+15550100000" }))).toEqual({
      caller_number: "+14155550101",
      direction: "outbound",
      agent_number: "+15550100000",
    });
  });

  it("returns null for discovery requests: absent headers, unexpanded templates, or a non-E.164 number", () => {
    expect(readDialContext(undefined)).toBeNull();
    expect(readDialContext(h({}))).toBeNull();
    expect(readDialContext(h({ "X-Dial-Direction": "{{direction}}", "X-Dial-User-Number": "{{user_number}}" }))).toBeNull();
    expect(readDialContext(h({ "X-Dial-Direction": "outbound", "X-Dial-User-Number": "{{user_number}}" }))).toBeNull();
    expect(readDialContext(h({ "X-Dial-Direction": "outbound", "X-Dial-User-Number": "415-555-0101" }))).toBeNull();
    expect(readDialContext(h({ "X-Dial-Direction": "sideways", "X-Dial-User-Number": "+14155550101" }))).toBeNull();
  });

  it("drops a templated agent number but keeps the call", () => {
    expect(readDialContext(h({ "X-Dial-Direction": "Outbound", "X-Dial-User-Number": "+14155550101", "X-Dial-Agent-Number": "{{agent_number}}" }))).toEqual({
      caller_number: "+14155550101",
      direction: "outbound",
    });
  });
});
