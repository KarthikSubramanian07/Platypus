/* global document */
// Renders the README visuals into docs/: the two diagrams in diagrams.html and
// screenshots of the site, framed so nothing is clipped. Run with `node scripts/readme/shoot.mjs`.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

// Point SITE_URL at `vite preview` (http://localhost:4173) to shoot an unreleased build.
const SITE = process.env.SITE_URL ?? "https://tryplatypus.pages.dev";
const docs = (name) => fileURLToPath(new URL(`../../docs/${name}`, import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage({ bypassCSP: true, reducedMotion: "reduce", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

// Diagrams
await page.goto(new URL("./diagrams.html", import.meta.url).href);
await page.evaluate(() => document.fonts.ready);
for (const id of ["loop", "arch"]) {
  await page.locator(`#${id}`).screenshot({ path: docs(`readme-${id}.png`) });
}

// The landing page, above the fold.
await page.goto(`${SITE}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const hero = await page.locator("header.hero").boundingBox();
await page.screenshot({ path: docs("site-hero.png"), clip: { x: 0, y: 0, width: 1440, height: Math.ceil(hero.y + hero.height) }, fullPage: true });

// The operator view, after the recorded run has played to the end.
await page.goto(`${SITE}/live`, { waitUntil: "networkidle" });
await page.locator("#replay-final").waitFor({ state: "visible", timeout: 120_000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: docs("live-dashboard.png") });

await browser.close();
