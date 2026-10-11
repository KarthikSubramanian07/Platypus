/**
 * `pnpm ci:coverage-summary`: turns coverage/coverage-summary.json (Vitest's
 * json-summary reporter) into one row per package, prints it, and appends it to
 * the GitHub job summary when $GITHUB_STEP_SUMMARY is set.
 *
 * The thresholds that fail the build live in vitest.config.ts; this script only reports.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

type Metric = "lines" | "statements" | "functions" | "branches";
const METRICS: Metric[] = ["lines", "statements", "functions", "branches"];
type Counts = Record<Metric, { total: number; covered: number }>;
type Summary = Record<string, Record<Metric, { total: number; covered: number; pct: number }>>;

const file = resolve(process.argv[2] ?? "coverage/coverage-summary.json");
const summary = JSON.parse(readFileSync(file, "utf8")) as Summary;
const root = process.cwd();

const empty = (): Counts => ({
  lines: { total: 0, covered: 0 },
  statements: { total: 0, covered: 0 },
  functions: { total: 0, covered: 0 },
  branches: { total: 0, covered: 0 },
});

const byPackage = new Map<string, Counts>();
const total = empty();
for (const [path, metrics] of Object.entries(summary)) {
  if (path === "total") continue;
  const pkg = /^packages\/([^/]+)\//.exec(relative(root, path))?.[1] ?? "other";
  const counts = byPackage.get(pkg) ?? empty();
  for (const m of METRICS) {
    counts[m].total += metrics[m].total;
    counts[m].covered += metrics[m].covered;
    total[m].total += metrics[m].total;
    total[m].covered += metrics[m].covered;
  }
  byPackage.set(pkg, counts);
}

const pct = (c: { total: number; covered: number }) => (c.total === 0 ? "n/a" : `${((c.covered / c.total) * 100).toFixed(2)}%`);
const row = (name: string, c: Counts) => `| ${name} | ${METRICS.map((m) => pct(c[m])).join(" | ")} |`;

const table = [
  "| Package | Lines | Statements | Functions | Branches |",
  "|---|---:|---:|---:|---:|",
  ...[...byPackage.keys()].sort().map((name) => row(`\`@platypus/${name}\``, byPackage.get(name)!)),
  row("**Total**", total),
].join("\n");

const node = process.versions.node.split(".")[0];
const markdown = `### Coverage (Node ${node})\n\n${table}\n\nThresholds per package are enforced in \`vitest.config.ts\`.\n`;
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
