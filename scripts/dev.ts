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
import { createEventsApp, defaultBus } from "../packages/shared/src/events/index";
import { loadGoldenPath, replayEvents } from "../packages/shared/src/testing/replay";

if (existsSync(".env")) process.loadEnvFile(".env");
const mode = process.env.DEMO_MODE ?? "fakes";
const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.PLATYPUS_DB ?? (mode === "fakes" ? "data/dev-fakes.db" : "data/platypus.db");

// In fakes mode every run starts clean; the append-only log is never edited, the file is replaced.
if (mode === "fakes") for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
const db = openDb(dbPath);

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true, mode }));
app.route("/", createEventsApp({ db, bus: defaultBus }));

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
  const speed = Number(c.req.query("speed") ?? 2);
  if (replaying) return c.json({ started: false, reason: "a replay is already running" }, 409);
  void playGoldenPath(speed);
  return c.json({ started: true, speed }, 202);
});

serve({ fetch: app.fetch, port }, () => console.log(`Platypus events on http://localhost:${port}/events/stream (DEMO_MODE=${mode})`));

if (!process.argv.includes("--no-dashboard")) {
  const vite = spawn("pnpm", ["--filter", "@platypus/dashboard", "dev"], { stdio: "inherit", env: { ...process.env, PLATYPUS_GATEWAY_URL: `http://localhost:${port}` } });
  const stop = () => {
    vite.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (mode === "fakes" && !process.argv.includes("--no-replay")) {
  setTimeout(() => void playGoldenPath(Number(process.env.REPLAY_SPEED ?? 2)), 2_500);
}
