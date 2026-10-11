/**
 * `pnpm ci:bundle-budget`: fails when the dashboard ships more than 120 KB of gzipped JavaScript.
 * Run after `pnpm --filter @platypus/dashboard build`. Prints a per-asset table (and writes it to
 * the GitHub job summary) so a regression is easy to trace to one chunk.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const DIST = process.argv[2] ?? "packages/dashboard/dist";
export const JS_GZIP_BUDGET_BYTES = 120 * 1024;

if (!existsSync(DIST)) {
  console.error(`${DIST} does not exist; build the dashboard first.`);
  process.exit(1);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const assets = walk(DIST)
  .filter((p) => [".js", ".css", ".html"].includes(extname(p)))
  .map((path) => {
    const raw = readFileSync(path);
    return { path: relative(DIST, path), ext: extname(path), raw: raw.length, gzip: gzipSync(raw, { level: 9 }).length };
  })
  .sort((a, b) => b.gzip - a.gzip);

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const jsGzip = assets.filter((a) => a.ext === ".js").reduce((sum, a) => sum + a.gzip, 0);
const ok = jsGzip <= JS_GZIP_BUDGET_BYTES;

const markdown = [
  "### Dashboard bundle",
  "",
  `JavaScript, gzipped: **${kb(jsGzip)}** of a ${kb(JS_GZIP_BUDGET_BYTES)} budget ${ok ? "(within budget)" : "(OVER BUDGET)"}.`,
  "",
  "| Asset | Raw | Gzip |",
  "|---|---:|---:|",
  ...assets.map((a) => `| \`${a.path}\` | ${kb(a.raw)} | ${kb(a.gzip)} |`),
].join("\n");

console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`);
if (!ok) {
  console.log(`::error title=Bundle budget::Dashboard JS is ${kb(jsGzip)} gzipped, over the ${kb(JS_GZIP_BUDGET_BYTES)} budget`);
  process.exitCode = 1;
}
