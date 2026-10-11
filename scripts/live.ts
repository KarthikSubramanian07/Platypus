/**
 * `pnpm live`: one command from a laptop to a phone that can ring.
 *   1. Opens a cloudflared quick tunnel to :8787 (a new hostname every run).
 *   2. Replaces our Dial webhook with one pointing at the tunnel, and reads its signing secret.
 *   3. Starts `pnpm dev` with DEMO_MODE=live and DIAL_IMPL=real, so the gateway reaches owners
 *      through the real phone side.
 *   4. Registers the Context MCP with Dial (delete then create) and checks it lists five tools.
 * It places no call and sends no message: that only happens when an agent asks for a booking,
 * and only to ALLOWED_NUMBERS. Ctrl-C stops the server and the tunnel.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { runRegisterCli } from "../packages/voice/src/context-mcp/dial-registry";
import { startQuickTunnel, waitForPublicHealth } from "./tunnel";

if (existsSync(".env")) process.loadEnvFile(".env");
const DIAL = "https://api.getdial.ai/api/v1";
const port = Number(process.env.PORT ?? 8787);
const apiKey = process.env.DIAL_API_KEY?.trim();

const missing = ["DIAL_API_KEY", "DIAL_FROM_NUMBER_ID", "ALLOWED_NUMBERS", "CONTEXT_MCP_SECRET", "CONTEXT_MCP_TOKEN"].filter((k) => !process.env[k]?.trim());
if (missing.length) {
  console.error(`pnpm live needs ${missing.join(", ")} in .env. Run pnpm run doctor for details.`);
  process.exit(2);
}

async function dial<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${DIAL}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok && res.status !== 404) throw new Error(`Dial ${method} ${path} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (res.status === 204 || res.status === 404 ? {} : await res.json()) as T;
}

/** Deletes our earlier quick-tunnel webhooks, then subscribes the new URL to every event type. */
async function replaceWebhook(publicUrl: string): Promise<string> {
  const { webhooks = [] } = await dial<{ webhooks?: { id: string; targetUrl: string }[] }>("GET", "/webhooks");
  for (const w of webhooks.filter((w) => w.targetUrl.includes(".trycloudflare.com/webhooks/dial"))) await dial("DELETE", `/webhooks/${w.id}`);
  const { webhook } = await dial<{ webhook: { id: string } }>("POST", "/webhooks", { targetUrl: `${publicUrl}/webhooks/dial`, eventTypes: ["*"] });
  const { secret } = await dial<{ secret: string }>("GET", `/webhooks/${webhook.id}/secret`);
  console.log(`  webhook ${webhook.id} -> ${publicUrl}/webhooks/dial`);
  return secret;
}

console.log("1/4 Opening a tunnel");
const tunnel = await startQuickTunnel(port, 20299, { waitForHealth: false });
console.log(`  ${tunnel.url}`);

console.log("2/4 Pointing Dial's webhook at it");
const webhookSecret = await replaceWebhook(tunnel.url);

console.log("3/4 Starting the server with real Dial");
const env = { ...process.env, DEMO_MODE: "live", DIAL_IMPL: "real", GATEWAY_IMPL: "real", PUBLIC_BASE_URL: tunnel.url, DIAL_WEBHOOK_SECRET: webhookSecret };
const server = spawn("pnpm", ["dev", ...process.argv.slice(2)], { env, stdio: "inherit" });
const stop = () => {
  server.kill("SIGTERM");
  tunnel.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await waitForPublicHealth(tunnel.url);

console.log("4/4 Registering the Context MCP with Dial");
const code = await runRegisterCli([], { env, fetch: (url, init) => fetch(url, init), out: (line) => console.log(`  ${line}`) });
if (code !== 0) console.error("  Context MCP registration failed; calls will fall back to the transcript path. See the lines above.");
console.log(`\nLive. Dashboard: http://localhost:5173/live   Gateway MCP: http://localhost:${port}/mcp   Kill switch: POST /demo/kill-call\n`);
