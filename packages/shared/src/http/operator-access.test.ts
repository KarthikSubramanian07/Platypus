import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createEventsApp } from "../events/sse";
import { EventBus } from "../events/bus";
import { openDb } from "../db/index";
import { guardOperatorRoutes, isLoopbackAddress, MIN_DASHBOARD_TOKEN_CHARS, operatorAccessFromEnv, type OperatorAccessOptions } from "./operator-access";

const TOKEN = "dash_" + "x".repeat(40);
const TUNNEL = "platypus-demo.trycloudflare.com";

/** The server as scripts/dev.ts builds it: guard first, then the event log, audit and a demo control. */
function server(options: OperatorAccessOptions = { token: TOKEN }) {
  const app = new Hono();
  guardOperatorRoutes(app, options);
  app.route("/", createEventsApp({ db: openDb(":memory:"), bus: new EventBus() }));
  app.get("/audit", (c) => c.json({ ok: true }));
  app.post("/demo/owner-reply", (c) => c.json({ ok: true }));
  app.get("/health", (c) => c.json({ ok: true }));
  app.post("/webhooks/dial", (c) => c.json({ ok: true }));
  return app;
}

const local = { host: "localhost:8787" };
const tunnelled = { host: TUNNEL, "cf-connecting-ip": "203.0.113.7", "cf-ray": "8a1b2c3d4e5f-SJC" };

describe("operator routes", () => {
  it("are open to this machine: the Vite proxy, curl, the dashboard on localhost", async () => {
    const app = server();
    expect((await app.request("http://localhost:8787/events", { headers: local })).status).toBe(200);
    expect((await app.request("http://localhost:8787/audit", { headers: { ...local, origin: "http://localhost:5173" } })).status).toBe(200);
    expect((await app.request("http://127.0.0.1:8787/events.jsonl", { headers: { host: "127.0.0.1:8787" } })).status).toBe(200);
    expect((await app.request("http://localhost:8787/demo/owner-reply", { method: "POST", headers: { ...local, origin: "http://127.0.0.1:5173" } })).status).toBe(200);
  });

  it("refuse the public tunnel without the token, on every operator path", async () => {
    const app = server();
    for (const [path, method] of [["/events", "GET"], ["/events/stream", "GET"], ["/events.jsonl", "GET"], ["/audit", "GET"], ["/demo/owner-reply", "POST"], ["/demo/kill-call", "POST"]] as const) {
      const res = await app.request(`https://${TUNNEL}${path}`, { method, headers: tunnelled });
      expect(res.status, path).toBe(401);
      expect(await res.text()).not.toMatch(/evt_|transcript|body/);
    }
  });

  it("let the tunnel in with the token, as a bearer or as ?token= for EventSource", async () => {
    const app = server();
    expect((await app.request(`https://${TUNNEL}/events`, { headers: { ...tunnelled, authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await app.request(`https://${TUNNEL}/audit?token=${TOKEN}`, { headers: tunnelled })).status).toBe(200);
    expect((await app.request(`https://${TUNNEL}/demo/owner-reply?token=${TOKEN}`, { method: "POST", headers: tunnelled })).status).toBe(200);
  });

  it("answer a wrong token with 403, and a near miss is still wrong", async () => {
    const app = server();
    expect((await app.request(`https://${TUNNEL}/events?token=nope`, { headers: tunnelled })).status).toBe(403);
    expect((await app.request(`https://${TUNNEL}/events?token=${TOKEN.slice(0, -1)}`, { headers: tunnelled })).status).toBe(403);
  });

  it("stay closed to the tunnel when no DASHBOARD_TOKEN is configured", async () => {
    const app = server({});
    expect((await app.request(`https://${TUNNEL}/events?token=`, { headers: tunnelled })).status).toBe(401);
    expect((await app.request(`https://${TUNNEL}/events`, { headers: { ...tunnelled, authorization: "Bearer " } })).status).toBe(401);
  });

  it("treat a forged localhost Host as remote when the tunnel headers or a LAN peer give it away", async () => {
    const viaTunnel = server();
    expect((await viaTunnel.request("http://localhost:8787/events", { headers: { ...local, "cf-ray": "1-SJC" } })).status).toBe(401);
    const lan = server({ token: TOKEN, peerAddress: () => "192.168.1.23" });
    expect((await lan.request("http://localhost:8787/events", { headers: local })).status).toBe(401);
    const loop = server({ token: TOKEN, peerAddress: () => "::ffff:127.0.0.1" });
    expect((await loop.request("http://localhost:8787/events", { headers: local })).status).toBe(200);
  });

  it("refuse cross-site requests to localhost (CSRF from any page the presenter has open)", async () => {
    const app = server();
    for (const origin of ["https://evil.example", "null", "http://localhost.evil.example"]) {
      const res = await app.request("http://localhost:8787/demo/owner-reply", { method: "POST", headers: { ...local, origin, "content-type": "text/plain" }, body: '{"body":"Y"}' });
      expect(res.status, origin).toBe(401);
    }
    // The deployed dashboard is trusted to drive a server on the presenter's machine.
    const pages = await app.request("http://localhost:8787/demo/owner-reply", { method: "POST", headers: { ...local, origin: "https://tryplatypus.pages.dev" } });
    expect(pages.status).toBe(200);
  });

  it("leave /health, the webhook and preflights to their own checks", async () => {
    const app = server();
    expect((await app.request(`https://${TUNNEL}/health`, { headers: tunnelled })).status).toBe(200);
    expect((await app.request(`https://${TUNNEL}/webhooks/dial`, { method: "POST", headers: tunnelled })).status).toBe(200);
    expect((await app.request(`https://${TUNNEL}/events`, { method: "OPTIONS", headers: { ...tunnelled, origin: "https://x.example", "access-control-request-method": "GET" } })).status).toBeLessThan(400);
  });
});

describe("operatorAccessFromEnv", () => {
  it("refuses a short DASHBOARD_TOKEN and adds DASHBOARD_ORIGINS to the trusted list", () => {
    expect(() => operatorAccessFromEnv({ DASHBOARD_TOKEN: "short" })).toThrow(String(MIN_DASHBOARD_TOKEN_CHARS));
    const options = operatorAccessFromEnv({ DASHBOARD_TOKEN: TOKEN, DASHBOARD_ORIGINS: "https://stage.example/, " });
    expect(options.token).toBe(TOKEN);
    expect(options.trustedOrigins).toEqual(["https://tryplatypus.pages.dev", "https://stage.example"]);
    expect(operatorAccessFromEnv({}).token).toBeUndefined();
  });

  it("knows loopback peers", () => {
    expect(["127.0.0.1", "::1", "::ffff:127.0.0.1"].every(isLoopbackAddress)).toBe(true);
    expect(["10.0.0.2", "::ffff:192.168.1.2", "fe80::1"].some(isLoopbackAddress)).toBe(false);
  });
});
