/**
 * `pnpm dev`: the event server on :8787 and the dashboard on :5173.
 * With DEMO_MODE=fakes (the default) it starts from an empty log and replays
 * the golden-path fixture so the whole demo plays on the dashboard with no
 * external service running. POST /demo/replay plays it again.
 */
import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { Hono } from "hono";
import { openDb } from "../packages/shared/src/db/index";
import { allEvents, createEventsApp, defaultBus } from "../packages/shared/src/events/index";
import { auditEventLog, formatAuditReport } from "../packages/shared/src/audit/index";
import { guardOperatorRoutes, operatorAccessFromEnv } from "../packages/shared/src/http/operator-access";
import { loadGoldenPath, replayEvents } from "../packages/shared/src/testing/replay";
import type { AgentSide, PhoneSide } from "../packages/shared/src/contracts/seams";
import * as gatewayPackage from "../packages/gateway/src/index";
import * as voicePackage from "../packages/voice/src/index";

if (existsSync(".env")) process.loadEnvFile(".env");
const mode = process.env.DEMO_MODE ?? "fakes";
const port = Number(process.env.PORT ?? 8787);
// Loopback only: cloudflared reaches us on 127.0.0.1, and nobody on the venue Wi-Fi can.
const hostname = process.env.HOST ?? "127.0.0.1";
const dbPath = process.env.PLATYPUS_DB ?? (mode === "fakes" ? "data/dev-fakes.db" : "data/platypus.db");

// In fakes mode every run starts clean; the append-only log is never edited, the file is replaced.
if (mode === "fakes") for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
const db = openDb(dbPath);

const app = new Hono();
// The event log, /audit and /demo/* are for the team: this machine, or DASHBOARD_TOKEN through the tunnel.
// Installed before any route so it runs first (see packages/shared/src/http/operator-access.ts).
guardOperatorRoutes(app, operatorAccessFromEnv(process.env));
app.get("/health", (c) => c.json({ ok: true, mode }));
app.route("/", createEventsApp({ db, bus: defaultBus }));

// Replays the whole log against the non-negotiables. 200 when clean, 409 with the violations.
app.get("/audit", (c) => {
  const result = auditEventLog([...allEvents(db)]);
  return c.req.query("format") === "text"
    ? c.text(formatAuditReport(result, { source: "live" }), result.ok ? 200 : 409)
    : c.json(result, result.ok ? 200 : 409);
});

// Both sides plug in here through the exports in contracts/seams.ts, so neither edits this file.
// Everything runs in this one process: one database, one event bus, one live stream.
const deps = { db, bus: defaultBus };
const phone = voicePackage as unknown as Partial<PhoneSide>;
const agent = gatewayPackage as unknown as Partial<AgentSide>;
phone.mount?.(app, deps);
const owner = process.env.DIAL_IMPL === "real" ? phone.createOwnerChannels?.(deps) : undefined;
agent.mount?.(app, owner ? { ...deps, owner } : deps);

let replaying = false;
async function playGoldenPath(speed: number) {
  if (replaying) return false;
  replaying = true;
  try {
    await replayEvents(loadGoldenPath(), { db, bus: defaultBus, speed });
  } finally {
    replaying = false;
  }
  return true;
}
app.post("/demo/replay", async (c) => {
  if (mode !== "fakes") return c.json({ error: "Replay is only available with DEMO_MODE=fakes" }, 409);
  const asked = Number(c.req.query("speed") ?? 2);
  const speed = Number.isFinite(asked) ? Math.min(50, Math.max(0.25, asked)) : 2;
  if (replaying) return c.json({ started: false, reason: "a replay is already running" }, 409);
  void playGoldenPath(speed);
  return c.json({ started: true, speed }, 202);
});

serve({ fetch: app.fetch, port, hostname }, () => console.log(`Platypus events on http://localhost:${port}/events/stream (DEMO_MODE=${mode})`));

if (!process.argv.includes("--no-dashboard")) {
  const vite = spawn("pnpm", ["--filter", "@platypus/dashboard", "dev"], { stdio: "inherit", env: { ...process.env, PLATYPUS_GATEWAY_URL: `http://127.0.0.1:${port}` } });
  const stop = () => {
    vite.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// The recorded fixture plays only when nothing real is wired in; with DIAL_IMPL=real the live
// phone side produces the events itself, and mixing the two would confuse the dashboard.
if (mode === "fakes" && process.env.DIAL_IMPL !== "real" && !process.argv.includes("--no-replay")) {
  setTimeout(() => void playGoldenPath(Number(process.env.REPLAY_SPEED ?? 2)), 2_500);
}
