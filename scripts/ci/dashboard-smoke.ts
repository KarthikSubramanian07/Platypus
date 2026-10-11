/**
 * `pnpm ci:smoke`: loads the built dashboard in headless Chromium and checks that it works
 * the way a visitor sees it on https://tryplatypus.pages.dev.
 *
 *   - serves packages/dashboard/dist with `vite preview` (build it first);
 *   - opens `/` (and `/live` when the build has such a page) at desktop and phone widths;
 *   - fails on any console error, uncaught exception or failed same-origin request;
 *   - waits for the recorded golden path to render events into the log;
 *   - saves full-page screenshots to artifacts/screenshots for the CI artifact.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const PORT = Number(process.env.SMOKE_PORT ?? 4173);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DIST = "packages/dashboard/dist";
const SHOTS = "artifacts/screenshots";
const MIN_EVENTS = 3;

/** Each page, where its event list lives, and what to scroll into view to start the recorded replay. */
interface Route {
  path: string;
  events: string;
  scrollTo?: string;
}

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

if (!existsSync(join(DIST, "index.html"))) {
  console.error(`${DIST}/index.html is missing; run \`pnpm --filter @platypus/dashboard build\` first.`);
  process.exit(1);
}
mkdirSync(SHOTS, { recursive: true });

const routes: Route[] = [{ path: "/", events: "#events > li", scrollTo: "#log" }];
if (existsSync(join(DIST, "live", "index.html")) || existsSync(join(DIST, "live.html"))) routes.push({ path: "/live", events: "#stream > li" });

async function startPreview(): Promise<ChildProcess> {
  const server = spawn("pnpm", ["--filter", "@platypus/dashboard", "exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(ORIGIN)).ok) return server;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  server.kill();
  throw new Error(`vite preview did not answer on ${ORIGIN} within 30s`);
}

interface Result {
  route: string;
  viewport: string;
  events: number;
  problems: string[];
  screenshot: string;
}

async function check(page: Page, { path: route, events: selector, scrollTo }: Route, viewport: string): Promise<Result> {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`uncaught: ${err.message}`));
  page.on("requestfailed", (req) => {
    if (req.url().startsWith(ORIGIN)) problems.push(`request failed: ${req.url()} (${req.failure()?.errorText ?? "unknown"})`);
  });
  page.on("response", (res) => {
    if (res.url().startsWith(ORIGIN) && res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });

  const response = await page.goto(`${ORIGIN}${route}`, { waitUntil: "networkidle" });
  if (!response?.ok()) problems.push(`GET ${route} returned ${response?.status()}`);
  if (!(await page.title()).includes("Platypus")) problems.push(`unexpected title "${await page.title()}"`);

  // The static build replays the recorded golden path (on the landing page, once the log scrolls into view).
  if (scrollTo) await page.locator(scrollTo).scrollIntoViewIfNeeded();
  try {
    await page.waitForFunction(([sel, min]) => document.querySelectorAll(sel as string).length >= (min as number), [selector, MIN_EVENTS] as const, { timeout: 30_000 });
  } catch {
    problems.push(`fewer than ${MIN_EVENTS} events rendered within 30s`);
  }
  const events = await page.locator(selector).count();

  const screenshot = join(SHOTS, `${route === "/" ? "home" : route.slice(1).replace(/\//g, "-")}-${viewport}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  return { route, viewport, events, problems, screenshot };
}

const server = await startPreview();
const browser = await chromium.launch();
const results: Result[] = [];
try {
  for (const route of routes) {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: "reduce" });
      results.push(await check(await context.newPage(), route, vp.name));
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => r.problems.length);
const markdown = [
  "### Dashboard smoke (Chromium)",
  "",
  "| Route | Viewport | Events rendered | Result |",
  "|---|---|---:|---|",
  ...results.map((r) => `| \`${r.route}\` | ${r.viewport} | ${r.events} | ${r.problems.length ? `❌ ${r.problems.join("; ").replace(/\|/g, "\\|")}` : "✅"} |`),
  "",
  `Screenshots are in the \`dashboard-screenshots\` artifact.`,
].join("\n");
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`);
if (failed.length) process.exitCode = 1;
